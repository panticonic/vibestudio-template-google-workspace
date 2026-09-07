import {
  createPanelDeepLink,
  createPanelShareUrl,
  type PanelDisposition,
  type PanelLocation,
} from "@vibestudio/shared/panelLocation";
import { selectedWorkspaceNameFromUrl } from "@vibestudio/shared/connect";
import type { PanelPlacementHint } from "@vibestudio/shared/types";

/**
 * Link builders for HTTP-based panel navigation.
 *
 * Panels are served at `https?://{host}:{port}/{workspace-prefix?}/{source}/`.
 * These builders produce relative paths for same-context navigation or
 * absolute URLs for cross-context navigation on the current managed host.
 * Query parameters carry options like contextId, stateArgs, etc.
 */

export interface BuildPanelLinkOptions {
  /**
   * Context ID for storage partition sharing.
   * When provided, buildPanelLink produces an absolute URL on the current
   * managed host for cross-context navigation. Omit for same-context
   * navigation (relative URL).
   */
  contextId?: string;
  /** Code/build ref. This is independent from contextId and stateArgs. */
  ref?: string;
  /** State arguments for the panel (user state, validated against manifest schema) */
  stateArgs?: Record<string, unknown>;
  /** Display title, overriding the manifest's. Free text; carries no identity. */
  title?: string;
  /** Opt-in stable id segment; must be unique among the parent's children. */
  slug?: string;
  /** If true, immediately focus the new panel after creation */
  focus?: boolean;
  /** Explicit placement when the link is intercepted by host chrome. */
  disposition?: PanelDisposition;
  /** Visual layout hint for a newly-created target panel. */
  placement?: PanelPlacementHint;
  /** Override the workspace embedded in canonical share/deep links. */
  workspace?: string;
}

function gatewayServerUrl(): string | undefined {
  return (
    globalThis as typeof globalThis & {
      __vibestudioGatewayConfig?: { serverUrl?: string; workspace?: string };
    }
  ).__vibestudioGatewayConfig?.serverUrl;
}

function currentWorkspace(): string | undefined {
  const explicit = (
    globalThis as typeof globalThis & {
      __vibestudioGatewayConfig?: { workspace?: string };
    }
  ).__vibestudioGatewayConfig?.workspace;
  if (explicit) return explicit;
  const serverUrl = gatewayServerUrl();
  return serverUrl ? (selectedWorkspaceNameFromUrl(serverUrl) ?? undefined) : undefined;
}

function panelLocation(source: string, options?: BuildPanelLinkOptions): PanelLocation {
  const workspace = options?.workspace ?? currentWorkspace();
  return {
    source,
    ...(workspace ? { workspace } : {}),
    ...(options?.ref !== undefined ? { ref: options.ref } : {}),
    ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
    ...(options?.stateArgs !== undefined ? { stateArgs: options.stateArgs } : {}),
    ...(options?.title !== undefined ? { title: options.title } : {}),
    ...(options?.slug !== undefined ? { slug: options.slug } : {}),
    ...(options?.focus !== undefined ? { focus: options.focus } : {}),
    ...(options?.disposition !== undefined ? { disposition: options.disposition } : {}),
    ...(options?.placement !== undefined ? { placement: options.placement } : {}),
  };
}

/** Build an OS/app deep link for a logical panel location. */
export function buildPanelDeepLink(source: string, options?: BuildPanelLinkOptions): string {
  return createPanelDeepLink(panelLocation(source, options));
}

/** Build an HTTPS share URL for the same logical panel location. */
export function buildPanelShareLink(source: string, options?: BuildPanelLinkOptions): string {
  return createPanelShareUrl(panelLocation(source, options));
}

/**
 * Build a URL for navigating to a panel.
 *
 * - Same-context (no contextId): returns a relative URL (e.g., "/panels/chat/")
 * - Cross-context (with contextId): returns an absolute URL on the current host
 *   (e.g., "https://vibestudio.example.com/panels/chat/?contextId=ctx-abc")
 *
 * @param source - Workspace-relative source path (e.g., "panels/editor")
 * @param options - Optional navigation options
 * @returns Relative or absolute URL
 *
 * @example
 * ```ts
 * // Same-context navigation (relative URL)
 * buildPanelLink("panels/editor")
 * // => "/panels/editor/"
 *
 * // Cross-context navigation (absolute URL)
 * buildPanelLink("panels/chat", { contextId: "abc-123", stateArgs: { foo: 1 } })
 * // => "https://vibestudio.example.com/panels/chat/?contextId=abc-123&stateArgs=..."
 * ```
 */
export function buildPanelLink(source: string, options?: BuildPanelLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/");
  const params = new URLSearchParams();

  if (options?.contextId !== undefined) params.set("contextId", String(options.contextId));
  if (options?.ref !== undefined) params.set("ref", options.ref);
  if (options?.stateArgs !== undefined) params.set("stateArgs", JSON.stringify(options.stateArgs));
  if (options?.title !== undefined) params.set("title", options.title);
  if (options?.slug !== undefined) params.set("slug", options.slug);
  if (options?.focus !== undefined) params.set("focus", String(options.focus));
  if (options?.disposition !== undefined) params.set("disposition", options.disposition);
  if (options?.placement?.disposition !== undefined) {
    params.set("placement", options.placement.disposition);
  }
  if (options?.placement?.preferredWidth !== undefined) {
    params.set("preferredWidth", String(options.placement.preferredWidth));
  }
  if (options?.placement?.minWidth !== undefined) {
    params.set("minWidth", String(options.placement.minWidth));
  }

  const query = params.toString();
  const configuredGatewayServerUrl = gatewayServerUrl();
  let basePath = "";
  if (typeof window !== "undefined" && configuredGatewayServerUrl) {
    const pathname = new URL(configuredGatewayServerUrl).pathname.replace(/\/+$/, "");
    basePath = pathname === "/" ? "" : pathname;
  }
  const relativePath = `${basePath}/${encodedPath}/${query ? `?${query}` : ""}`;

  // Cross-context: absolute URL on the current managed host
  if (options?.contextId) {
    if (typeof window === "undefined") return relativePath;
    return `${window.location.origin}${relativePath}`;
  }

  return relativePath;
}
