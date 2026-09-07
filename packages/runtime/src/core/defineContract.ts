import type * as Rpc from "./rpc.js";
import type { PanelContract, EventSchemaMap } from "./types.js";

/**
 * Helper to define a panel contract with proper type inference.
 *
 * @example
 * ```ts
 * interface MyChildMethods {
 *   doSomething(): Promise<void>;
 * }
 *
 * export const myContract = defineContract({
 *   source: "panels/my-panel",
 *   child: {
 *     methods: {} as MyChildMethods,
 *     emits: {
 *       "done": z.object({ result: z.string() }),
 *     },
 *   },
 * });
 * ```
 */
export function defineContract<
  ChildMethods extends Record<string, Rpc.AnyFunction> = {},
  ChildEmits extends EventSchemaMap = {},
  ParentMethods extends Record<string, Rpc.AnyFunction> = {},
  ParentEmits extends EventSchemaMap = {},
>(contract: {
  source: string;
  child?: {
    methods?: ChildMethods;
    emits?: ChildEmits;
  };
  parent?: {
    methods?: ParentMethods;
    emits?: ParentEmits;
  };
}): PanelContract<ChildMethods, ChildEmits, ParentMethods, ParentEmits> {
  return contract as PanelContract<ChildMethods, ChildEmits, ParentMethods, ParentEmits>;
}
