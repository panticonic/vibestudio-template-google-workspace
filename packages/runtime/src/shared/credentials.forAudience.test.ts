import type { RpcCaller } from "@vibestudio/rpc";
import {
  createCredentialClient,
  type CredentialClient,
  type StoredCredentialSummary,
  type UrlAudienceDescriptor,
} from "./credentials.js";

function makeRpc(
  resolve: (input: { url: string; credentialId?: string }) => StoredCredentialSummary | null
): { rpc: RpcCaller; resolveCalls: Array<{ url: string; credentialId?: string }> } {
  const resolveCalls: Array<{ url: string; credentialId?: string }> = [];
  const rpc: RpcCaller = {
    call: (async <T = unknown>(_targetId: string, method: string, args: unknown[]): Promise<T> => {
      if (method === "credentials.resolveCredential") {
        const input = args[0] as { url: string; credentialId?: string };
        resolveCalls.push(input);
        return resolve(input) as unknown as T;
      }
      throw new Error(`unexpected method: ${method}`);
    }) as RpcCaller["call"],
    stream: async () => new Response(),
  };
  return { rpc, resolveCalls };
}

function summary(id: string, audience: string): StoredCredentialSummary {
  return {
    id,
    label: `Test credential ${id}`,
    providerId: "test",
    accountIdentity: { providerUserId: id },
    audience: [{ url: audience, match: "origin" }],
    injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
    bindings: [],
    scopes: [],
    metadata: {},
    createdAt: Date.now(),
  } as unknown as StoredCredentialSummary;
}

const desc = (overrides: Partial<UrlAudienceDescriptor> = {}): UrlAudienceDescriptor => ({
  audiences: [{ url: "https://api.example.com/", match: "origin" }],
  ...overrides,
});

describe("CredentialClient.forAudience", () => {
  it("returns a handle pre-bound to the first matching credential", async () => {
    const cred = summary("cred-1", "https://api.example.com/");
    const { rpc } = makeRpc(() => cred);
    const client: CredentialClient = createCredentialClient(rpc);

    const handle = await client.forAudience(desc());

    expect(handle.credentialId).toBe("cred-1");
    expect(typeof handle.fetch).toBe("function");
  });

  it("walks the audience list and uses the first match", async () => {
    const cred = summary("cred-fallback", "https://fallback.example.com/");
    const { rpc, resolveCalls } = makeRpc((input) => {
      // First audience misses, second hits.
      if (input.url === "https://primary.example.com/") return null;
      if (input.url === "https://fallback.example.com/") return cred;
      return null;
    });
    const client: CredentialClient = createCredentialClient(rpc);

    const handle = await client.forAudience({
      audiences: [
        { url: "https://primary.example.com/", match: "origin" },
        { url: "https://fallback.example.com/", match: "origin" },
      ],
    });

    expect(handle.credentialId).toBe("cred-fallback");
    expect(resolveCalls.map((c) => c.url)).toEqual([
      "https://primary.example.com/",
      "https://fallback.example.com/",
    ]);
  });

  it("throws a descriptive error when no audience matches", async () => {
    const { rpc } = makeRpc(() => null);
    const client: CredentialClient = createCredentialClient(rpc);

    await expect(
      client.forAudience({
        audiences: [{ url: "https://api.example.com/", match: "origin" }],
        label: "Example API",
      })
    ).rejects.toThrow(/No URL-bound credential found for Example API/);
  });

  it("includes the audience URL in the error message when no label is given", async () => {
    const { rpc } = makeRpc(() => null);
    const client: CredentialClient = createCredentialClient(rpc);

    await expect(
      client.forAudience({
        audiences: [{ url: "https://api.example.com/", match: "origin" }],
      })
    ).rejects.toThrow(/https:\/\/api\.example\.com\//);
  });

  it("forwards an explicit credentialId pin on each resolve call", async () => {
    const cred = summary("specific-id", "https://api.example.com/");
    const { rpc, resolveCalls } = makeRpc((input) =>
      input.credentialId === "specific-id" ? cred : null
    );
    const client: CredentialClient = createCredentialClient(rpc);

    const handle = await client.forAudience({
      audiences: [{ url: "https://api.example.com/", match: "origin" }],
      credentialId: "specific-id",
    });

    expect(handle.credentialId).toBe("specific-id");
    expect(resolveCalls[0]?.credentialId).toBe("specific-id");
  });

  it("returned handle's `fetch` injects the credentialId into proxyFetch", async () => {
    const cred = summary("cred-x", "https://api.example.com/");
    const proxyCalls: unknown[] = [];
    const rpc: RpcCaller = {
      call: (async <T = unknown>(
        _targetId: string,
        method: string,
        _args: unknown[]
      ): Promise<T> => {
        if (method === "credentials.resolveCredential") return cred as unknown as T;
        throw new Error(`unexpected method: ${method}`);
      }) as RpcCaller["call"],
      stream: async (_target: string, method: string, args: unknown[]) => {
        proxyCalls.push({ method, args });
        return new Response("", { status: 200, statusText: "OK" });
      },
    };
    const client: CredentialClient = createCredentialClient(rpc);
    const handle = await client.forAudience(desc());
    await handle.fetch("https://api.example.com/things");

    expect(proxyCalls).toHaveLength(1);
    const call = proxyCalls[0] as { method: string; args: unknown[] };
    expect(call.method).toBe("credentials.proxyFetch");
    const fetchArgs = call.args[0] as { url: string; credentialId?: string };
    expect(fetchArgs.url).toBe("https://api.example.com/things");
    expect(fetchArgs.credentialId).toBe("cred-x");
  });
});

describe("CredentialClient.summarizeStoredCredentials", () => {
  it("returns only aggregate count and lifecycle-state evidence", async () => {
    const records = [
      {
        ...summary("active-1", "https://one.example/"),
        lifecycle: { state: "active", canRefresh: false },
      },
      {
        ...summary("active-2", "https://two.example/"),
        lifecycle: { state: "active", canRefresh: true },
      },
      {
        ...summary("expired-1", "https://three.example/"),
        lifecycle: { state: "expired", canRefresh: false },
      },
    ] satisfies StoredCredentialSummary[];
    const rpc: RpcCaller = {
      call: (async <T = unknown>(_targetId: string, method: string): Promise<T> => {
        if (method === "credentials.summarizeStoredCredentials") {
          return {
            credentialCount: records.length,
            lifecycleStates: ["active", "expired"],
            stateCounts: { active: 2, expired: 1 },
          } as unknown as T;
        }
        throw new Error(`unexpected method: ${method}`);
      }) as RpcCaller["call"],
      stream: async () => new Response(),
    };

    await expect(createCredentialClient(rpc).summarizeStoredCredentials()).resolves.toEqual({
      credentialCount: 3,
      lifecycleStates: ["active", "expired"],
      stateCounts: { active: 2, expired: 1 },
    });
  });
});
