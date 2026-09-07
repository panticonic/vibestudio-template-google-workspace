import { describe, expect, it, vi } from "vitest";
import { normalizeSandboxSendOptions, sendSandboxText } from "./sandboxSend.js";

describe("normalizeSandboxSendOptions", () => {
  it("preserves structured interaction metadata", () => {
    const metadata = {
      interaction: {
        source: "onboarding-setup-hub",
        kind: "onboarding-capability",
        action: "setup",
        targetId: "connection.github",
      },
    };

    expect(
      normalizeSandboxSendOptions(
        {
          idempotencyKey: "chosen",
          tier: "primary",
          mentions: ["agent:helm", "agent:engineering"],
          replyTo: "message:briefing",
          metadata,
        },
        "fallback"
      )
    ).toEqual({
      idempotencyKey: "chosen",
      tier: "primary",
      mentions: ["agent:helm", "agent:engineering"],
      replyTo: "message:briefing",
      metadata,
    });
  });

  it("uses the send-and-backfill publisher for rendered UI messages", async () => {
    const publishText = vi.fn(async () => undefined);
    const metadata = {
      interaction: {
        source: "onboarding-setup-hub",
        kind: "onboarding-capability",
        action: "setup",
        targetId: "migration.browser-environment",
      },
    };

    await sendSandboxText(publishText, "Set up Browser import", { metadata }, "interaction-id");

    expect(publishText).toHaveBeenCalledWith("Set up Browser import", {
      idempotencyKey: "interaction-id",
      tier: "secondary",
      metadata,
    });
  });
});
