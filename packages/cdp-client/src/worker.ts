// Workerd-native CDP client. Speaks raw Chrome DevTools Protocol
// over a WebSocket (via globalThis.WebSocket), so it runs in a Cloudflare
// Worker / Durable Object isolate AND in panels. Exposes a Playwright-shaped
// `Page`/`Locator` surface implemented entirely over the Runtime/DOM/Input/Page
// CDP domains — no Node deps, no vendored browser bundle.
//
// Deliberately out of scope (no CDP-only path in a connectionless isolate):
// file uploads (setInputFiles), multi-page/popup lifecycle, cross-origin
// frames, and full network request interception (route). Raw `CdpConnection`
// is always available for protocol-level work those cases would need.

import { webSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";
import { runCdpProfile } from "./profile";
import type { CdpProfileOptions, CdpProfileReport } from "./profile";

export type {
  CdpProfileCoverage,
  CdpProfileCoverageScript,
  CdpProfileNetworkMetrics,
  CdpProfileNetworkRequest,
  CdpProfileOptions,
  CdpProfilePageMetrics,
  CdpProfileReport,
  CdpProfileRuntimeMetrics,
} from "./profile";

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type CdpCommandOptions = {
  timeoutMs?: number;
  timeoutBehavior?: "disconnect" | "reject";
  timeoutError?: (timeoutMs: number) => Error;
};

type CdpEvent = {
  method: string;
  params?: unknown;
};

export type CdpConsoleEvent = {
  type: string;
  text: string;
  args: unknown[];
};

export type CdpDomInspection = {
  selector: string;
  found: boolean;
  tagName?: string;
  id?: string;
  className?: string;
  text?: string;
  role?: string;
  accessibleName?: string;
  visible?: boolean;
  attributes?: Record<string, string>;
  boundingBox?: { x: number; y: number; width: number; height: number };
  /** Nearest rendered ancestors first, for disambiguating repeated controls. */
  ancestors?: Array<{
    tagName: string;
    role: string;
    accessibleName: string;
    text: string;
  }>;
};

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type CdpViewportSize = { width: number; height: number };
export type CdpScreenshotOptions = {
  type?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
};

/** How a locator finds its element(s). Chains resolve left-to-right. */
type TextMatcher = string | RegExp;
type SerializedTextMatcher = string | { regex: { source: string; flags: string } };

type LocatorStep =
  | { by: "css"; value: string }
  | { by: "role"; value: string; name?: SerializedTextMatcher; exact?: boolean }
  | { by: "text"; value: SerializedTextMatcher; exact?: boolean }
  | { by: "label"; value: SerializedTextMatcher; exact?: boolean }
  | { by: "placeholder"; value: SerializedTextMatcher; exact?: boolean }
  | { by: "testid"; value: string }
  | { by: "alt"; value: SerializedTextMatcher; exact?: boolean }
  | { by: "title"; value: SerializedTextMatcher; exact?: boolean }
  | { filter: { hasText?: SerializedTextMatcher; hasTextExact?: boolean } }
  | { nth: number };

type LocatorDescriptor = { steps: LocatorStep[] };

type ByTextOptions = { exact?: boolean };
type ByRoleOptions = { name?: TextMatcher; exact?: boolean };
type ActionOptions = { timeout?: number };
type SelectOptionMatcher = {
  value?: string;
  label?: string;
  index?: number;
};
type SelectOptionInput = string | SelectOptionMatcher;
type WaitState = "attached" | "detached" | "visible" | "hidden";
type ClickOptions = ActionOptions & {
  /** Optional semantic postcondition observed after the pointer event is delivered. */
  expect?: {
    locator: WorkerCdpLocator;
    state?: WaitState;
    timeout?: number;
  };
};

export interface CdpInteractionOutcome {
  protocol: "cdp-interaction-outcome.v1";
  action: "click" | "dblclick";
  delivery: "dispatched";
  target: CdpDomInspection;
  effect:
    | { status: "not-asserted" }
    | {
        status: "observed";
        locator: string;
        state: WaitState;
      };
}
type Keyboard = {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  press(key: string): Promise<void>;
  type(text: string): Promise<void>;
  insertText(text: string): Promise<void>;
};

/**
 * Compile the public locator selector dialect into the one descriptor model
 * used by every locator engine. CSS is the default; Playwright's common
 * `text=<JSON string>` form is semantic text matching, not a string forwarded
 * to querySelectorAll.
 */
function compileLocatorSelector(selector: string): LocatorStep {
  if (!selector.startsWith("text=")) return { by: "css", value: selector };

  const source = selector.slice("text=".length).trim();
  if (!source.startsWith('"')) {
    return { by: "text", value: source, exact: false };
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    const error = new TypeError(
      `Invalid text locator ${JSON.stringify(
        selector
      )}: quoted text must be a valid JSON string, for example locator('text="Save changes"').`
    );
    (error as Error & { cause?: unknown }).cause = cause;
    throw error;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `Invalid text locator ${JSON.stringify(
        selector
      )}: text= must be followed by text or a quoted JSON string.`
    );
  }
  return { by: "text", value, exact: true };
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocket;

type WorkerClientWebSocket = WebSocket & { accept?: () => void };

const CDP_WEBSOCKET_OPEN_TIMEOUT_MS = 15_000;
// A browser-side evaluate/locator operation has its own action timeout, but a
// broken relay/provider must not leave the EvalDO waiting forever. Once this
// deadline fires the connection is no longer trustworthy: close it so the
// bridge detaches the relay session and the caller can acquire a fresh page.
const CDP_COMMAND_TIMEOUT_MS = 60_000;

function runsInFetchUpgradeWorker(): boolean {
  // workerd exposes both WebSocket and WebSocketPair. The former is the
  // server-side WebSocket surface and does not reliably route an outbound
  // connection through Vibestudio's egress boundary. Fetch upgrades carry the
  // internal grant through the boundary explicitly, so prefer that transport
  // whenever the worker runtime is identifiable.
  return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function";
}

async function openWebSocket(
  wsEndpoint: string,
  authToken?: string,
  preferFetchUpgrade = false
): Promise<{ socket: WorkerClientWebSocket; waitForOpen: boolean }> {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (ctor && !preferFetchUpgrade && !runsInFetchUpgradeWorker()) {
    return {
      socket: new ctor(
        wsEndpoint,
        authToken ? [webSocketAuthProtocol("inspection", authToken)] : undefined
      ),
      waitForOpen: true,
    };
  }

  if (typeof fetch !== "function") {
    throw new Error(
      "CDP WebSocket transport is unavailable: this runtime exposes neither WebSocket nor fetch"
    );
  }

  const upgradeUrl = new URL(wsEndpoint);
  if (upgradeUrl.protocol === "ws:") upgradeUrl.protocol = "http:";
  else if (upgradeUrl.protocol === "wss:") upgradeUrl.protocol = "https:";
  else {
    throw new Error(`CDP endpoint must use ws: or wss:, received ${upgradeUrl.protocol}`);
  }
  if (authToken) {
    const headerPairs = JSON.stringify([["x-vibestudio-cdp-grant", authToken]]);
    const encoded = btoa(headerPairs).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    // Workerd's outbound WebSocket proxy cannot carry arbitrary upgrade
    // headers directly. This transport metadata is decoded by the egress
    // boundary, verified there, and removed before the upstream handshake.
    upgradeUrl.searchParams.set("__vibestudio_ws_headers", encoded);
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const responsePromise = fetch(upgradeUrl, {
    headers: { Upgrade: "websocket" },
    signal: controller.signal,
  }) as Promise<Response & { webSocket?: WorkerClientWebSocket | null }>;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(
          new Error(`CDP WebSocket upgrade timed out after ${CDP_WEBSOCKET_OPEN_TIMEOUT_MS}ms`)
        );
      }, CDP_WEBSOCKET_OPEN_TIMEOUT_MS);
    });
    const response = await Promise.race([responsePromise, deadline]);
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(
        `CDP WebSocket upgrade failed with HTTP ${response.status}: response contained no WebSocket`
      );
    }
    socket.accept?.();
    return { socket, waitForOpen: false };
  } finally {
    if (timeout) clearTimeout(timeout);
    // Some Worker fetch implementations do not reject promptly when an
    // Upgrade request is aborted. Keep that eventual rejection handled after
    // the bounded race has already released the caller.
    void responsePromise.catch(() => undefined);
  }
}

function once(
  ws: WebSocket,
  event: "open" | "message" | "error" | "close"
): Promise<Event | MessageEvent> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      ws.removeEventListener(event, handle);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
    };
    const handle = (ev: Event | MessageEvent) => {
      cleanup();
      resolve(ev);
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`CDP WebSocket ${event} failed`));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error(`CDP WebSocket closed before ${event}`));
    };
    if (event === "open") {
      timeout = setTimeout(() => {
        cleanup();
        try {
          ws.close();
        } catch {
          // The socket may already have failed while the timeout fired.
        }
        reject(new Error(`CDP WebSocket open timed out after ${CDP_WEBSOCKET_OPEN_TIMEOUT_MS}ms`));
      }, CDP_WEBSOCKET_OPEN_TIMEOUT_MS);
    }
    ws.addEventListener(event, handle);
    if (event !== "error") ws.addEventListener("error", handleError);
    if (event !== "close") ws.addEventListener("close", handleClose);
  });
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data && typeof (data as Blob).text === "function") {
    return (data as Blob).text();
  }
  return String(data);
}

