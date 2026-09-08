// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ImageAsset } from "@workspace/runtime/images";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@workspace/runtime", () => ({ images: {} }));
vi.mock("@workspace/runtime/image-loader", () => ({
  createImageLoader: () => ({ load: mocks.load }),
}));
import { GeneratedImage } from "../GeneratedImage.js";
afterEach(() => {
  cleanup();
  mocks.load.mockReset();
});
const asset = (id: string) => ({ id }) as ImageAsset;
it("shows dynamically selected assets and ignores late completion of an obsolete scene", async () => {
  const pending = new Map<string, (value: any) => void>();
  mocks.load.mockImplementation(
    (asset: ImageAsset) => new Promise((resolve) => pending.set(asset.id, resolve))
  );
  const oldRelease = vi.fn(),
    newRelease = vi.fn();
  const view = render(
    <GeneratedImage asset={asset("old")} alt="Current scene" data-testid="scene" />
  );
  expect(screen.getByRole("status").textContent).toContain("Loading");
  view.rerender(<GeneratedImage asset={asset("new")} alt="Current scene" data-testid="scene" />);
  await act(async () => {
    pending.get("new")!({ url: "blob:new", release: newRelease });
  });
  expect(screen.getByTestId("scene").getAttribute("src")).toBe("blob:new");
  await act(async () => {
    pending.get("old")!({ url: "blob:old", release: oldRelease });
  });
  expect(screen.getByTestId("scene").getAttribute("src")).toBe("blob:new");
  expect(oldRelease).toHaveBeenCalledOnce();
  view.unmount();
  expect(newRelease).toHaveBeenCalledOnce();
});
it("renders explicit errors and recovers when the selected asset changes", async () => {
  mocks.load.mockRejectedValueOnce(new Error("missing asset"));
  const view = render(<GeneratedImage asset={asset("missing")} alt="Scene" />);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not"));
  mocks.load.mockResolvedValueOnce({ url: "blob:valid", release: vi.fn() });
  view.rerender(<GeneratedImage asset={asset("valid")} alt="Scene" />);
  await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("blob:valid"));
});
