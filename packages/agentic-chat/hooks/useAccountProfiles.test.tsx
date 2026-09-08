// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RpcBoundaryError } from "@vibestudio/rpc";
import { useAccountProfiles } from "./useAccountProfiles";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("retains profile attribution through an outage and refreshes after recovery", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const profile = { userId: "alice", handle: "alice", displayName: "Alice" };
  const updated = { ...profile, displayName: "Alice Updated" };
  const denied = new RpcBoundaryError("Denied", "access", "ACCESS_DENIED");
  const call = vi
    .fn()
    .mockResolvedValueOnce({ alice: profile })
    .mockRejectedValueOnce(
      new RpcBoundaryError("Offline", "transport", "CONNECTION_LOST"),
    )
    .mockResolvedValueOnce({ alice: updated })
    .mockRejectedValueOnce(denied);
  const { result, unmount } = renderHook(() =>
    useAccountProfiles({ call }, ["user:alice"]),
  );
  await act(async () => {});
  expect(result.current.get("user:alice")).toEqual(profile);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(result.current.get("user:alice")).toEqual(profile);
  expect(warn).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(result.current.get("user:alice")).toEqual(updated);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(warn).toHaveBeenCalledWith(
    "[useAccountProfiles] Failed to resolve profiles:",
    denied,
  );
  unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(call).toHaveBeenCalledTimes(4);
});