function decodeBase64(data: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const bufferCtor = (globalThis as { Buffer?: { from(data: string, enc: string): Uint8Array } })
    .Buffer;
  if (bufferCtor) return bufferCtor.from(data, "base64");
  throw new Error("No base64 decoder is available in this runtime");
}

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;
  private closeError: Error | null = null;

  private constructor(
    private readonly ws: WebSocket,
    private readonly commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS
  ) {
    ws.addEventListener("message", (event) => {
      void this.handleMessage((event as MessageEvent).data);
    });
    ws.addEventListener("error", () => {
      this.disconnect(
        new CdpError(
          "CDP target connection failed. Inspect the panel diagnostics and acquire a new page if the target still exists.",
          {
            code: "cdp_target_connection_failed",
            operation: "connect",
            failureKind: "infrastructure",
            recovery: "inspect-panel-and-reacquire-page",
          }
        )
      );
    });
    ws.addEventListener("close", () => {
      this.disconnect(
        new CdpError(
          "CDP target connection closed. The panel may have been closed, or its runtime may have been replaced by handle.navigate() or handle.rebuild(). If the panel still exists, obtain a fresh page with await handle.cdp.page(); do not reuse the cached page.",
          {
            code: "cdp_target_closed",
            operation: "connection",
            failureKind: "infrastructure",
            recovery: "reacquire-page",
          }
        )
      );
    });
  }

  static async connect(
    wsEndpoint: string,
    authToken?: string,
    preferFetchUpgrade = false,
    options: { commandTimeoutMs?: number } = {}
  ): Promise<CdpConnection> {
    const { socket: ws, waitForOpen } = await openWebSocket(
      wsEndpoint,
      authToken,
      preferFetchUpgrade
    );
    if (waitForOpen) await once(ws, "open");
    return new CdpConnection(ws, options.commandTimeoutMs ?? CDP_COMMAND_TIMEOUT_MS);
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    options: CdpCommandOptions = {}
  ): Promise<unknown> {
    if (this.closed) {
      const reason =
        this.closeError?.message ??
        "CDP connection is closed. Obtain a fresh page before sending more commands.";
      return Promise.reject(
        new CdpError(`Cannot send ${method}: ${reason}`, {
          code: "cdp_target_closed",
          operation: method,
          failureKind: "infrastructure",
          recovery: "reacquire-page",
        })
      );
    }
    const id = this.nextId++;
    const message = params ? { id, method, params } : { id, method };
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
      const timeout = setTimeout(() => {
        const error =
          options.timeoutError?.(timeoutMs) ??
          new CdpError(
            `CDP command timed out after ${timeoutMs}ms: ${method}. ` +
              "The target connection was closed; acquire a fresh page and inspect panel diagnostics.",
            {
              code: "cdp_command_timeout",
              operation: method,
              failureKind: "infrastructure",
              recovery: "inspect-panel-and-reacquire-page",
            }
          );
        if (options.timeoutBehavior === "reject") {
          this.pending.delete(id);
          reject(error);
          return;
        }
        this.disconnect(error);
        try {
          this.ws.close();
        } catch {
          // The transport may already be closed.
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.disconnect(
      new CdpError(
        "CDP connection closed by the client. Create a new connection before sending more commands.",
        {
          code: "cdp_target_closed",
          operation: "close",
          failureKind: "user-code",
          recovery: "reacquire-page",
        }
      )
    );
    this.ws.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.eventListeners.clear();
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(method);
    };
  }

  private async handleMessage(data: unknown): Promise<void> {
    let parsed: CdpResponse & CdpEvent;
    try {
      parsed = JSON.parse(await messageText(data)) as CdpResponse & CdpEvent;
    } catch (err) {
      // A malformed CDP frame must not abort the handler with an unhandled
      // rejection — that would silently stop all further dispatch. Drop the bad
      // frame and keep the connection processing.
      console.error("[cdp-client] failed to parse CDP frame:", err);
      return;
    }
    if (typeof parsed.id !== "number") {
      if (parsed.method) {
        for (const listener of this.eventListeners.get(parsed.method) ?? []) {
          listener(parsed.params);
        }
      }
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    clearTimeout(pending.timeout);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? parsed.error.data ?? "CDP command failed"));
      return;
    }
    pending.resolve(parsed.result);
  }
}

