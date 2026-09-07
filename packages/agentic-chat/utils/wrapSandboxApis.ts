/**
 * wrapSandboxApis — wrap the chat API for async error reporting.
 *
 * Each async method is wrapped via `trackPromise` so that if the compiled
 * component awaits the call without try/catch, the unhandled rejection is
 * caught and routed to `onError` (which typically completes the feedback or
 * shows a visual error).
 *
 * If the component handles the rejection itself, nothing extra happens.
 */

import { trackPromise } from "@workspace/tool-ui/utils/trackAsyncErrors";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import type { ScopesApi } from "@workspace/eval";

/**
 * Return a ChatSandboxValue where every async method is tracked.
 */
export function wrapChatForErrorReporting(
  chat: ChatSandboxValue,
  onError: (err: Error) => void
): ChatSandboxValue {
  return {
    ...chat,
    send: (...args: Parameters<ChatSandboxValue["send"]>) =>
      trackPromise(chat.send(...args), onError),
    publish: (...args: Parameters<ChatSandboxValue["publish"]>) =>
      trackPromise(chat.publish(...args), onError),
    publishCustomMessage: (...args: Parameters<ChatSandboxValue["publishCustomMessage"]>) =>
      trackPromise(chat.publishCustomMessage(...args), onError),
    updateCustomMessage: (...args: Parameters<ChatSandboxValue["updateCustomMessage"]>) =>
      trackPromise(chat.updateCustomMessage(...args), onError),
    getParticipants: (...args: Parameters<ChatSandboxValue["getParticipants"]>) =>
      trackPromise(chat.getParticipants(...args), onError),
    replayEnvelope: (...args: Parameters<ChatSandboxValue["replayEnvelope"]>) =>
      trackPromise(chat.replayEnvelope(...args), onError),
    participantByHandle: (...args: Parameters<ChatSandboxValue["participantByHandle"]>) =>
      trackPromise(chat.participantByHandle(...args), onError),
    callMethod: (...args: Parameters<ChatSandboxValue["callMethod"]>) =>
      trackPromise(chat.callMethod(...args), onError),
    callMethodResult: (...args: Parameters<ChatSandboxValue["callMethodResult"]>) =>
      trackPromise(chat.callMethodResult(...args), onError),
    callMethodByHandle: (...args: Parameters<ChatSandboxValue["callMethodByHandle"]>) =>
      trackPromise(chat.callMethodByHandle(...args), onError),
    callMethodResultByHandle: (...args: Parameters<ChatSandboxValue["callMethodResultByHandle"]>) =>
      trackPromise(chat.callMethodResultByHandle(...args), onError),
    focusMessage: (...args: Parameters<ChatSandboxValue["focusMessage"]>) =>
      trackPromise(chat.focusMessage(...args), onError),
    rpc: {
      call: (...args: Parameters<ChatSandboxValue["rpc"]["call"]>) =>
        trackPromise(chat.rpc.call(...args), onError),
    },
  };
}

export function wrapScopesForErrorReporting(
  scopes: ScopesApi,
  onError: (err: Error) => void
): ScopesApi {
  return {
    get currentId() {
      return scopes.currentId;
    },
    push: () => trackPromise(scopes.push(), onError),
    get: (...args: Parameters<ScopesApi["get"]>) => trackPromise(scopes.get(...args), onError),
    list: () => trackPromise(scopes.list(), onError),
    save: () => trackPromise(scopes.save(), onError),
  };
}
