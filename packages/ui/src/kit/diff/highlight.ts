/**
 * Best-effort syntax highlighting for the diff viewer, built on the fine-grained
 * shiki core entry (`shiki/core`) with the pure-JS regex engine (no wasm, so it
 * bundles cleanly into panels and runs under jsdom) and grammars/themes lazily
 * imported per file extension.
 *
 * Grammars and themes are loaded through a registry of STATIC import thunks
 * (`() => import("shiki/langs/typescript.mjs")`, …). Static specifiers let the
 * bundler code-split each grammar into its own async chunk that is fetched only
 * when a file of that language is first expanded — the "fine-grained" shiki
 * pattern — while a template-literal `import()` would defeat static analysis.
 *
 * Guardrails (provenance-aware-diff-merge-plan §9): every step is best-effort. A missing
 * or failed grammar, a highlighter that never loads, an incompatible regex — any
 * of these fall back to plain text and NEVER block review. Callers render plain
 * text first and upgrade to tokens only if/when highlighting succeeds.
 */

/** One highlighted line: a run of colored token spans. */
export interface HighlightToken {
  content: string;
  color?: string;
}
export type HighlightedLine = HighlightToken[];

/** Minimal structural shape of the shiki core highlighter we depend on, kept
 *  local so this module has no eager static import of shiki. */
interface CoreHighlighter {
  loadTheme(theme: unknown): Promise<void>;
  loadLanguage(lang: unknown): Promise<void>;
  getLoadedThemes(): string[];
  getLoadedLanguages(): string[];
  codeToTokens(
    code: string,
    options: { lang: string; theme: string }
  ): { tokens: { content: string; color?: string }[][] };
}

type ShikiModule = { default: unknown } | unknown;
type Loader = () => Promise<ShikiModule>;

/** Shiki theme ids for the two appearances, with their lazy loaders. */
const THEME_ID = { light: "github-light", dark: "github-dark" } as const;
export type HighlightAppearance = keyof typeof THEME_ID;

const THEME_LOADERS: Record<string, Loader> = {
  "github-light": () => import("shiki/themes/github-light.mjs"),
  "github-dark": () => import("shiki/themes/github-dark.mjs"),
};

/** shiki language id → its static grammar loader. Only listed languages are
 *  highlighted; anything else falls back to plain text. */
const LANG_LOADERS: Record<string, Loader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
};

/** File-extension → shiki language id (must exist in LANG_LOADERS). Unlisted
 *  extensions highlight as plain text (best-effort fallback). */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  svg: "xml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
  dockerfile: "docker",
};

export function languageForPath(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  if (base.toLowerCase() === "dockerfile") return LANG_BY_EXT["dockerfile"] ?? null;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? null;
}

let corePromise: Promise<CoreHighlighter | null> | null = null;

async function getCore(): Promise<CoreHighlighter | null> {
  if (!corePromise) {
    corePromise = (async () => {
      try {
        const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
        ]);
        const highlighter = await createHighlighterCore({
          themes: [],
          langs: [],
          // `forgiving` keeps an incompatible grammar regex from throwing — it
          // just skips that rule, degrading toward plain text.
          engine: createJavaScriptRegexEngine({ forgiving: true }),
        });
        return highlighter as unknown as CoreHighlighter;
      } catch {
        return null;
      }
    })();
  }
  return corePromise;
}

function moduleDefault(mod: ShikiModule): unknown {
  return (mod as { default?: unknown }).default ?? mod;
}

const themeLoaded = new Set<string>();
const langLoaded = new Set<string>();
const langFailed = new Set<string>();

async function ensureTheme(core: CoreHighlighter, appearance: HighlightAppearance): Promise<string | null> {
  const id = THEME_ID[appearance];
  if (!themeLoaded.has(id) && !core.getLoadedThemes().includes(id)) {
    const loader = THEME_LOADERS[id];
    if (!loader) return null;
    try {
      await core.loadTheme(moduleDefault(await loader()));
      themeLoaded.add(id);
    } catch {
      return null;
    }
  }
  return id;
}

async function ensureLang(core: CoreHighlighter, langId: string): Promise<string | null> {
  if (langFailed.has(langId)) return null;
  if (!langLoaded.has(langId) && !core.getLoadedLanguages().includes(langId)) {
    const loader = LANG_LOADERS[langId];
    if (!loader) {
      langFailed.add(langId);
      return null;
    }
    try {
      await core.loadLanguage(moduleDefault(await loader()));
      langLoaded.add(langId);
    } catch {
      langFailed.add(langId);
      return null;
    }
  }
  return langId;
}

/**
 * Highlight a whole blob into per-line token arrays. Returns `null` when
 * highlighting is unavailable (shiki failed to load, no grammar for the file,
 * grammar/theme load failed, or tokenizing threw) — callers then render plain
 * text. Never throws.
 */
export async function highlightBlob(
  code: string,
  path: string,
  appearance: HighlightAppearance
): Promise<HighlightedLine[] | null> {
  const langId = languageForPath(path);
  if (!langId) return null;
  const core = await getCore();
  if (!core) return null;
  try {
    const theme = await ensureTheme(core, appearance);
    if (!theme) return null;
    const lang = await ensureLang(core, langId);
    if (!lang) return null;
    const result = core.codeToTokens(code, { lang, theme });
    return result.tokens.map((line) => line.map((tok) => ({ content: tok.content, color: tok.color })));
  } catch {
    return null;
  }
}

/** Test seam: reset the module-level highlighter caches. */
export function __resetHighlightCachesForTest(): void {
  corePromise = null;
  themeLoaded.clear();
  langLoaded.clear();
  langFailed.clear();
}