// ---------------------------------------------------------------------------
// In-page runtime. A single self-contained program injected into the target
// page via Runtime.evaluate. It owns element resolution (CSS + getBy* engines),
// atomic visibility/state probes, and all DOM-side actions/reads. The client
// repeats failed state probes between evaluations so the renderer remains free
// to process queued input and UI work while a locator is waiting. Pointer
// actions (click/hover/...) only observe one candidate hit point here; the
// client compares observations for stability and dispatches mouse/key events
// via CDP Input.
//
// Kept as one literal string (no ${} interpolation) so it is the single source
// of truth and is trivially serialisable. `__nsRun(payload)` is the entrypoint.
// ---------------------------------------------------------------------------
const INPAGE = String.raw`
function nsNorm(s){ return (s==null?"":String(s)).replace(/\s+/g," ").trim(); }
function nsDedupe(a){ return a.filter(function(e,i){ return a.indexOf(e)===i; }); }
function nsRetainedElements(){ var key=Symbol.for("@workspace/cdp-client/retained-elements"); var registry=globalThis[key]; if(!(registry instanceof Map)){ registry=new Map(); globalThis[key]=registry; } return registry; }
function nsRetainedElement(token){ var e=nsRetainedElements().get(token); if(!e) throw new Error("Retained element lease is no longer available"); return e; }
function nsText(el){ return nsNorm((el && (el.innerText!=null?el.innerText:el.textContent)) || ""); }
function nsValueMatch(value, q, exact){ var t=nsNorm(value); if(q&&typeof q==="object"&&q.regex){ return new RegExp(q.regex.source,q.regex.flags).test(t); } var n=nsNorm(q); return exact ? t===n : t.toLowerCase().indexOf(n.toLowerCase())!==-1; }
function nsTextMatch(el, q, exact){ return nsValueMatch(nsText(el),q,exact); }
function nsHasTextMatchingDescendant(el,q,exact){ var all=el&&el.querySelectorAll?el.querySelectorAll("*"):[]; for(var i=0;i<all.length;i++){ if(nsTextMatch(all[i],q,exact)) return true; } return false; }
function nsAttr(el, name){ return el && el.getAttribute ? el.getAttribute(name) : null; }
function nsSetNativeProperty(el,name,value){ var proto=Object.getPrototypeOf(el); var descriptor=proto&&Object.getOwnPropertyDescriptor(proto,name); if(descriptor&&descriptor.set) descriptor.set.call(el,value); else el[name]=value; }
function nsDispatchInput(el,value){ var event; try { event=new InputEvent("input",{bubbles:true,inputType:"insertText",data:value==null?null:String(value)}); } catch(e) { event=new Event("input",{bubbles:true}); } el.dispatchEvent(event); el.dispatchEvent(new Event("change",{bubbles:true})); }
function nsRole(el){
  var r = nsAttr(el,"role"); if(r) return r.trim().toLowerCase().split(/\s+/)[0];
  var tag = el.tagName ? el.tagName.toLowerCase() : "";
  if(tag==="a") return el.hasAttribute("href") ? "link" : "";
  if(tag==="button") return "button";
  if(tag==="select") return el.multiple ? "listbox" : "combobox";
  if(tag==="textarea") return "textbox";
  if(/^h[1-6]$/.test(tag)) return "heading";
  if(tag==="img") return "img";
  if(tag==="nav") return "navigation";
  if(tag==="main") return "main";
  if(tag==="ul"||tag==="ol") return "list";
  if(tag==="li") return "listitem";
  if(tag==="table") return "table";
  if(tag==="form") return "form";
  if(tag==="input"){
    var ty=(nsAttr(el,"type")||"text").toLowerCase();
    var m={checkbox:"checkbox",radio:"radio",button:"button",submit:"button",reset:"button",image:"button",range:"slider",number:"spinbutton",search:"searchbox"};
    return m[ty]||"textbox";
  }
  return "";
}
function nsAccName(el){
  var al=nsAttr(el,"aria-label"); if(al) return nsNorm(al);
  var lb=nsAttr(el,"aria-labelledby");
  if(lb){ var parts=lb.split(/\s+/).map(function(id){ var e=document.getElementById(id); return e?nsText(e):""; }); var j=nsNorm(parts.join(" ")); if(j) return j; }
  if(el.tagName==="IMG"){ var alt=nsAttr(el,"alt"); if(alt) return nsNorm(alt); }
  if(el.labels && el.labels.length) return nsNorm(Array.prototype.map.call(el.labels,function(l){return nsText(l);}).join(" "));
  var t=nsText(el); if(t) return t;
  var ph=nsAttr(el,"placeholder"); if(ph) return nsNorm(ph);
  var ti=nsAttr(el,"title"); if(ti) return nsNorm(ti);
  return "";
}
function nsLabelText(label){
  var clone=label.cloneNode(true);
  var controls=clone.querySelectorAll?clone.querySelectorAll("input,textarea,select,button,meter,output,progress"):[];
  for(var i=0;i<controls.length;i++) controls[i].remove();
  return nsText(clone);
}
function nsAssociatedLabelMatches(el,q,exact){
  if(!el.labels) return false;
  for(var i=0;i<el.labels.length;i++) if(nsValueMatch(nsLabelText(el.labels[i]),q,exact)) return true;
  return false;
}
function nsVisible(el){
  if(!el||!el.getBoundingClientRect) return false;
  var s=getComputedStyle(el); var r=el.getBoundingClientRect();
  return s.visibility!=="hidden" && s.display!=="none" && Number(s.opacity||"1")>0 && r.width>0 && r.height>0;
}
function nsEnabled(el){ return !el.disabled && nsAttr(el,"aria-disabled")!=="true"; }
function nsCheckedState(el){ if("checked" in el) return !!el.checked; var aria=nsAttr(el,"aria-checked"); if(aria==="true"||aria==="false") return aria==="true"; var data=nsAttr(el,"data-state"); if(data==="checked"||data==="on") return true; if(data==="unchecked"||data==="off") return false; throw new Error("Element is not checkable"); }
function nsEditable(el){
  if(el.isContentEditable) return true;
  var tag=el.tagName ? el.tagName.toLowerCase() : "";
  if(tag!=="input" && tag!=="textarea" && tag!=="select") return false;
  return !el.disabled && !el.readOnly;
}
function nsSelectOptionMatch(option, matcher, index){
  if(typeof matcher === "string") return option.value===matcher || option.label===matcher || nsNorm(option.textContent)===matcher;
  if(matcher.value!==undefined && option.value===matcher.value) return true;
  if(matcher.label!==undefined && option.label===matcher.label) return true;
  return matcher.index!==undefined && index===matcher.index;
}
function nsStepFind(roots, step){
  var out=[];
  if(step.by==="css"){
    for(var i=0;i<roots.length;i++){ var found=(roots[i]===document?document:roots[i]).querySelectorAll(step.value); for(var j=0;j<found.length;j++) out.push(found[j]); }
    return nsDedupe(out);
  }
  var pred=function(e){
    switch(step.by){
      case "role": { if(nsRole(e)!==String(step.value).toLowerCase()) return false; if(step.name!=null) return nsValueMatch(nsAccName(e),step.name,step.exact); return true; }
      case "text": return nsTextMatch(e, step.value, step.exact);
      case "label": { var tag=e.tagName?e.tagName.toLowerCase():""; var formish=(tag==="input"||tag==="textarea"||tag==="select"||tag==="button")||e.isContentEditable; return formish && nsValueMatch(nsAccName(e),step.value,step.exact); }
      case "placeholder": { var ph=nsAttr(e,"placeholder"); return ph!=null && nsValueMatch(ph,step.value,step.exact); }
      case "testid": return nsAttr(e,"data-testid")===step.value;
      case "alt": { var a=nsAttr(e,"alt"); return a!=null && nsValueMatch(a,step.value,step.exact); }
      case "title": { var ti=nsAttr(e,"title"); return ti!=null && nsValueMatch(ti,step.value,step.exact); }
      default: return false;
    }
  };
  for(var k=0;k<roots.length;k++){
    var scope=roots[k]===document?document:roots[k];
    var all=scope.querySelectorAll("*");
    for(var m=0;m<all.length;m++){ if(pred(all[m])) out.push(all[m]); }
  }
  if(step.by==="label"){
    var associated=[]; var fallback=[];
    for(var li=0;li<out.length;li++){
      var candidate=out[li];
      if(nsAssociatedLabelMatches(candidate,step.value,step.exact)) associated.push(candidate);
      else fallback.push(candidate);
    }
    out=associated.concat(fallback);
  }
  var unique=nsDedupe(out);
  return step.by==="text" ? unique.filter(function(e){ return !nsHasTextMatchingDescendant(e,step.value,step.exact); }) : unique;
}
function nsLocate(descriptor){
  var cur=[document];
  var steps=descriptor.steps||[];
  for(var i=0;i<steps.length;i++){
    var step=steps[i];
    if(step.filter){ cur=cur.filter(function(e){ return e!==document && (step.filter.hasText==null || nsTextMatch(e, step.filter.hasText, step.filter.hasTextExact)); }); continue; }
    if(step.nth!=null){ var idx=step.nth<0?cur.length+step.nth:step.nth; cur=(idx>=0&&idx<cur.length)?[cur[idx]]:[]; continue; }
    cur=nsStepFind(cur, step);
  }
  return cur;
}
function nsFirst(descriptor){ var e=nsLocate(descriptor); return e.length?e[0]:null; }
function nsFirstVisible(descriptor){ var e=nsLocate(descriptor); for(var i=0;i<e.length;i++){ if(nsVisible(e[i])) return e[i]; } return null; }
function nsBox(el){ var r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }
function nsSleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function nsAfterAction(){ return nsSleep(0); }
async function nsWaitForState(descriptor, state, timeout){
  var el=state==="visible"?nsFirstVisible(descriptor):nsFirst(descriptor);
  var ok;
  if(state==="detached") ok=!el;
  else if(state==="attached") ok=!!el;
  else if(state==="hidden") ok=!el||!nsVisible(el);
  else ok=!!el&&nsVisible(el);
  if(ok) return el;
  var failure=new Error("Timeout "+timeout+"ms waiting for element to be "+state);
  failure.__nsLocatorFailure={__nsLocatorFailure:"state-timeout",state:state,timeout:timeout};
  throw failure;
}
function nsActionable(descriptor, retainToken){
  var matches=nsLocate(descriptor), el=null, visible=null;
  for(var mi=0;mi<matches.length;mi++){ if(nsVisible(matches[mi])){ if(!visible) visible=matches[mi]; if(nsEnabled(matches[mi])){ el=matches[mi]; break; } } }
  if(!el) el=visible;
  if(!el) return {ok:false, reason:"not found"};
  if(!nsVisible(el)) return {ok:false, reason:"not visible"};
  if(!nsEnabled(el)) return {ok:false, reason:"not enabled"};
  try{ el.scrollIntoView({block:"center",inline:"center"}); }catch(e){}
  var b=nsBox(el), x=b.x+b.width/2, y=b.y+b.height/2;
  var hit=document.elementFromPoint(x,y);
  if(!hit || (hit!==el && !el.contains(hit))) return {ok:false, reason:"not receiving pointer events", box:b};
  if(retainToken) nsRetainedElements().set(retainToken,el);
  return {ok:true, x:x, y:y, box:b};
}
async function __nsRun(P){
  var d=P.descriptor, a=P.arg, t=P.timeout;
  try { switch(P.op){
    case "probe": return nsActionable(d, a&&a.retainToken);
    case "waitFor": { await nsWaitForState(d, P.state||"visible", t); return true; }
    case "count": return nsLocate(d).length;
    case "exists": return !!nsFirst(d);
    case "isVisible": { var e=nsFirst(d); return !!e && nsVisible(e); }
    case "checkedState":
    case "isChecked": { var e=nsFirst(d); return !!e && nsCheckedState(e); }
    case "retainedCheckedState": { var e=nsRetainedElement(a.token); if(!e.isConnected) throw new Error("Retained element was detached during the action"); return nsCheckedState(e); }
    case "releaseRetainedElement": return nsRetainedElements().delete(a.token);
    case "isEnabled": { var e=nsFirst(d); return !!e && nsEnabled(e); }
    case "isDisabled": { var e=nsFirst(d); return !!e && !nsEnabled(e); }
    case "isEditable": { var e=nsFirst(d); return !!e && nsEditable(e); }
    case "textContent": { var e=nsFirst(d); return e?e.textContent:null; }
    case "innerText": { var e=await nsWaitForState(d,"attached",t); return e.innerText!=null?e.innerText:(e.textContent||""); }
    case "inputValue": { var e=await nsWaitForState(d,"attached",t); return "value" in e ? e.value : ""; }
    case "getAttribute": { var e=await nsWaitForState(d,"attached",t); return e.getAttribute(a.name); }
    case "boundingBox": { var e=nsFirst(d); return e?nsBox(e):null; }
    case "allTextContents": return nsLocate(d).map(function(e){ return e.textContent||""; });
    case "allInnerTexts": return nsLocate(d).map(function(e){ return e.innerText!=null?e.innerText:(e.textContent||""); });
    case "evaluate": { var e=await nsWaitForState(d,"attached",t); var fn=(0,eval)("("+a.source+")"); return await fn(e,a.arg); }
    case "evaluateAll": { var fn=(0,eval)("("+a.source+")"); return await fn(nsLocate(d),a.arg); }
    case "roleCandidates": {
      var original=d.steps||[]; var roleIndex=-1;
      for(var ri=original.length-1;ri>=0;ri--){ if(original[ri].by==="role"&&original[ri].name!=null){ roleIndex=ri; break; } }
      if(roleIndex<0) return [];
      var steps=original.slice(0,roleIndex+1); var named=steps[roleIndex];
      var relaxed={}; for(var key in named){ if(key!=="name"&&key!=="exact") relaxed[key]=named[key]; }
      steps[roleIndex]=relaxed;
      var sameRole=nsLocate({steps:steps}).filter(nsVisible);
      var seen={}, sameName=Array.prototype.slice.call(document.querySelectorAll("*")).filter(function(e){
        if(!nsVisible(e)||!nsValueMatch(nsAccName(e),named.name,named.exact)) return false;
        var role=nsRole(e), name=nsAccName(e), key=role+"\n"+name;
        if(!role||seen[key]) return false;
        seen[key]=true;
        return true;
      });
      var included={};
      return sameName.concat(sameRole).filter(function(e){
        var key=nsRole(e)+"\n"+nsAccName(e);
        if(included[key]) return false;
        included[key]=true;
        return true;
      }).slice(0,10).map(function(e){ return {role:nsRole(e), accessibleName:nsAccName(e), text:nsText(e).slice(0,160)}; });
    }
    case "inspect": {
      var e=nsFirst(d);
      if(!e) return {found:false};
      var attrs={}; for(var i=0;i<e.attributes.length;i++){ attrs[e.attributes[i].name]=e.attributes[i].value; }
      var ancestors=[]; var parent=e.parentElement;
      while(parent&&ancestors.length<4){
        var parentText=nsText(parent);
        if(parentText){ ancestors.push({tagName:parent.tagName,role:nsRole(parent),accessibleName:nsAccName(parent),text:parentText.slice(0,400)}); }
        parent=parent.parentElement;
      }
      return {found:true, tagName:e.tagName, id:e.id||"", className:typeof e.className==="string"?e.className:"", text:nsText(e).slice(0,4000), role:nsRole(e), accessibleName:nsAccName(e), visible:nsVisible(e), attributes:attrs, boundingBox:nsBox(e), ancestors:ancestors};
    }
    case "fill": { var e=await nsWaitForState(d,"visible",t); if(!("value" in e) && !e.isContentEditable) throw new Error("Element is not fillable"); e.focus&&e.focus(); if(e.isContentEditable) e.textContent=a.value; else nsSetNativeProperty(e,"value",a.value); nsDispatchInput(e,a.value); await nsAfterAction(); return true; }
    case "clear": { var e=await nsWaitForState(d,"visible",t); e.focus&&e.focus(); if(e.isContentEditable) e.textContent=""; else nsSetNativeProperty(e,"value",""); nsDispatchInput(e,""); await nsAfterAction(); return true; }
    case "selectOption": { var e=await nsWaitForState(d,"visible",t); if(!e.tagName || e.tagName.toLowerCase()!=="select") throw new Error("Element is not a select"); var vals=a.values; var picked=[]; for(var i=0;i<e.options.length;i++){ var o=e.options[i]; var hit=vals.some(function(matcher){ return nsSelectOptionMatch(o,matcher,i); }); o.selected=hit; if(hit) picked.push(o.value); } e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); await nsAfterAction(); return picked; }
    case "focus": { var e=await nsWaitForState(d,"visible",t); e.focus&&e.focus(); await nsAfterAction(); return true; }
    case "blur": { var e=await nsWaitForState(d,"attached",t); e.blur&&e.blur(); await nsAfterAction(); return true; }
    case "scrollIntoView": { var e=await nsWaitForState(d,"attached",t); e.scrollIntoView({block:"center",inline:"center"}); await nsAfterAction(); return true; }
    case "selectText": { var e=await nsWaitForState(d,"visible",t); if(e.select) e.select(); else { var r=document.createRange(); r.selectNodeContents(e); var sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); } await nsAfterAction(); return true; }
    case "dispatchEvent": { var e=await nsWaitForState(d,"attached",t); e.dispatchEvent(new Event(a.type,{bubbles:true})); await nsAfterAction(); return true; }
    case "focusForKey": { var e=await nsWaitForState(d,"visible",t); e.focus&&e.focus(); await nsAfterAction(); return true; }
    default: throw new Error("Unknown op: "+P.op);
  }} catch(error) { if(error&&error.__nsLocatorFailure) return error.__nsLocatorFailure; throw error; }
}
`;

