/**
 * Content type constants for agentic messaging.
 *
 * These constants are used as `contentType` values in messages
 * to indicate the kind of content being sent.
 */

/**
 * Content type constant for thinking/reasoning messages.
 * Use this when sending messages with `contentType` to ensure consistency.
 */
export const CONTENT_TYPE_THINKING = "thinking" as const;

/**
 * Content type constant for action messages.
 * Actions represent active agent operations (reading files, running commands, etc.)
 */
export const CONTENT_TYPE_ACTION = "action" as const;

/**
 * Content type constant for inline UI components.
 * Used for rendering dynamic MDX/React components inline in the conversation.
 * Unlike feedback_custom which renders at the bottom and waits for input,
 * inline_ui renders immediately in the message stream.
 */
export const CONTENT_TYPE_INLINE_UI = "inline_ui" as const;

/**
 * Content type constant for runtime-registered custom message renderers.
 */
export const CONTENT_TYPE_CUSTOM = "custom" as const;

