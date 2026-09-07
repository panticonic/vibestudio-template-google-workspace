/**
 * Hook for managing feedback UI components and their lifecycle.
 * Handles state management for active feedback components with add/remove/dismiss/error operations.
 */

import { useReducer, useEffect, useCallback } from "react";
import type { ActiveFeedback } from "../types";

/**
 * Feedback reducer manages active feedback UI components and their lifecycle.
 * Handles add, remove, and cleanup-on-unmount actions idiomatically.
 */
function feedbackReducer(
  state: Map<string, ActiveFeedback>,
  action:
    | { type: "add"; payload: ActiveFeedback }
    | { type: "remove"; payload: string }
    | { type: "dismiss"; payload: string }
    | { type: "error"; payload: { callId: string; error: Error } }
    | { type: "cleanup-all" }
): Map<string, ActiveFeedback> {
  switch (action.type) {
    case "add": {
      const next = new Map(state);
      next.set(action.payload.callId, action.payload);
      return next;
    }
    case "remove": {
      const next = new Map(state);
      next.delete(action.payload);
      return next;
    }
    case "dismiss": {
      const feedback = state.get(action.payload);
      if (feedback) {
        // User dismissed = cancel (not an error)
        // complete() will call removeFeedback() which removes from map
        feedback.complete({ type: "cancel" });
      }
      // Don't remove here - the complete callback handles removal via removeFeedback()
      return state;
    }
    case "error": {
      const feedback = state.get(action.payload.callId);
      if (feedback) {
        // Component render error
        // complete() will call removeFeedback() which removes from map
        feedback.complete({ type: "error", message: `Component render error: ${action.payload.error.message}` });
      }
      // Don't remove here - the complete callback handles removal via removeFeedback()
      return state;
    }
    case "cleanup-all": {
      // Cleanup all remaining feedbacks on unmount.
      // We immediately clear the map and call complete() on each.
      // The complete callbacks will dispatch remove actions, but those are
      // no-ops on the already-empty map.
      for (const feedback of state.values()) {
        feedback.complete({ type: "error", message: "Panel closed" });
      }
      return new Map();
    }
    default:
      return state;
  }
}

export interface UseFeedbackManagerResult {
  activeFeedbacks: Map<string, ActiveFeedback>;
  addFeedback: (feedback: ActiveFeedback) => void;
  removeFeedback: (callId: string) => void;
  dismissFeedback: (callId: string) => void;
  handleFeedbackError: (callId: string, error: Error) => void;
}

/**
 * Hook for managing feedback UI components.
 * Provides methods to add, remove, dismiss, and handle errors for feedback components.
 */
export function useFeedbackManager(): UseFeedbackManagerResult {
  const [activeFeedbacks, dispatch] = useReducer(feedbackReducer, new Map());

  // Cleanup feedback components on unmount
  useEffect(() => {
    return () => {
      dispatch({ type: "cleanup-all" });
    };
  }, []);

  const addFeedback = useCallback((feedback: ActiveFeedback) => {
    dispatch({ type: "add", payload: feedback });
  }, []);

  const removeFeedback = useCallback((callId: string) => {
    dispatch({ type: "remove", payload: callId });
  }, []);

  const dismissFeedback = useCallback((callId: string) => {
    dispatch({ type: "dismiss", payload: callId });
  }, []);

  const handleFeedbackError = useCallback((callId: string, error: Error) => {
    dispatch({ type: "error", payload: { callId, error } });
  }, []);

  return {
    activeFeedbacks,
    addFeedback,
    removeFeedback,
    dismissFeedback,
    handleFeedbackError,
  };
}
