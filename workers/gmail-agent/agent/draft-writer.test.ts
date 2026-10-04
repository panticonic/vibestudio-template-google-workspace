import { fauxAssistantMessage } from "@panticonic/pi-ai";
import { describe, expect, it } from "vitest";
import { generateDraftReplyBody, modelReplyText } from "./draft-writer.js";

const thread = {
  id: "thread:one",
  messages: [
    {
      id: "mail:one",
      threadId: "thread:one",
      snippet: "Original request",
      payload: { headers: [{ name: "Subject", value: "Original subject" }] },
    },
  ],
};

describe("prepared Gmail reply consumption", () => {
  it("passes the original thread context to the actual prepared dispatcher", async () => {
    const text = await generateDraftReplyBody({
      thread,
      generate: async (context) => {
        expect(context.messages[0]).toMatchObject({ role: "user" });
        expect(context.messages[0]?.content).toContain("Original subject");
        expect(context.messages[0]?.content).toContain("Original request");
        return fauxAssistantMessage("  Actual reply  ");
      },
    });
    expect(text).toBe("Actual reply");
  });
  it("propagates the original protected preparation or dispatch failure", async () => {
    const original = new Error("original credential admission failure");
    await expect(
      generateDraftReplyBody({
        thread,
        generate: async () => {
          throw original;
        },
      }),
    ).rejects.toBe(original);
  });
  for (const stopReason of ["error", "aborted"] as const) {
    it(`does not manufacture a draft or triage result after actual provider ${stopReason}`, async () => {
      const response = fauxAssistantMessage("", {
        stopReason,
        errorMessage: "exact provider failure",
      });
      expect(() => modelReplyText(response)).toThrow("exact provider failure");
      await expect(
        generateDraftReplyBody({ thread, generate: async () => response }),
      ).rejects.toThrow("exact provider failure");
    });
  }
  it("preserves the existing empty successful reply fallback", async () => {
    expect(
      await generateDraftReplyBody({
        thread,
        generate: async () => fauxAssistantMessage(""),
      }),
    ).toBe("Thanks for the note. I will take a look and follow up shortly.");
  });
});
