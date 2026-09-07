import { describe, expect, it } from "vitest";
import { transcriptCards } from "./cards";
import type { QuickfireTranscriptEntry } from "./model";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function cards(entries: QuickfireTranscriptEntry[], order?: "newest-first") {
  return transcriptCards(entries, { now: NOW, ...(order ? { order } : {}) });
}

describe("transcript cards", () => {
  it("says what went wrong instead of only colouring the card red", () => {
    const [card] = cards([
      {
        kind: "message",
        id: "m1",
        author: "agent",
        authorLabel: "agent",
        text: "",
        error: true,
        errorText: "rate limited until 12:30",
      },
    ]);
    expect(card?.tone).toBe("danger");
    expect(card?.badges.map((badge) => badge.label)).toContain("failed");
    expect(card?.details).toContainEqual(
      expect.objectContaining({
        label: "What went wrong",
        text: "rate limited until 12:30",
      }),
    );
    // The venue cannot retry, so it names the surface that can.
    expect(card?.actions).toEqual([
      expect.objectContaining({ id: "open-chat" }),
    ]);
  });

  it("names attachments rather than counting them", () => {
    const [card] = cards([
      {
        kind: "message",
        id: "m1",
        author: "you",
        authorLabel: "you",
        text: "look at this",
        attachments: [
          { id: "a1", name: "screenshot.png", kind: "image/png", size: 4096 },
        ],
      },
    ]);
    expect(card?.details[0]?.text).toBe("screenshot.png (image/png · 4 KB)");
  });

  it("keeps a notice's detail out of its heading", () => {
    const [card] = cards([
      {
        kind: "notice",
        id: "n1",
        severity: "error",
        title: "Model unavailable",
        detail: "The provider returned 503. It usually clears within a minute.",
        recoverable: true,
      },
    ]);
    expect(card?.title).toBe("Model unavailable");
    expect(card?.body?.text).toBe(
      "The provider returned 503. It usually clears within a minute.",
    );
    expect(card?.actions[0]?.id).toBe("open-chat");
  });

  it("announces rich content it will not run, and where it can be run", () => {
    const [card] = cards([
      { kind: "rich", id: "r1", title: "Card · chart", detail: "Q3 revenue" },
    ]);
    expect(card?.title).toBe("Card · chart");
    expect(card?.actions).toEqual([
      expect.objectContaining({
        id: "open-chat",
        label: "Open it in the chat panel",
      }),
    ]);
  });

  it("tells a pending approval where it is answered", () => {
    const [card] = cards([
      {
        kind: "approval",
        id: "ap1",
        status: "pending",
        question: "Run `rm -rf build`?",
        reason: "Cleaning the output directory",
      },
    ]);
    expect(card?.meta).toContain("approval card");
    expect(card?.details).toContainEqual(
      expect.objectContaining({ label: "Why" }),
    );
  });

  it("gives each tool call its own state, duration and details", () => {
    const [card] = cards([
      {
        kind: "tool",
        id: "tool:c1",
        call: {
          id: "c1",
          name: "panel_console",
          state: "done",
          durationMs: 1_240,
          output: "[]",
        },
      },
      {
        kind: "tool",
        id: "tool:c2",
        call: {
          id: "c2",
          name: "panel_eval",
          state: "running",
          awaitingApproval: true,
        },
      },
    ]);
    expect(card?.busy).toBe(false);
    expect(card?.work.map((record) => record.statusLabel)).toEqual(["1.2s"]);
    expect(card?.work[0]?.details).toContainEqual(
      expect.objectContaining({ label: "Output" }),
    );
    expect(
      cards([
        {
          kind: "tool",
          id: "tool:c2",
          call: {
            id: "c2",
            name: "panel_eval",
            state: "running",
            awaitingApproval: true,
          },
        },
      ])[0]?.work[0]?.statusLabel,
    ).toBe("waiting for approval");
  });

  it("does not tell the user a background wait is waiting on them", () => {
    const [background] = cards([
      {
        kind: "activity",
        id: "background",
        state: "waiting",
        phase: "waiting",
        waitingFor: "background",
        label: "Waiting for delegated diagnostics",
      },
    ]);
    const [input] = cards([
      {
        kind: "activity",
        id: "input",
        state: "waiting",
        phase: "waiting",
        waitingFor: "user",
        label: "Choose a migration source",
      },
    ]);
    expect(background?.title).toBe("Working in background");
    expect(background?.busy).toBe(true);
    expect(input?.title).toBe("Waiting for you");
  });

  it("groups consecutive turns by the same speaker in either reading order", () => {
    const entries: QuickfireTranscriptEntry[] = [
      {
        kind: "message",
        id: "m1",
        author: "agent",
        authorLabel: "agent",
        text: "one",
      },
      {
        kind: "message",
        id: "m2",
        author: "agent",
        authorLabel: "agent",
        text: "two",
      },
      {
        kind: "message",
        id: "m3",
        author: "you",
        authorLabel: "you",
        text: "three",
      },
    ];
    expect(cards(entries).map((card) => card.continues)).toEqual([
      false,
      true,
      false,
    ]);
    // Newest-first is a rendering choice; who follows whom is not.
    expect(
      cards([...entries].reverse(), "newest-first").map(
        (card) => card.continues,
      ),
    ).toEqual([false, true, false]);
  });

  it("carries model and time on the heading's second line", () => {
    const [card] = cards([
      {
        kind: "message",
        id: "m1",
        author: "agent",
        authorLabel: "agent",
        text: "done",
        modelLabel: "Opus 5",
        at: NOW - 7_200_000,
      },
    ]);
    expect(card?.meta).toBe("Opus 5 · 2h ago");
  });
});

describe("reasoning cards", () => {
  it("says what it thought, not that it thought", () => {
    const [card] = cards([
      {
        kind: "thinking",
        id: "t1",
        text: "The clamp is on the wrapper, not the chart.\nSo the fix is the container.",
      },
    ]);
    expect(card?.title).toBe("The clamp is on the wrapper, not the chart.");
    // The whole reasoning stays behind the disclosure; the heading is a handle.
    expect(card?.details[0]?.text).toContain("So the fix is the container.");
  });

  it("follows a streaming thought to where it currently is", () => {
    const [card] = cards([
      {
        kind: "thinking",
        id: "t1",
        text: "First I check.\nNow I am reading the console.",
        streaming: true,
      },
    ]);
    expect(card?.title).toBe("Now I am reading the console.");
  });

  it("cuts a long thought on a word boundary, never mid-word", () => {
    const text =
      "This is a considerably longer line of reasoning that will not fit inside one heading no matter how the surface is sized";
    const [card] = cards([{ kind: "thinking", id: "t1", text }]);
    const shown = card?.title ?? "";
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(97);
    // What is shown is a prefix of what was thought, and the cut lands where a
    // space was — truncation should read as truncation, not as corruption.
    const kept = shown.slice(0, -1);
    expect(text.startsWith(kept)).toBe(true);
    expect(text[kept.length]).toBe(" ");
  });
});
