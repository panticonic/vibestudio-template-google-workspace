// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, expect, it, vi } from "vitest";
import { TemplateBrowser, TemplateWorkspaceReview } from "./templates";
import { sameWorkspaceTemplatePin } from "@vibestudio/service-schemas/templates";
const pin = {
  url: "git+https://example.test/garden.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}` as const,
};
const inspection = {
  pin,
  presentation: { name: "Garden" },
  repositories: ["panels/garden"],
  files: [],
};
afterEach(cleanup);
it("captures the reviewed source and name once while creation is pending", async () => {
  let finish!: () => void;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <Theme>
      <TemplateWorkspaceReview inspection={inspection} onCreate={onCreate} />
    </Theme>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "my-garden" },
  });
  const button = screen.getByRole("button", { name: "Create workspace" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith("my-garden", pin);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Workspace name",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  finish();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Workspace name",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false),
  );
});
it("does not let a stale source inspection replace the currently requested source", async () => {
  let finishOld!: (value: typeof inspection) => void;
  const nextPin = { ...pin, commit: "c".repeat(40) };
  const client = {
    inspect: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...inspection,
        pin: nextPin,
        presentation: { name: "Next garden" },
      }),
  };
  const onCreate = vi.fn(async () => undefined);
  const view = render(
    <Theme>
      <TemplateBrowser client={client} initialPin={pin} onCreate={onCreate} />
    </Theme>,
  );
  act(() => {
    view.rerender(
      <Theme>
        <TemplateBrowser
          client={client}
          initialInspection={undefined}
          initialPin={nextPin}
          onCreate={onCreate}
        />
      </Theme>,
    );
  });
  await screen.findByRole("heading", { name: "Next garden" });
  await act(async () => {
    finishOld(inspection);
  });
  await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  });
  expect(onCreate).toHaveBeenCalledWith("next-garden", nextPin);
});
it("withdraws a reviewed source when its requested pin changes", async () => {
  let finishNext!: (value: typeof inspection) => void;
  const nextPin = { ...pin, commit: "d".repeat(40) };
  expect(sameWorkspaceTemplatePin(pin, nextPin)).toBe(false);
  const client = {
    inspect: vi.fn(
      () =>
        new Promise<typeof inspection>((resolve) => {
          finishNext = resolve;
        }),
    ),
  };
  const onCreate = vi.fn(async () => undefined);
  const view = render(
    <Theme>
      <TemplateBrowser
        client={client}
        initialInspection={inspection}
        onCreate={onCreate}
      />
    </Theme>,
  );
  expect(screen.getByRole("heading", { name: "Garden" })).toBeTruthy();
  await act(async () => {
    view.rerender(
      <Theme>
        <TemplateBrowser
          client={client}
          initialPin={nextPin}
          onCreate={onCreate}
        />
      </Theme>,
    );
  });
  expect(screen.queryByRole("heading", { name: "Garden" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  await act(async () => {
    finishNext({ ...inspection, pin: nextPin });
  });
  await screen.findByRole("heading", { name: "Garden" });
});
it("allows ordinary panels to inspect and request host review without creating a workspace", async () => {
  const onOpenInApp = vi.fn(async () => undefined);
  const client = {
    inspect: vi.fn(async () => inspection),
  };
  render(
    <Theme>
      <TemplateBrowser
        client={client}
        initialPin={pin}
        onOpenInApp={onOpenInApp}
      />
    </Theme>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue in app" }),
  );
  expect(onOpenInApp).toHaveBeenCalledWith(inspection);
  expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
});

it("presents the exact pending review and retries only when requested", async () => {
  const failure = Object.assign(new Error("internal extension status"), {
    code: "EREVIEWPENDING",
    errorData: {
      authorityFailure: {
        reasonCode: "review-pending",
        remediation: {
          kind: "resolve-open-review",
          review: { approvalId: "review-templates", title: "System tools" },
        },
      },
    },
  });
  const client = {
    inspect: vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(inspection),
  };
  const onReviewPending = vi.fn();
  render(
    <Theme>
      <TemplateBrowser
        client={client}
        initialPin={pin}
        onReviewPending={onReviewPending}
      />
    </Theme>,
  );
  await screen.findByText("Waiting for you to finish reviewing System tools.");
  expect(screen.queryByText("internal extension status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open review" }));
  expect(onReviewPending).toHaveBeenCalledWith("review-templates");
  expect(client.inspect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
});

it("presents a queued runtime acquisition instead of its wrapped error", async () => {
  const failure = Object.assign(
    new Error("Extension templates.inspect invocation failed"),
    {
      code: "EACQUIRE",
      errorKind: "access",
      errorData: {
        acquisition: {
          acquisitionId: "acq-templates-network",
          ownerRuntimeId: "panel-system",
          snapshotDigest: "snapshot",
          capability: "network.response.read",
          resourceKey: "https://github.com",
          tier: "gated",
          cardType: "permission.gated",
          renderedAction: "read responses from github.com",
          pending: true,
        },
        authorityFailure: { reasonCode: "approval-required" },
      },
    },
  );
  const client = {
    inspect: vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(inspection),
  };
  const onReviewPending = vi.fn();
  render(
    <Theme>
      <TemplateBrowser
        client={client}
        initialPin={pin}
        onReviewPending={onReviewPending}
      />
    </Theme>,
  );
  await screen.findByText(
    "Your approval is needed to read responses from github.com.",
  );
  expect(
    screen.queryByText("Extension templates.inspect invocation failed"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open approval" }));
  expect(onReviewPending).toHaveBeenCalledWith("acq-templates-network");
  expect(client.inspect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
});

it("rejects an inspection response that differs from the selected exact source", async () => {
  const client = {
    inspect: vi.fn().mockResolvedValue({
      ...inspection,
      pin: { ...pin, commit: "c".repeat(40) },
    }),
  };
  const onCreate = vi.fn();
  render(
    <Theme>
      <TemplateBrowser client={client} initialPin={pin} onCreate={onCreate} />
    </Theme>,
  );
  await screen.findByText(
    "The inspected source does not match the selected workspace. Review the source again.",
  );
  expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  expect(onCreate).not.toHaveBeenCalled();
});

it("prefills a website Git URL and requires review before creation", async () => {
  const client = { inspect: vi.fn().mockResolvedValue(inspection) };
  const onCreate = vi.fn();
  render(
    <Theme>
      <TemplateBrowser
        client={client}
        initialSourceUrl="https://example.test/garden.git"
        onCreate={onCreate}
      />
    </Theme>,
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Workspace source address",
      }) as HTMLInputElement
    ).value,
  ).toBe("https://example.test/garden.git");
  expect(client.inspect).not.toHaveBeenCalled();
  expect(onCreate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review workspace" }));
  await screen.findByRole("button", { name: "Create workspace" });
  expect(client.inspect).toHaveBeenCalledWith({
    url: "https://example.test/garden.git",
  });
  expect(onCreate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith("garden", pin));
});

it("replaces a source session on a new link and leaves a local review with Back", async () => {
  const client = { inspect: vi.fn() };
  const onCreate = vi.fn();
  const view = render(
    <Theme>
      <TemplateBrowser
        client={client}
        initialInspection={inspection}
        onCreate={onCreate}
      />
    </Theme>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  view.rerender(
    <Theme>
      <TemplateBrowser
        client={client}
        initialSourceUrl="https://example.test/second.git"
        onCreate={onCreate}
      />
    </Theme>,
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Workspace source address",
      }) as HTMLInputElement
    ).value,
  ).toBe("https://example.test/second.git");
  expect(client.inspect).not.toHaveBeenCalled();
  expect(onCreate).not.toHaveBeenCalled();
});

it("reviews picked folder bytes without remote inspection and treats cancellation as no selection", async () => {
  const client = { inspect: vi.fn() };
  const onChooseFolder = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(inspection);
  const onCreate = vi.fn();
  render(
    <Theme>
      <TemplateBrowser
        client={client}
        onChooseFolder={onChooseFolder}
        onCreate={onCreate}
      />
    </Theme>,
  );
  fireEvent.click(screen.getByRole("radio", { name: /Folder/ }));
  expect(screen.queryByText("Start from an example")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Choose folder…" })
        .getAttribute("disabled"),
    ).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Create workspace" }),
  );
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith("garden", pin));
  expect(client.inspect).not.toHaveBeenCalled();
});
