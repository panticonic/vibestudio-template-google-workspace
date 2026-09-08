import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capability,
  evaluateAuthority,
  type AuthorizationContext,
  type AuthorityGrant,
} from "@vibestudio/shared/authorization";
import { parseAuthorityRequests } from "@vibestudio/shared/authorityManifest";

const provider = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

describe("template UI caller authority", () => {
  for (const unit of [
    "panels/chat",
    "about/templates",
    "apps/shell",
    "apps/mobile",
  ]) {
    for (const method of ["inspect"]) {
      it(`${unit} can acquire ${method} authority for the declared receiver only`, () => {
        const manifest = JSON.parse(
          readFileSync(
            new URL(`../../${unit}/package.json`, import.meta.url),
            "utf8",
          ),
        );
        const effect =
          provider.vibestudio.extension.methodAuthority[method].effect;
        const definition = provider.vibestudio.authority.provides.find(
          (item: { name: string }) => item.name === effect.capability,
        );
        const name = `userland:extensions/templates/${definition.name}#${"a".repeat(64)}`;
        const resourceKey = `${definition.resourceType}:extension:${provider.name}`;
        const code = `code:${unit}@${"b".repeat(64)}` as const;
        const context: AuthorizationContext = {
          authorizingOrigin: { kind: "code", principal: code },
          host: null,
          actingUser: "user:alice",
          entity: "entity:panel:one",
          incarnation: "inc:1",
          executingCode: {
            principal: code,
            requested: parseAuthorityRequests(manifest.vibestudio.authority),
            sourceLineage: { class: "internal", externalKeys: [] },
          },
          initiatorChain: ["user:alice", code],
          ownerChain: ["user:alice"],
          agentBinding: null,
          executionSession: null,
          testPolicy: null,
          workspace: {
            workspaceId: "personal",
            member: true,
            role: "member",
            revision: "1",
          },
          session: {
            id: "s1",
            audience: "host",
            version: "2.1",
            expiresAt: 10000,
          },
          contextIntegrity: {
            class: "not-applicable",
            latchEpoch: 0,
            externalKeys: [],
          },
        };
        const input = {
          context,
          requirement: capability("code", name),
          resourceKey,
          now: 100,
        };
        const pending = evaluateAuthority({ ...input, grants: [] });
        expect(pending.allowed).toBe(false);
        expect(pending.code).not.toBe("fixed-code-not-requested");
        const grant: AuthorityGrant = {
          subject: code,
          capability: name,
          resource: { kind: "exact", key: resourceKey },
          effect: "allow",
          issuedBy: "user:alice",
          createdAt: 1,
          provenance: "test",
        };
        expect(evaluateAuthority({ ...input, grants: [grant] }).allowed).toBe(
          true,
        );
        expect(
          evaluateAuthority({
            ...input,
            resourceKey: `${resourceKey}-other`,
            grants: [
              {
                ...grant,
                resource: { kind: "exact", key: `${resourceKey}-other` },
              },
            ],
          }).allowed,
        ).toBe(false);
      });
    }
  }
});
