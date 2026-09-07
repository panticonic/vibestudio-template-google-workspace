/**
 * `@workspace/quickfire-core` — the platform-neutral half of the quickfire
 * overlay (quickfire-overlay-spec).
 *
 * The root entry is pure: view model, palette projection, and the built-in
 * slate's definitions. `./transcript` and `./session` are separate entry points
 * because the desktop overlay *surface* imports the model but must not pull the
 * channel client into its bundle.
 */
export * from "./model";
export * from "./markdown";
export * from "./cards";
export * from "./links";
export * from "./openers";
export * from "./palette";
export * from "./slateDefinitions";
