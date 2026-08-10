import { describe, expect, it, vi } from "vitest";
import type { CredentialClient, UrlCredentialHandle } from "@workspace/runtime/credentials";
import { createCalendarClient } from "./calendar.js";

function clientWith(fetch: UrlCredentialHandle["fetch"]) {
  const forAudience = vi.fn(async () => ({ credentialId: "google", fetch }));
  return {
    client: createCalendarClient({ forAudience } as unknown as CredentialClient),
    forAudience,
  };
}

describe("Google Calendar client", () => {
  it("memoizes its credential handle across calls", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [{ id: "primary", summary: "Primary" }] }), {
          headers: { "content-type": "application/json" },
        })
    );
    const { client, forAudience } = clientWith(fetch);

    await client.listCalendars();
    await client.listEvents("primary");
    await client.listCalendars();

    expect(forAudience).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns undefined for successful deletion responses", async () => {
    const { client } = clientWith(vi.fn(async () => new Response(null, { status: 204 })));
    await expect(client.deleteEvent("primary", "evt-1")).resolves.toBeUndefined();
  });
});
