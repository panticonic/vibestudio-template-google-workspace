import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { ParticipantDescriptor } from "@workspace/harness";

import { AiChatWorker } from "./ai-chat-worker.js";
import { SilentAgentWorker } from "../silent-agent-worker/index.js";

const STANDARD_METHODS = [
  "pause",
  "resume",
  "connectModelCredential",
  "setModel",
  "setThinkingLevel",
  "setApprovalLevel",
  "setRespondPolicy",
  "getAgentSettings",
  "getModelExecutionEvidence",
  "getDebugState",
];

class ContractAiChatWorker extends AiChatWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("ch-1");
  }
}

class ContractSilentAgentWorker extends SilentAgentWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("ch-1");
  }
}

describe("agent worker contracts", () => {
  it.each([
    [
      "AI chat",
      async () => (await createTestDO(ContractAiChatWorker)).instance,
    ],
    [
      "Silent",
      async () => (await createTestDO(ContractSilentAgentWorker)).instance,
    ],
  ] satisfies Array<
    [string, () => Promise<{ participant(): ParticipantDescriptor }>]
  >)(
    "%s exposes the standard agent control methods",
    async (_name, createWorker) => {
      const methodNames = (await createWorker())
        .participant()
        .methods?.map((method) => method.name);

      expect(methodNames).toEqual(expect.arrayContaining(STANDARD_METHODS));
    },
  );
});
