// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HostTerminal } from "./HostTerminal.js";

const mocks = vi.hoisted(() => ({ call: vi.fn(), frontend: vi.fn() }));
vi.mock("@workspace/runtime", () => ({ callMain: mocks.call }));
vi.mock("./vscodeTerminalFrontend.js", () => ({
  createVscodeTerminalFrontend: mocks.frontend,
}));
vi.mock("./paneTheme.js", () => ({ resolveTerminalTheme: () => ({}) }));
vi.mock("@radix-ui/themes", () => ({
  Flex: ({
    children,
    onFocusCapture,
    onBlurCapture,
  }: {
    children: ReactNode;
    onFocusCapture?: () => void;
    onBlurCapture?: () => void;
  }) => (
    <div onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>
      {children}
    </div>
  ),
  Text: ({ children, role }: { children: ReactNode; role?: string }) => (
    <span role={role}>{children}</span>
  ),
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick(): void;
    disabled: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
  await act(async () =>
    root.render(
      <HostTerminal
        executionPlatform="linux"
        appearance="dark"
        fontFamily="monospace"
        fontSize={14}
        onFocusChange={() => {}}
      />
    )
  );
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const click = async () => act(async () => container.querySelector("button")!.click());
it("opens only on intent and shows denied approval without launching a frontend", async () => {
  expect(mocks.call).not.toHaveBeenCalled();
  mocks.call.mockRejectedValueOnce(new Error("Full host terminal access was not approved"));
  await click();
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("hostTerminal.open", {
    columns: 120,
    rows: 36,
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("not approved");
  expect(mocks.frontend).not.toHaveBeenCalled();
});
it("closes a terminal when approval finishes after the panel unmounts", async () => {
  let approve!: (value: unknown) => void;
  mocks.call.mockImplementation((method) =>
    method === "hostTerminal.open"
      ? new Promise((resolve) => {
          approve = resolve;
        })
      : Promise.resolve({ processExited: true })
  );
  await click();
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => root.unmount());
  mounted = false;
  await act(async () =>
    approve({
      terminalSessionId: "approved",
      host: "host",
      shell: "sh",
      cwd: "/",
    })
  );
  expect(mocks.call).toHaveBeenLastCalledWith("hostTerminal.close", {
    terminalSessionId: "approved",
  });
  expect(mocks.frontend).not.toHaveBeenCalled();
});
it("labels full host access, renders output and retires its session on close", async () => {
  const dispose = vi.fn();
  const write = vi.fn((_text, done) => done());
  mocks.frontend.mockResolvedValue({
    open() {},
    onInput: () => ({ dispose() {} }),
    onResize: () => ({ dispose() {} }),
    fit() {},
    focus() {},
    setTheme() {},
    dispose,
    write,
  });
  mocks.call.mockImplementation((method) =>
    Promise.resolve(
      method === "hostTerminal.open"
        ? {
            terminalSessionId: "approved",
            host: "my-host",
            shell: "sh",
            cwd: "/",
          }
        : method === "hostTerminal.read"
          ? { text: "output", cursor: 6, alive: true }
          : { processExited: true }
    )
  );
  await click();
  expect(container.textContent).toContain("Host · my-host · Full host access");
  expect(write).toHaveBeenCalledWith("output", expect.any(Function));
  await click();
  expect(mocks.call).toHaveBeenLastCalledWith("hostTerminal.close", {
    terminalSessionId: "approved",
  });
  expect(dispose).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Open host terminal…");
});

it("discloses Windows host permissions without offering a separate host mode", async () => {
  await act(async () =>
    root.render(
      <HostTerminal
        executionPlatform="win32"
        appearance="dark"
        fontFamily="monospace"
        fontSize={14}
        onFocusChange={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "Windows workspace terminals and extensions run with your account's host permissions",
  );
  expect(container.querySelector("button")).toBeNull();
  expect(mocks.call).not.toHaveBeenCalled();
});
