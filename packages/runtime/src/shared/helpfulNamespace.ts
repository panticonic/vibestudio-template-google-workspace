export function helpfulNamespace<T extends object>(name: string, obj: T): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const known = Object.keys(target).join(", ");
      throw new TypeError(
        `${name}.${String(prop)} is not available. Known members on ${name}: ${known}. ` +
        "Call `await help()` for the live surface.",
      );
    },
  });
}