const KEY_DEFS: Record<string, { keyCode?: number; key?: string; text?: string }> = {
  Enter: { keyCode: 13, key: "Enter", text: "\r" },
  Tab: { keyCode: 9, key: "Tab" },
  Escape: { keyCode: 27, key: "Escape" },
  Backspace: { keyCode: 8, key: "Backspace" },
  Delete: { keyCode: 46, key: "Delete" },
  ArrowUp: { keyCode: 38, key: "ArrowUp" },
  ArrowDown: { keyCode: 40, key: "ArrowDown" },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft" },
  ArrowRight: { keyCode: 39, key: "ArrowRight" },
  Home: { keyCode: 36, key: "Home" },
  End: { keyCode: 35, key: "End" },
  PageUp: { keyCode: 33, key: "PageUp" },
  PageDown: { keyCode: 34, key: "PageDown" },
  Space: { keyCode: 32, key: " ", text: " " },
  Alt: { keyCode: 18, key: "Alt" },
  Control: { keyCode: 17, key: "Control" },
  Meta: { keyCode: 91, key: "Meta" },
  Shift: { keyCode: 16, key: "Shift" },
};

const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

function normalizeKey(key: string): string {
  if (key === "Ctrl") return "Control";
  if (key === "Cmd") return "Meta";
  return key;
}

type RuntimeExceptionDetails = {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  url?: string;
  exception?: { value?: unknown; description?: string };
  stackTrace?: {
    callFrames?: Array<{
      functionName?: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    }>;
  };
};

function formatRuntimeException(details: RuntimeExceptionDetails): string {
  const remote = details.exception;
  const value =
    remote && Object.prototype.hasOwnProperty.call(remote, "value")
      ? String(remote.value)
      : undefined;
  const primary = remote?.description || value || details.text || "Unknown browser exception";
  const frames = details.stackTrace?.callFrames ?? [];
  const stack =
    frames.length > 0 && !primary.includes("\n")
      ? frames
          .slice(0, 8)
          .map((frame) => {
            const name = frame.functionName || "<anonymous>";
            const url = frame.url || details.url || "<page>";
            const line = typeof frame.lineNumber === "number" ? `:${frame.lineNumber + 1}` : "";
            const column =
              typeof frame.columnNumber === "number" ? `:${frame.columnNumber + 1}` : "";
            return `    at ${name} (${url}${line}${column})`;
          })
          .join("\n")
      : "";
  const location =
    !stack &&
    !primary.includes("\n") &&
    (details.url ||
      typeof details.lineNumber === "number" ||
      typeof details.columnNumber === "number")
      ? `\n    at ${details.url || "<page>"}${
          typeof details.lineNumber === "number" ? `:${details.lineNumber + 1}` : ""
        }${typeof details.columnNumber === "number" ? `:${details.columnNumber + 1}` : ""}`
      : "";
  return `Browser evaluation failed: ${primary}${stack ? `\n${stack}` : location}`;
}

/**
 * Error thrown by locator actions/reads. `message` names the target locator
 * (Playwright-style) and the underlying reason; `.locator` holds the rendered
 * locator string and `.cause` the original error.
 */
export interface CdpFailureData {
  code:
    | "cdp_target_connection_failed"
    | "cdp_target_closed"
    | "cdp_command_timeout"
    | "cdp_evaluation_timeout"
    | "cdp_evaluation_failed"
    | "cdp_locator_operation_failed"
    | "cdp_locator_not_actionable"
    | "cdp_locator_state_mismatch"
    | "cdp_interaction_outcome_not_observed"
    | "cdp_workspace_navigation_forbidden";
  operation: string;
  failureKind: "user-code" | "infrastructure";
  recovery:
    | "correct-page-function"
    | "reobserve-locator"
    | "reacquire-page"
    | "inspect-panel-and-reacquire-page"
    | "use-panel-handle-lifecycle";
  locator?: string;
  timeoutMs?: number;
  state?: WaitState;
  expectedLocator?: string;
  instruction?: string;
}

