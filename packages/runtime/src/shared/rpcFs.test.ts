import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "@vibestudio/rpc";
import { createRpcFs } from "./rpcFs.js";

function decode(env: unknown): Uint8Array {
  return base64ToBytes((env as { data: string }).data);
}

function mockRpc() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rpc = {
    call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === "fs.open") return { handleId: 7 };
      if (method === "fs.handleWrite") return { bytesWritten: decode(args[1]).length };
      if (method === "fs.writeFile" || method === "fs.appendFile") return undefined;
      throw new Error(`unexpected rpc ${method}`);
    }),
  };
  return { rpc, calls };
}

describe("createRpcFs transport lifetime", () => {
  it("does not impose an implicit deadline on a filesystem operation", async () => {
    let resolve!: (value: { size: number }) => void;
    const rpc = {
      call: vi.fn().mockImplementation(() => new Promise<{ size: number }>((r) => (resolve = r))),
    };
    const fs = createRpcFs(rpc as never);
    const pending = fs.stat("slow-but-valid");
    await Promise.resolve();
    expect(rpc.call).toHaveBeenCalledWith("main", "fs.stat", ["slow-but-valid"]);
    resolve({ size: 7 });
    await expect(pending).resolves.toMatchObject({ size: 7 });
  });

  it("forwards explicit owner cancellation without inventing a deadline", async () => {
    const controller = new AbortController();
    const rpc = { call: vi.fn(async () => ({ size: 1 })) };
    const fs = createRpcFs(rpc as never, { signal: controller.signal });
    await fs.stat("cancel-aware");
    expect(rpc.call).toHaveBeenCalledWith("main", "fs.stat", ["cancel-aware"], {
      signal: controller.signal,
    });
  });

  it("reports settled operation latency without changing its lifetime", async () => {
    const telemetry: unknown[] = [];
    const rpc = { call: vi.fn(async () => ({ size: 1 })) };
    const fs = createRpcFs(rpc as never, { onTelemetry: (event) => telemetry.push(event) });
    await fs.stat("ready");
    expect(telemetry).toEqual([
      expect.objectContaining({ method: "stat", phase: "settled", outcome: "ok" }),
    ]);
  });

  it("does not let a telemetry observer change filesystem semantics", async () => {
    const rpc = { call: vi.fn(async () => ({ size: 1 })) };
    const fs = createRpcFs(rpc as never, {
      onTelemetry: () => {
        throw new Error("observer failed");
      },
    });

    await expect(fs.stat("ready")).resolves.toMatchObject({ size: 1 });
  });
});

describe("createRpcFs binary file writes", () => {
  it("returns portable bytes without relying on a Buffer global", async () => {
    const rpc = {
      call: vi.fn(async () => ({ __bin: true, data: bytesToBase64(new Uint8Array([0, 1, 255])) })),
    };
    const priorBuffer = globalThis.Buffer;
    try {
      Object.defineProperty(globalThis, "Buffer", { configurable: true, value: undefined });
      const fs = createRpcFs(rpc as never);
      await expect(fs.readFile("/f.bin")).resolves.toEqual(new Uint8Array([0, 1, 255]));
    } finally {
      Object.defineProperty(globalThis, "Buffer", { configurable: true, value: priorBuffer });
    }
  });

  it("passes existing binary envelopes through without double encoding", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const envelope = { __bin: true as const, data: bytesToBase64(new Uint8Array([0, 1, 255])) };

    await fs.writeFile("/f.bin", envelope);

    const write = calls.find((c) => c.method === "fs.writeFile")!;
    expect(write.args[0]).toBe("/f.bin");
    expect(write.args[1]).toBe(envelope);
  });

  it("encodes ArrayBuffer and DataView payloads for file writes", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    const backing = new Uint8Array([9, 8, 7, 6]).buffer;
    const view = new DataView(backing, 1, 2);

    await fs.writeFile("/array.bin", arrayBuffer);
    await fs.appendFile("/view.bin", view);

    const arrayWrite = calls.find((c) => c.method === "fs.writeFile")!;
    const viewAppend = calls.find((c) => c.method === "fs.appendFile")!;
    expect([...decode(arrayWrite.args[1])]).toEqual([1, 2, 3]);
    expect([...decode(viewAppend.args[1])]).toEqual([8, 7]);
  });
});

describe("createRpcFs temporary paths", () => {
  it("composes Node-style mkdtemp from the scoped temp-path and mkdir operations", async () => {
    const rpc = {
      call: vi.fn().mockResolvedValueOnce("/.tmp/probe-123").mockResolvedValueOnce(undefined),
    };
    const fs = createRpcFs(rpc as never);

    await expect(fs.mkdtemp("probe")).resolves.toBe("/.tmp/probe-123");
    expect(rpc.call).toHaveBeenNthCalledWith(1, "main", "fs.mktemp", ["probe"]);
    expect(rpc.call).toHaveBeenNthCalledWith(2, "main", "fs.mkdir", [
      "/.tmp/probe-123",
      { recursive: true },
    ]);
  });
});

describe("createRpcFs directory listings", () => {
  it("forwards recursive listings through the injected runtime contract", async () => {
    const rpc = {
      call: vi.fn(async () => ["src", "src/index.ts"]),
    };
    const fs = createRpcFs(rpc as never);

    await expect(fs.readdir("/", { recursive: true })).resolves.toEqual(["src", "src/index.ts"]);
    expect(rpc.call).toHaveBeenCalledWith("main", "fs.readdir", ["/", { recursive: true }]);
  });
});

describe("createRpcFs FileHandle.write (Node-parity)", () => {
  it("encodes a string arg as utf-8 and treats the 2nd arg as the file position", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const fh = await fs.open("/f.txt", "w");

    const res = await fh.write("héllo", 12); // write(string, position)

    const w = calls.find((c) => c.method === "fs.handleWrite")!;
    expect(new TextDecoder().decode(decode(w.args[1]))).toBe("héllo"); // encoded, not `buffer.subarray`-crashed
    expect(w.args[2]).toBe(12); // 2nd arg is POSITION for the string overload
    expect(res.bytesWritten).toBe(new TextEncoder().encode("héllo").length);
  });

  it("still writes a Uint8Array slice with offset/length/position", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const fh = await fs.open("/f.bin", "w");

    await fh.write(new Uint8Array([1, 2, 3, 4, 5]), 1, 3, 99); // write(buffer, offset, length, position)

    const w = calls.find((c) => c.method === "fs.handleWrite")!;
    expect([...decode(w.args[1])]).toEqual([2, 3, 4]);
    expect(w.args[2]).toBe(99);
  });

  it("writes ArrayBuffer views using their own byte window before offset slicing", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const fh = await fs.open("/f.bin", "w");
    const backing = new Uint8Array([9, 8, 7, 6, 5]).buffer;
    const view = new DataView(backing, 1, 3);

    await fh.write(view, 1, 2, 44);

    const w = calls.find((c) => c.method === "fs.handleWrite")!;
    expect([...decode(w.args[1])]).toEqual([7, 6]);
    expect(w.args[2]).toBe(44);
  });
});
