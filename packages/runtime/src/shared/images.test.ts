import { describe, it, expect, vi } from "vitest";
import { createImagesClient } from "./images.js";
function setup(states: string[]) {
  const call = vi.fn(async (_target: string, method: string) => {
    if (method === "workers.resolveService")
      return {
        kind: "durable-object",
        source: "workers/images",
        className: "ImagesDO",
        objectKey: "default",
        targetId: "do:images",
      };
    if (method === "getJob") return { id: "job:one", status: states.shift() ?? "succeeded" };
    if (method === "readAsset")
      return { asset: { id: "asset:one", mimeType: "image/png" }, base64: "AP8=" };
    throw new Error(`Unexpected method: ${method}`);
  });
  return { client: createImagesClient({ call } as never), call };
}
describe("durable image runtime client", () => {
  it("resolves the workspace service and waits for a terminal job without initiating generation", async () => {
    const { client, call } = setup(["queued", "running", "succeeded"]);
    await expect(client.wait("job:one", { intervalMs: 10 })).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(call.mock.calls.filter((c) => c[1] === "workers.resolveService")).toHaveLength(1);
    expect(call.mock.calls.some((c) => c[1] === "generate")).toBe(false);
  });
  it("aborting an observer leaves the durable job alive", async () => {
    const { client, call } = setup(["running"]);
    const controller = new AbortController();
    const promise = client.wait("job:one", { signal: controller.signal, intervalMs: 10 });
    controller.abort(new Error("panel closed"));
    await expect(promise).rejects.toThrow("panel closed");
    expect(call.mock.calls.some((c) => c[1] === "cancel")).toBe(false);
  });
  it("fetches bytes through authorized asset identity, never bare digest", async () => {
    const { client, call } = setup([]);
    expect(await client.getBytes({ id: "asset:one" })).toEqual(new Uint8Array([0, 255]));
    expect(call).toHaveBeenLastCalledWith("do:images", "readAsset", ["asset:one"]);
  });
  it("rejects corrupt persisted asset metadata before decoding", async () => {
    const { client } = setup([]);
    await expect(client.getBytes({ id: "asset:one", mimeType: "image/jpeg" })).rejects.toThrow(
      "inconsistent mimeType"
    );
  });
  it.each(["failed", "cancelled"])("returns a terminal %s job immediately", async (status) => {
    const { client, call } = setup([status]);
    await expect(client.wait("job:one")).resolves.toMatchObject({ status });
    expect(call.mock.calls.filter((entry) => entry[1] === "getJob")).toHaveLength(1);
  });
});