export class CdpError extends Error {
  readonly locator?: string;
  readonly code: CdpFailureData["code"];
  readonly errorKind: "application" | "infrastructure";
  readonly errorData: CdpFailureData;
  constructor(
    message: string,
    options: {
      cause?: unknown;
      locator?: string;
      code?: CdpFailureData["code"];
      operation?: string;
      failureKind?: CdpFailureData["failureKind"];
      recovery?: CdpFailureData["recovery"];
      timeoutMs?: number;
      state?: WaitState;
      expectedLocator?: string;
      instruction?: string;
    } = {}
  ) {
    super(message);
    this.name = "CdpError";
    this.locator = options.locator;
    this.code = options.code ?? "cdp_locator_operation_failed";
    const failureKind = options.failureKind ?? "user-code";
    this.errorKind = failureKind === "infrastructure" ? "infrastructure" : "application";
    this.errorData = {
      code: this.code,
      operation: options.operation ?? "locator",
      failureKind,
      recovery: options.recovery ?? "reobserve-locator",
      ...(options.locator ? { locator: options.locator } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.state ? { state: options.state } : {}),
      ...(options.expectedLocator ? { expectedLocator: options.expectedLocator } : {}),
      ...(options.instruction ? { instruction: options.instruction } : {}),
    };
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

function serializeTextMatcher(value: TextMatcher): SerializedTextMatcher {
  return typeof value === "string"
    ? value
    : { regex: { source: value.source, flags: value.flags } };
}

/** Render a locator descriptor as a Playwright-style string for errors/toString(). */
function describeLocator(descriptor: LocatorDescriptor): string {
  const q = (s: string) => JSON.stringify(s);
  const matcher = (value: SerializedTextMatcher) =>
    typeof value === "string"
      ? q(value)
      : `/${value.regex.source.replace(/\//g, "\\/")}/${value.regex.flags}`;
  const parts = descriptor.steps.map((step) => {
    if ("filter" in step) {
      return `filter(${
        step.filter.hasText != null ? `{ hasText: ${matcher(step.filter.hasText)} }` : "{}"
      })`;
    }
    if ("nth" in step) {
      if (step.nth === 0) return "first()";
      if (step.nth === -1) return "last()";
      return `nth(${step.nth})`;
    }
    const exact = "exact" in step && step.exact ? ", { exact: true }" : "";
    switch (step.by) {
      case "css":
        return `locator(${q(step.value)})`;
      case "role": {
        const opts: string[] = [];
        if (step.name != null) opts.push(`name: ${matcher(step.name)}`);
        if (step.exact) opts.push("exact: true");
        return `getByRole(${q(step.value)}${opts.length ? `, { ${opts.join(", ")} }` : ""})`;
      }
      case "text":
        return `getByText(${matcher(step.value)}${exact})`;
      case "label":
        return `getByLabel(${matcher(step.value)}${exact})`;
      case "placeholder":
        return `getByPlaceholder(${matcher(step.value)}${exact})`;
      case "testid":
        return `getByTestId(${q(step.value)})`;
      case "alt":
        return `getByAltText(${matcher(step.value)}${exact})`;
      case "title":
        return `getByTitle(${matcher(step.value)}${exact})`;
    }
  });
  return parts.length ? parts.join(".") : "locator()";
}

class WorkerCdpPage {
  private currentUrl = "";
  private currentViewportSize: CdpViewportSize | null = null;
  private defaultTimeout = 30_000;
  private readonly consoleBuffer: CdpConsoleEvent[] = [];
  private readonly pressedModifiers = new Set<string>();
  private retainedElementSequence = 0;
  private profileActive = false;
  private readonly retainedElementOwner = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  readonly keyboard: Keyboard = {
    down: async (key) => {
      await this.keyDown(key);
      await this.afterAction();
    },
    up: async (key) => {
      await this.keyUp(key);
      await this.afterAction();
    },
    press: (key) => this.pressKey(key),
    type: async (text) => {
      for (const character of text) await this.pressKey(character);
    },
    insertText: async (text) => {
      await this.connection.send("Input.insertText", { text });
      await this.afterAction();
    },
  };

  constructor(readonly connection: CdpConnection) {
    this.connection.on("Runtime.consoleAPICalled", (params) => {
      const event = params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string; type?: string }>;
      };
      const args = (event.args ?? []).map((arg) =>
        Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : arg.description
      );
      this.consoleBuffer.push({
        type: event.type ?? "log",
        text: args.map((arg) => String(arg)).join(" "),
        args,
      });
    });
  }

