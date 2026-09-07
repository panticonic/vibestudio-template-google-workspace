// The shell extension runs under Node, never the DOM. In the shared workspace
// type-check (`workspace/tsconfig.json`) DOM and Node libs are both active, so the
// global `setInterval`/`setTimeout` return type is ambiguous (DOM `number` vs Node
// `NodeJS.Timeout`) and DOM units' file ordering can flip which one wins. These
// helpers pin the Node return type so `.unref()` is always available here.
export function nodeSetTimeout(handler: (...args: unknown[]) => void, ms?: number): NodeJS.Timeout {
  return setTimeout(handler, ms) as unknown as NodeJS.Timeout;
}

export function nodeSetInterval(handler: (...args: unknown[]) => void, ms?: number): NodeJS.Timeout {
  return setInterval(handler, ms) as unknown as NodeJS.Timeout;
}
