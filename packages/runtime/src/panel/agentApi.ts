export type AgentDataMode = "fixture" | "live";

const SNAPSHOT_LIMITS = {
  textCharacters: 32_768,
  textNodes: 2_000,
  structureNodes: 500,
  depth: 8,
  childrenPerNode: 50,
  leafTextCharacters: 160,
} as const;

let dataMode: AgentDataMode = "live";
const customStateProviders = new Map<string, () => unknown>();

declare global {
  interface Window {
    __vibestudioAgentMode?: AgentDataMode;
  }
}

function boundedText(document: Document): {
  text: string;
  observedNodes: number;
  truncated: boolean;
} {
  const body = document.body;
  if (!body) return { text: "", observedNodes: 0, truncated: false };
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let characters = 0;
  let observedNodes = 0;
  let truncated = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (observedNodes >= SNAPSHOT_LIMITS.textNodes) {
      truncated = true;
      break;
    }
    observedNodes += 1;
    const value = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    const separator = chunks.length === 0 ? "" : "\n";
    const remaining = SNAPSHOT_LIMITS.textCharacters - characters - separator.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    chunks.push(`${separator}${value.slice(0, remaining)}`);
    characters += separator.length + Math.min(value.length, remaining);
    if (value.length > remaining) {
      truncated = true;
      break;
    }
  }
  return { text: chunks.join(""), observedNodes, truncated };
}

function boundedStructure(root: Element): {
  structure: unknown;
  observedNodes: number;
  truncated: boolean;
} {
  let observedNodes = 0;
  let truncated = false;

  const visit = (element: Element, depth: number): unknown | null => {
    if (observedNodes >= SNAPSHOT_LIMITS.structureNodes) {
      truncated = true;
      return null;
    }
    observedNodes += 1;
    const childCount = element.children.length;
    const children: unknown[] = [];
    if (depth >= SNAPSHOT_LIMITS.depth) {
      if (childCount > 0) truncated = true;
    } else {
      const limit = Math.min(childCount, SNAPSHOT_LIMITS.childrenPerNode);
      if (childCount > limit) truncated = true;
      for (let index = 0; index < limit; index += 1) {
        const child = element.children.item(index);
        if (!child) continue;
        const described = visit(child, depth + 1);
        if (described === null) break;
        children.push(described);
      }
    }
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") ?? undefined,
      label: element.getAttribute("aria-label") ?? undefined,
      text:
        childCount === 0
          ? (element.textContent ?? "").trim().slice(0, SNAPSHOT_LIMITS.leafTextCharacters)
          : undefined,
      children,
      depth,
    };
  };

  return { structure: visit(root, 0), observedNodes, truncated };
}

export function snapshotDocument(document: Document) {
  const text = boundedText(document);
  const structure = document.body
    ? boundedStructure(document.body)
    : { structure: null, observedNodes: 0, truncated: false };
  return {
    kind: "synth" as const,
    text: text.text,
    structure: structure.structure,
    truncated: text.truncated || structure.truncated,
    limits: SNAPSHOT_LIMITS,
    observed: {
      textNodes: text.observedNodes,
      structureNodes: structure.observedNodes,
    },
  };
}

export const agentApi = {
  snapshot() {
    return snapshotDocument(document);
  },
  tree() {
    return document.body ? boundedStructure(document.body).structure : null;
  },
  state() {
    return Object.fromEntries(
      [...customStateProviders].map(([key, provider]) => [key, provider()])
    );
  },
  routes() {
    return {
      href: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    };
  },
  setMode(mode: AgentDataMode) {
    dataMode = mode;
    window.__vibestudioAgentMode = mode;
    window.dispatchEvent(new CustomEvent("vibestudio:agentModeChanged", { detail: mode }));
    return { mode };
  },
  getMode() {
    return dataMode;
  },
  registerStateProvider(key: string, provider: () => unknown) {
    customStateProviders.set(key, provider);
    return () => customStateProviders.delete(key);
  },
};

export function exposeAgentApi(
  expose: (method: string, handler: (...args: any[]) => unknown | Promise<unknown>) => void
): void {
  expose("_agent.snapshot", () => agentApi.snapshot());
  expose("_agent.tree", () => agentApi.tree());
  expose("_agent.state", () => agentApi.state());
  expose("_agent.routes", () => agentApi.routes());
  expose("_agent.setMode", (mode) => agentApi.setMode(mode as AgentDataMode));
}