  async initialize(): Promise<void> {
    await Promise.allSettled([
      this.connection.send("Page.enable"),
      this.connection.send("Runtime.enable"),
      this.connection.send("DOM.enable"),
    ]);
    this.currentUrl = String(
      (await this.evaluateInternal(() => location.href).catch(() => "")) ?? ""
    );
    const viewport = await this.evaluateInternal(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })).catch(() => null);
    if (
      viewport &&
      typeof viewport === "object" &&
      typeof (viewport as CdpViewportSize).width === "number" &&
      typeof (viewport as CdpViewportSize).height === "number"
    ) {
      this.currentViewportSize = viewport as CdpViewportSize;
    }
  }

  // ---- Navigation -------------------------------------------------------
  async goto(url: string): Promise<unknown> {
    const settled = this.waitForNavigationSettled(this.defaultTimeout);
    let result: { frameId?: string; errorText?: string };
    try {
      result = (await this.connection.send("Page.navigate", { url })) as {
        frameId?: string;
        errorText?: string;
      };
    } catch (error) {
      settled.cancel();
      throw error;
    }
    // Await the navigation settling (main frame stops loading / load event fires) before returning.
    // Without this, `goto` returns the instant Page.navigate is acknowledged, so a follow-up
    // screenshot/evaluate races the in-flight navigation — during a cross-origin swap the page is
    // momentarily detached and the command fails with "Not attached to an active page". Best-effort:
    // resolve on timeout rather than throw, so a slow page doesn't hard-fail the call.
    if (!result.errorText) {
      settled.setFrameId(result.frameId);
      await settled.promise;
    } else {
      settled.cancel();
    }
    this.currentUrl = url;
    return result;
  }

  /** Resolve once the page finishes (re)loading after a navigation, or after `timeout` ms. */
  private waitForNavigationSettled(timeout: number): {
    promise: Promise<void>;
    setFrameId(frameId: string | undefined): void;
    cancel(): void;
  } {
    let frameId: string | undefined;
    const stoppedFrames = new Set<string>();
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const cleanups: Array<() => void> = [];
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      resolvePromise();
    };
    // Install listeners before Page.navigate. Fast navigations can emit their
    // lifecycle event before the navigate response reaches the client.
    cleanups.push(this.connection.on("Page.loadEventFired", () => finish()));
    cleanups.push(
      this.connection.on("Page.frameStoppedLoading", (params) => {
        const fid = (params as { frameId?: string }).frameId;
        if (!fid) return;
        if (frameId) {
          if (fid === frameId) finish();
        } else {
          stoppedFrames.add(fid);
        }
      })
    );
    const timer = setTimeout(finish, timeout);
    cleanups.push(() => clearTimeout(timer));
    return {
      promise,
      setFrameId: (nextFrameId) => {
        frameId = nextFrameId;
        if (frameId && stoppedFrames.has(frameId)) finish();
      },
      cancel: finish,
    };
  }

  async reload(): Promise<void> {
    const settled = this.waitForNavigationSettled(this.defaultTimeout);
    try {
      await this.connection.send("Page.reload", {});
      await settled.promise;
    } catch (error) {
      settled.cancel();
      throw error;
    }
  }

  async goBack(): Promise<void> {
    await this.navigateHistory(-1);
  }

  async goForward(): Promise<void> {
    await this.navigateHistory(1);
  }

  private async navigateHistory(delta: number): Promise<void> {
    const history = (await this.connection.send("Page.getNavigationHistory", {})) as {
      currentIndex: number;
      entries: Array<{ id: number }>;
    };
    const target = history.entries[history.currentIndex + delta];
    if (!target) return;
    const settled = this.waitForNavigationSettled(this.defaultTimeout);
    try {
      await this.connection.send("Page.navigateToHistoryEntry", {
        entryId: target.id,
      });
      await settled.promise;
    } catch (error) {
      settled.cancel();
      throw error;
    }
  }

  async title(): Promise<string> {
    return String((await this.evaluateInternal(() => document.title)) ?? "");
  }

  url(): string {
    return this.currentUrl;
  }

  async content(): Promise<string> {
    return String(
      (await this.evaluateInternal(() => document.documentElement?.outerHTML ?? "")) ?? ""
    );
  }

  /** Set the default timeout (ms) used by auto-waiting actions/reads. Default 30000. */
  setDefaultTimeout(timeoutMs: number): void {
    this.defaultTimeout = timeoutMs;
  }

  /** Emulate a CSS viewport using the canonical CDP device-metrics override. */
  async setViewportSize(viewportSize: CdpViewportSize): Promise<void> {
    const { width, height } = viewportSize;
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new TypeError(
        `setViewportSize requires positive integer width and height; received ${JSON.stringify(
          viewportSize
        )}`
      );
    }
    await this.connection.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.currentViewportSize = { width, height };
  }

  viewportSize(): CdpViewportSize | null {
    return this.currentViewportSize ? { ...this.currentViewportSize } : null;
  }

  /**
   * Measure one bounded reload or interaction using browser-native CDP metrics.
   * The callback owns readiness/settling so the report describes the exact
   * user-visible boundary chosen by the caller.
   */
  async profile(
    action: () => unknown | Promise<unknown>,
    options?: CdpProfileOptions
  ): Promise<CdpProfileReport> {
    if (this.profileActive) {
      throw new Error("A profiling operation is already active on this page");
    }
    this.profileActive = true;
    try {
      return await runCdpProfile({
        page: this,
        transport: this.connection,
        action,
        options,
      });
    } finally {
      this.profileActive = false;
    }
  }

  // ---- Evaluate ---------------------------------------------------------
  async evaluate(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
    options: { timeout?: number; operation?: string } = {}
  ): Promise<unknown> {
    const expression =
      typeof pageFunction === "function"
        ? `(${pageFunction.toString()})(${JSON.stringify(arg)})`
        : pageFunction;
    return this.evaluateExpression(
      expression,
      options.operation ?? "Runtime.evaluate",
      options.timeout ?? this.defaultTimeout
    );
  }

  /** Internal browser reads retain transport-level timeout classification. */
  private async evaluateInternal(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown
  ): Promise<unknown> {
    const expression =
      typeof pageFunction === "function"
        ? `(${pageFunction.toString()})(${JSON.stringify(arg)})`
        : pageFunction;
    return this.evaluateExpression(expression, "Runtime.evaluate");
  }

  private async evaluateExpression(
    expression: string,
    operation: string,
    timeout?: number
  ): Promise<unknown> {
    const result = (await this.connection.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeout === undefined
        ? {}
        : {
            timeoutMs: timeout,
            timeoutBehavior: "reject",
            timeoutError: (timeoutMs) =>
              new CdpError(
                `Browser evaluation timed out after ${timeoutMs}ms during ${operation}.`,
                {
                  code: "cdp_evaluation_timeout",
                  operation,
                  failureKind: "user-code",
                  recovery: "reobserve-locator",
                  timeoutMs,
                }
              ),
          }
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: RuntimeExceptionDetails;
    };
    if (result.exceptionDetails) {
      throw new CdpError(formatRuntimeException(result.exceptionDetails), {
        code: "cdp_evaluation_failed",
        operation,
        recovery: "correct-page-function",
      });
    }
    return result.result?.value;
  }

  /** Run an in-page op against a locator descriptor; failures name the locator. */
  async runLocatorOp(
    op: string,
    descriptor: LocatorDescriptor,
    arg: unknown,
    opts: { timeout?: number; state?: WaitState } = {}
  ): Promise<unknown> {
    const timeout = opts.timeout ?? this.defaultTimeout;
    const payload = {
      op,
      descriptor,
      arg: arg ?? null,
      timeout,
      state: opts.state ?? null,
    };
    try {
      const deadline = Date.now() + timeout;
      for (;;) {
        const expr = `(async function(P){ ${INPAGE}\n return await __nsRun(P); })(${JSON.stringify(
          payload
        )})`;
        const result = await this.evaluate(expr, undefined, {
          timeout: timeout + 1_000,
          operation: `locator.${op}`,
        });
        if (
          !result ||
          typeof result !== "object" ||
          (result as { __nsLocatorFailure?: unknown }).__nsLocatorFailure !== "state-timeout"
        ) {
          return result;
        }
        const state = (result as { state?: WaitState }).state ?? opts.state ?? "visible";
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new CdpError(`Timeout ${timeout}ms waiting for element to be ${state}`, {
            code: "cdp_locator_state_mismatch",
            operation: op,
            recovery: "reobserve-locator",
            timeoutMs: timeout,
            state,
          });
        }
        // Yield outside Runtime.evaluate. A long-lived in-page polling promise
        // can prevent Chromium from delivering a preceding CDP Input event to
        // the renderer, making the click's effect appear only after the wait
        // itself times out.
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
      }
    } catch (err) {
      const where = describeLocator(descriptor);
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof CdpError) {
        throw new CdpError(`${op} failed on ${where}: ${detail}`, {
          cause: err,
          locator: where,
          code: err.code,
          operation: op,
          failureKind: err.errorData.failureKind,
          recovery: err.errorData.recovery,
          timeoutMs: err.errorData.timeoutMs,
          state: err.errorData.state,
          expectedLocator: err.errorData.expectedLocator,
          instruction: err.errorData.instruction,
        });
      }
      throw new CdpError(`${op} failed on ${where}: ${detail}`, {
        cause: err,
        locator: where,
        code: "cdp_locator_operation_failed",
        operation: op,
        recovery: "reobserve-locator",
      });
    }
  }

  // ---- Locators ---------------------------------------------------------
  locator(selector: string): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [compileLocatorSelector(selector)],
    });
  }
  getByRole(role: string, options: ByRoleOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [
        {
          by: "role",
          value: role,
          name: options.name === undefined ? undefined : serializeTextMatcher(options.name),
          exact: options.exact,
        },
      ],
    });
  }
  getByText(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "text", value: serializeTextMatcher(text), exact: options.exact }],
    });
  }
  getByLabel(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [
        {
          by: "label",
          value: serializeTextMatcher(text),
          exact: options.exact,
        },
      ],
    });
  }
  getByPlaceholder(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [
        {
          by: "placeholder",
          value: serializeTextMatcher(text),
          exact: options.exact,
        },
      ],
    });
  }
  getByTestId(testId: string): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "testid", value: testId }],
    });
  }
  getByAltText(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [{ by: "alt", value: serializeTextMatcher(text), exact: options.exact }],
    });
  }
  getByTitle(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return new WorkerCdpLocator(this, {
      steps: [
        {
          by: "title",
          value: serializeTextMatcher(text),
          exact: options.exact,
        },
      ],
    });
  }

  // ---- Waits ------------------------------------------------------------
  async waitForTimeout(timeout: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeout));
  }

  async waitForFunction(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
    options?: { timeout?: number; polling?: number | "raf" }
  ): Promise<unknown> {
    let actualArg = arg;
    let actualOptions = options ?? {};
    if (
      options === undefined &&
      arg &&
      typeof arg === "object" &&
      ("timeout" in arg || "polling" in arg)
    ) {
      actualArg = undefined;
      actualOptions = arg as { timeout?: number; polling?: number | "raf" };
    }
    const timeout = actualOptions.timeout ?? this.defaultTimeout;
    const polling =
      typeof actualOptions.polling === "number" && actualOptions.polling > 0
        ? actualOptions.polling
        : 50;
    const source =
      typeof pageFunction === "function" ? `(${pageFunction.toString()})` : pageFunction;
    const isFunction = typeof pageFunction === "function";

    return this.evaluate(
      `(async function(source, isFunction, arg, timeout, polling) {
        const deadline = Date.now() + timeout;
        const predicateOrValue = isFunction
          ? (0, eval)(source)
          : new Function("arg", "return (" + source + ")");
        while (Date.now() <= deadline) {
          let value = await (
            typeof predicateOrValue === "function" ? predicateOrValue(arg) : predicateOrValue
          );
          if (typeof value === "function") value = await value(arg);
          if (value) return value === true ? true : value;
          await new Promise(resolve => setTimeout(resolve, polling));
        }
        throw new Error("Timeout " + timeout + "ms exceeded waiting for function");
      })(${JSON.stringify(source)}, ${JSON.stringify(isFunction)}, ${JSON.stringify(
        actualArg
      )}, ${JSON.stringify(timeout)}, ${JSON.stringify(polling)})`,
      undefined,
      { timeout: timeout + 1_000, operation: "waitForFunction" }
    );
  }

  async waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle" = "load",
    options: { timeout?: number } = {}
  ): Promise<void> {
    const timeout = options.timeout ?? this.defaultTimeout;
    await this.evaluate(
      `(async function(state, timeout) {
        const deadline = Date.now() + timeout;
        function reached() {
          const ready = document.readyState;
          if (state === "domcontentloaded") return ready === "interactive" || ready === "complete";
          return ready === "complete";
        }
        while (Date.now() <= deadline) {
          if (reached()) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Timeout " + timeout + "ms exceeded waiting for load state " + state);
      })(${JSON.stringify(state)}, ${JSON.stringify(timeout)})`,
      undefined,
      { timeout: timeout + 1_000, operation: "waitForLoadState" }
    );
  }

  async waitForSelector(
    selector: string,
    options: { state?: WaitState; timeout?: number } = {}
  ): Promise<WorkerCdpElementHandle | null> {
    const loc = this.locator(selector);
    await loc.waitFor(options);
    if (options.state === "detached" || options.state === "hidden") return null;
    return new WorkerCdpElementHandle(this, {
      steps: [{ by: "css", value: selector }],
    });
  }

  // ---- Pointer / keyboard primitives (CDP Input) ------------------------
  /** Resolve a stable, actionable hit point for a descriptor (auto-waits). */
  async resolveHitPoint(
    descriptor: LocatorDescriptor,
    timeout: number = this.defaultTimeout,
    retainToken?: string
  ): Promise<{ x: number; y: number }> {
    type ActionabilityProbe = {
      ok: boolean;
      x?: number;
      y?: number;
      reason?: string;
      box?: BoundingBox;
    };
    const deadline = Date.now() + timeout;
    let previousBox: BoundingBox | undefined;
    let probe: ActionabilityProbe = { ok: false, reason: "not found" };
    for (;;) {
      probe = (await this.runLocatorOp(
        "probe",
        descriptor,
        retainToken ? { retainToken } : null,
        { timeout: 0 }
      )) as ActionabilityProbe;
      const box = probe.box;
      const stable =
        probe.ok &&
        box !== undefined &&
        previousBox !== undefined &&
        Math.abs(previousBox.x - box.x) < 1 &&
        Math.abs(previousBox.y - box.y) < 1 &&
        Math.abs(previousBox.width - box.width) < 1 &&
        Math.abs(previousBox.height - box.height) < 1;
      if (stable && typeof probe.x === "number" && typeof probe.y === "number") {
        return { x: probe.x, y: probe.y };
      }
      previousBox = probe.ok ? box : undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Keep Runtime.evaluate one-shot. Renderer input and framework work can
      // run while the worker waits between actionability observations.
      await new Promise((resolve) => setTimeout(resolve, Math.min(30, remaining)));
    }

    const where = describeLocator(descriptor);
    const candidates =
      probe.reason === "not found"
        ? ((await this.runLocatorOp("roleCandidates", descriptor, null, {
            timeout: 0,
          }).catch(() => [])) as Array<{
            role?: string;
            accessibleName?: string;
          }>)
        : [];
    const candidateHint =
      candidates.length > 0
        ? candidates.every((candidate) => candidate.role === candidates[0]?.role)
          ? ` Available ${candidates[0]?.role ?? "role"} names: ${candidates
              .map((candidate) => JSON.stringify(candidate.accessibleName ?? ""))
              .join(", ")}. Inspect the role locator before choosing a name.`
          : ` Available accessible targets: ${candidates
              .map(
                (candidate) =>
                  `${candidate.role ?? "unknown role"} ${JSON.stringify(
                    candidate.accessibleName ?? ""
                  )}`
              )
              .join(", ")}. Use the rendered role and accessible name.`
        : "";
    throw new CdpError(
      `not actionable (${probe.reason ?? "timeout"}) after ${timeout}ms: ${where}.${candidateHint}`,
      {
        locator: where,
        code: "cdp_locator_not_actionable",
        operation: "click",
        recovery: "reobserve-locator",
        timeoutMs: timeout,
      }
    );
  }

  private async dispatchClickAt(
    point: { x: number; y: number },
    opts: { clickCount?: number; button?: "left" | "right" | "middle" } = {}
  ): Promise<void> {
    const { x, y } = point;
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
    });
    await this.afterAction();
  }

  async clickDescriptor(
    descriptor: LocatorDescriptor,
    opts: ClickOptions & {
      clickCount?: number;
      button?: "left" | "right" | "middle";
    } = {}
  ): Promise<CdpInteractionOutcome> {
    const point = await this.resolveHitPoint(descriptor, opts.timeout);
    const target = (await this.runLocatorOp("inspect", descriptor, null, {
      timeout: 0,
    })) as Omit<CdpDomInspection, "selector"> & { found: boolean };
    await this.dispatchClickAt(point, opts);
    const action = opts.clickCount === 2 ? "dblclick" : "click";
    if (!opts.expect) {
      return {
        protocol: "cdp-interaction-outcome.v1",
        action,
        delivery: "dispatched",
        target: { selector: describeLocator(descriptor), ...target },
        effect: { status: "not-asserted" },
      };
    }
    const state = opts.expect.state ?? "visible";
    try {
      await opts.expect.locator.waitFor({
        state,
        timeout: opts.expect.timeout ?? opts.timeout,
      });
    } catch (cause) {
      const expectedLocator = opts.expect.locator.toString();
      const timeoutMs = opts.expect.timeout ?? opts.timeout ?? this.defaultTimeout;
      throw new CdpError(
        `${action} was dispatched to ${describeLocator(descriptor)}, but expected ${expectedLocator} to become ${state}`,
        {
          cause,
          locator: describeLocator(descriptor),
          code: "cdp_interaction_outcome_not_observed",
          operation: action,
          recovery: "reobserve-locator",
          timeoutMs,
          state,
          expectedLocator,
        }
      );
    }
    return {
      protocol: "cdp-interaction-outcome.v1",
      action,
      delivery: "dispatched",
      target: { selector: describeLocator(descriptor), ...target },
      effect: {
        status: "observed",
        locator: opts.expect.locator.toString(),
        state,
      },
    };
  }

  async hoverDescriptor(descriptor: LocatorDescriptor, opts: ActionOptions = {}): Promise<void> {
    const { x, y } = await this.resolveHitPoint(descriptor, opts.timeout);
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    await this.afterAction();
  }

  async pressDescriptor(
    descriptor: LocatorDescriptor,
    key: string,
    opts: ActionOptions = {}
  ): Promise<void> {
    await this.runLocatorOp("focusForKey", descriptor, null, {
      timeout: opts.timeout,
    });
    await this.pressKey(key);
  }

  async setCheckedDescriptor(
    descriptor: LocatorDescriptor,
    checked: boolean,
    opts: ActionOptions = {}
  ): Promise<void> {
    const retainToken = `${this.retainedElementOwner}-check-${++this.retainedElementSequence}`;
    const point = await this.resolveHitPoint(descriptor, opts.timeout, retainToken);
    try {
      const retainedArg = { token: retainToken };
      const current = (await this.runLocatorOp("retainedCheckedState", descriptor, retainedArg, {
        timeout: opts.timeout,
      })) as boolean;
      if (current === checked) return;
      await this.dispatchClickAt(point);
      const updated = (await this.runLocatorOp("retainedCheckedState", descriptor, retainedArg, {
        timeout: opts.timeout,
      })) as boolean;
      if (updated !== checked) {
        const where = describeLocator(descriptor);
        throw new CdpError(
          `${checked ? "check" : "uncheck"} did not update ${where}'s checked state`,
          {
            locator: where,
            code: "cdp_locator_state_mismatch",
            operation: checked ? "check" : "uncheck",
            recovery: "reobserve-locator",
          }
        );
      }
    } finally {
      await this.runLocatorOp(
        "releaseRetainedElement",
        descriptor,
        { token: retainToken },
        { timeout: 0 }
      ).catch(() => undefined);
    }
  }

  private keyboardModifiers(): number {
    let modifiers = 0;
    for (const key of this.pressedModifiers) modifiers |= MODIFIER_BITS[key] ?? 0;
    return modifiers;
  }

  private keyDefinition(key: string): Record<string, unknown> {
    const normalized = normalizeKey(key);
    const def = KEY_DEFS[normalized];
    return def
      ? {
          key: def.key ?? normalized,
          windowsVirtualKeyCode: def.keyCode,
          nativeVirtualKeyCode: def.keyCode,
        }
      : {
          key: normalized,
          text: normalized.length === 1 ? normalized : undefined,
        };
  }

  private async keyDown(key: string): Promise<void> {
    const normalized = normalizeKey(key);
    if (MODIFIER_BITS[normalized]) this.pressedModifiers.add(normalized);
    await this.connection.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...this.keyDefinition(normalized),
      modifiers: this.keyboardModifiers(),
    });
  }

  private async keyUp(key: string): Promise<void> {
    const normalized = normalizeKey(key);
    await this.connection.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      ...this.keyDefinition(normalized),
      modifiers: this.keyboardModifiers(),
    });
    this.pressedModifiers.delete(normalized);
  }

  /** Dispatch a key or chord (for example "Enter" or "Control+A"). */
  async pressKey(key: string): Promise<void> {
    const parts = key.split("+").map(normalizeKey);
    const main = parts.pop();
    if (!main) throw new Error("keyboard.press requires a key");
    for (const modifier of parts) await this.keyDown(modifier);
    await this.keyDown(main);
    const def = KEY_DEFS[main];
    const text =
      parts.length === 0 ? (def?.text ?? (main.length === 1 ? main : undefined)) : undefined;
    if (text) {
      await this.connection.send("Input.dispatchKeyEvent", {
        type: "char",
        text,
        key: this.keyDefinition(main)["key"],
        modifiers: this.keyboardModifiers(),
      });
    }
    await this.keyUp(main);
    for (const modifier of parts.reverse()) await this.keyUp(modifier);
    await this.afterAction();
  }

  /** Yield the worker turn after dispatch; locator postconditions observe effects. */
  private async afterAction(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ---- Console ----------------------------------------------------------
  consoleEvents(): CdpConsoleEvent[] {
    return [...this.consoleBuffer];
  }
  clearConsoleEvents(): void {
    this.consoleBuffer.length = 0;
  }

  // ---- Screenshot -------------------------------------------------------
  async screenshot(options: CdpScreenshotOptions = {}): Promise<Uint8Array> {
    const supported = new Set(["type", "quality", "fullPage"]);
    const unsupported = Object.keys(options).filter((key) => !supported.has(key));
    if (unsupported.length > 0) {
      const pathHint = unsupported.includes("path")
        ? " CdpPage.screenshot returns Uint8Array; store it explicitly with @workspace/runtime blobstore.putBytes."
        : "";
      throw new TypeError(
        `Unsupported screenshot option${unsupported.length === 1 ? "" : "s"} ${unsupported
          .map((key) => JSON.stringify(key))
          .join(", ")}.${pathHint} Supported options: type, quality, fullPage.`
      );
    }
    if (
      options.quality !== undefined &&
      (!Number.isInteger(options.quality) || options.quality < 0 || options.quality > 100)
    ) {
      throw new TypeError(
        `screenshot quality must be an integer from 0 to 100; received ${JSON.stringify(
          options.quality
        )}`
      );
    }
    if (options.quality !== undefined && options.type !== "jpeg") {
      throw new TypeError('screenshot quality is supported only when type is "jpeg"');
    }
    // Keep the public page API Playwright-shaped (`type`) while speaking the
    // Chrome DevTools Protocol shape (`format`) on the wire.
    const { type, fullPage, ...rest } = options;
    const params = {
      ...rest,
      ...(type ? { format: type } : {}),
      ...(fullPage ? { captureBeyondViewport: true } : {}),
    };
    const result = (await this.connection.send("Page.captureScreenshot", params)) as {
      data?: string;
    };
    if (!result.data) throw new Error("CDP screenshot did not return image data");
    return decodeBase64(result.data);
  }

  /** Disconnect this automation client. Target/panel lifecycle remains handle-owned. */
  async close(): Promise<void> {
    this.connection.close();
  }

  /** True after client close, bridge replacement, transport loss, or command timeout. */
  isClosed(): boolean {
    return this.connection.isClosed();
  }
}

class WorkerCdpLocator {
  constructor(
    protected readonly page: WorkerCdpPage,
    protected readonly descriptor: LocatorDescriptor
  ) {}

  private extend(step: LocatorStep): WorkerCdpLocator {
    return new WorkerCdpLocator(this.page, {
      steps: [...this.descriptor.steps, step],
    });
  }

  /** Playwright-style description, e.g. `getByRole("button", { name: "Go" })`. */
  toString(): string {
    return describeLocator(this.descriptor);
  }

  // ---- Scoped sub-locators / chaining -----------------------------------
  locator(selector: string): WorkerCdpLocator {
    return this.extend(compileLocatorSelector(selector));
  }
  getByRole(role: string, options: ByRoleOptions = {}): WorkerCdpLocator {
    return this.extend({
      by: "role",
      value: role,
      name: options.name === undefined ? undefined : serializeTextMatcher(options.name),
      exact: options.exact,
    });
  }
  getByText(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({
      by: "text",
      value: serializeTextMatcher(text),
      exact: options.exact,
    });
  }
  getByLabel(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({
      by: "label",
      value: serializeTextMatcher(text),
      exact: options.exact,
    });
  }
  getByPlaceholder(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({
      by: "placeholder",
      value: serializeTextMatcher(text),
      exact: options.exact,
    });
  }
  getByTestId(testId: string): WorkerCdpLocator {
    return this.extend({ by: "testid", value: testId });
  }
  getByAltText(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({
      by: "alt",
      value: serializeTextMatcher(text),
      exact: options.exact,
    });
  }
  getByTitle(text: TextMatcher, options: ByTextOptions = {}): WorkerCdpLocator {
    return this.extend({
      by: "title",
      value: serializeTextMatcher(text),
      exact: options.exact,
    });
  }
  filter(options: { hasText?: TextMatcher; hasTextExact?: boolean } = {}): WorkerCdpLocator {
    return this.extend({
      filter: {
        hasText: options.hasText === undefined ? undefined : serializeTextMatcher(options.hasText),
        hasTextExact: options.hasTextExact,
      },
    });
  }
  nth(index: number): WorkerCdpLocator {
    return this.extend({ nth: index });
  }
  first(): WorkerCdpLocator {
    return this.nth(0);
  }
  last(): WorkerCdpLocator {
    return this.nth(-1);
  }
  async all(): Promise<WorkerCdpLocator[]> {
    const count = await this.count();
    const out: WorkerCdpLocator[] = [];
    for (let i = 0; i < count; i++) out.push(this.nth(i));
    return out;
  }

  // ---- Actions (auto-waiting) -------------------------------------------
  async click(opts: ClickOptions = {}): Promise<CdpInteractionOutcome> {
    return this.page.clickDescriptor(this.descriptor, opts);
  }
  async dblclick(opts: ClickOptions = {}): Promise<CdpInteractionOutcome> {
    return this.page.clickDescriptor(this.descriptor, {
      ...opts,
      clickCount: 2,
    });
  }
  async hover(opts: ActionOptions = {}): Promise<void> {
    await this.page.hoverDescriptor(this.descriptor, opts);
  }
  async fill(value: string, opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("fill", this.descriptor, { value }, opts);
  }
  async type(text: string, opts: ActionOptions = {}): Promise<void> {
    const current = (await this.page.runLocatorOp(
      "inputValue",
      this.descriptor,
      null,
      opts
    )) as string;
    await this.page.runLocatorOp(
      "fill",
      this.descriptor,
      { value: `${current ?? ""}${text}` },
      opts
    );
  }
  async clear(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("clear", this.descriptor, null, opts);
  }
  async press(key: string, opts: ActionOptions = {}): Promise<void> {
    await this.page.pressDescriptor(this.descriptor, key, opts);
  }
  async check(opts: ActionOptions = {}): Promise<void> {
    await this.page.setCheckedDescriptor(this.descriptor, true, opts);
  }
  async uncheck(opts: ActionOptions = {}): Promise<void> {
    await this.page.setCheckedDescriptor(this.descriptor, false, opts);
  }
  async setChecked(checked: boolean, opts: ActionOptions = {}): Promise<void> {
    await this.page.setCheckedDescriptor(this.descriptor, checked, opts);
  }
  async selectOption(
    value: SelectOptionInput | SelectOptionInput[],
    opts: ActionOptions = {}
  ): Promise<string[]> {
    const values = Array.isArray(value) ? value : [value];
    for (const option of values) {
      if (typeof option === "string") continue;
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        throw new TypeError(
          "selectOption values must be strings or objects with value, label, or index"
        );
      }
      const keys = Object.keys(option);
      if (keys.length === 0 || keys.some((key) => !["value", "label", "index"].includes(key))) {
        throw new TypeError("selectOption option objects may only contain value, label, or index");
      }
      if (option.value === undefined && option.label === undefined && option.index === undefined) {
        throw new TypeError("selectOption option objects require value, label, or index");
      }
      if (option.value !== undefined && typeof option.value !== "string") {
        throw new TypeError("selectOption option.value must be a string");
      }
      if (option.label !== undefined && typeof option.label !== "string") {
        throw new TypeError("selectOption option.label must be a string");
      }
      if (option.index !== undefined && (!Number.isInteger(option.index) || option.index < 0)) {
        throw new TypeError("selectOption option.index must be a non-negative integer");
      }
    }
    return (await this.page.runLocatorOp(
      "selectOption",
      this.descriptor,
      { values },
      opts
    )) as string[];
  }
  async focus(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("focus", this.descriptor, null, opts);
  }
  async blur(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("blur", this.descriptor, null, opts);
  }
  async selectText(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("selectText", this.descriptor, null, opts);
  }
  async scrollIntoViewIfNeeded(opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("scrollIntoView", this.descriptor, null, opts);
  }
  async dispatchEvent(type: string, opts: ActionOptions = {}): Promise<void> {
    await this.page.runLocatorOp("dispatchEvent", this.descriptor, { type }, opts);
  }

  // ---- State / reads ----------------------------------------------------
  async waitFor(options: { state?: WaitState; timeout?: number } = {}): Promise<void> {
    await this.page.runLocatorOp("waitFor", this.descriptor, null, {
      state: options.state ?? "visible",
      timeout: options.timeout,
    });
  }
  async count(): Promise<number> {
    return Number((await this.page.runLocatorOp("count", this.descriptor, null)) ?? 0);
  }
  async isVisible(): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isVisible", this.descriptor, null));
  }
  async isChecked(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isChecked", this.descriptor, null, opts));
  }
  async isEnabled(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isEnabled", this.descriptor, null, opts));
  }
  async isDisabled(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isDisabled", this.descriptor, null, opts));
  }
  async isEditable(opts: ActionOptions = {}): Promise<boolean> {
    return Boolean(await this.page.runLocatorOp("isEditable", this.descriptor, null, opts));
  }
  async getAttribute(name: string, opts: ActionOptions = {}): Promise<string | null> {
    const v = await this.page.runLocatorOp("getAttribute", this.descriptor, { name }, opts);
    return v == null ? null : String(v);
  }
  async inputValue(opts: ActionOptions = {}): Promise<string> {
    return String((await this.page.runLocatorOp("inputValue", this.descriptor, null, opts)) ?? "");
  }
  async innerText(opts: ActionOptions = {}): Promise<string> {
    return String((await this.page.runLocatorOp("innerText", this.descriptor, null, opts)) ?? "");
  }
  async textContent(): Promise<string | null> {
    const v = await this.page.runLocatorOp("textContent", this.descriptor, null);
    return v == null ? null : String(v);
  }
  async allInnerTexts(): Promise<string[]> {
    return (await this.page.runLocatorOp("allInnerTexts", this.descriptor, null)) as string[];
  }
  async allTextContents(): Promise<string[]> {
    return (await this.page.runLocatorOp("allTextContents", this.descriptor, null)) as string[];
  }
  async evaluate<Result, Arg = unknown>(
    pageFunction: (element: Element, arg: Arg) => Result | Promise<Result>,
    arg?: Arg
  ): Promise<Result> {
    return (await this.page.runLocatorOp("evaluate", this.descriptor, {
      source: pageFunction.toString(),
      arg,
    })) as Result;
  }
  async evaluateAll<Result, Arg = unknown>(
    pageFunction: (elements: Element[], arg: Arg) => Result | Promise<Result>,
    arg?: Arg
  ): Promise<Result> {
    return (await this.page.runLocatorOp("evaluateAll", this.descriptor, {
      source: pageFunction.toString(),
      arg,
    })) as Result;
  }
  async boundingBox(): Promise<BoundingBox | null> {
    return (await this.page.runLocatorOp(
      "boundingBox",
      this.descriptor,
      null
    )) as BoundingBox | null;
  }
  async inspect(): Promise<CdpDomInspection> {
    const raw = (await this.page.runLocatorOp("inspect", this.descriptor, null)) as
      | (Omit<CdpDomInspection, "selector"> & { found: boolean })
      | { found: false };
    const selector = JSON.stringify(this.descriptor.steps);
    if (!raw.found) return { selector, found: false };
    return { selector, ...(raw as object) } as CdpDomInspection;
  }
}

class WorkerCdpElementHandle extends WorkerCdpLocator {}

class WorkerBrowser {
  constructor(
    private readonly page: WorkerCdpPage,
    private readonly connection: CdpConnection
  ) {}

  contexts(): Array<{ pages(): WorkerCdpPage[] }> {
    return [{ pages: () => [this.page] }];
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}

export const BrowserImpl = {
  async connect(
    wsEndpoint: string,
    options: {
      transportOptions?: { authToken?: string };
      /** Hosted EvalDO runtimes must use the egress-aware fetch upgrade. */
      preferFetchUpgrade?: boolean;
      /** Override the protocol safety deadline for diagnostics/tests. */
      commandTimeoutMs?: number;
    } = {}
  ): Promise<WorkerBrowser> {
    const connection = await CdpConnection.connect(
      wsEndpoint,
      options.transportOptions?.authToken,
      options.preferFetchUpgrade,
      { commandTimeoutMs: options.commandTimeoutMs }
    );
    const page = new WorkerCdpPage(connection);
    await page.initialize();
    return new WorkerBrowser(page, connection);
  },
};

export type { WorkerCdpPage, WorkerCdpLocator, WorkerCdpElementHandle, WorkerBrowser };
