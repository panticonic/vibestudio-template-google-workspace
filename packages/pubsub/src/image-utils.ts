/**
 * Image processing utilities for agentic messaging
 * Provides validation, conversion, and LLM API format builders
 */

import type { Attachment } from "./types.js";

// Supported image MIME types
export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

// Size limits
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB per image (leaves room for base64 expansion to ~20MB)
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50MB total attachments per message

/**
 * Check if a MIME type is a supported image type
 */
export function isImageMimeType(mimeType: string): mimeType is SupportedImageType {
  return SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType);
}

/**
 * Validation result for attachments
 */
export interface AttachmentValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a single attachment
 */
export function validateAttachment(attachment: Attachment): AttachmentValidationResult {
  if (!isImageMimeType(attachment.mimeType)) {
    return {
      valid: false,
      error: `Unsupported image type: ${attachment.mimeType}. Supported types: ${SUPPORTED_IMAGE_TYPES.join(", ")}`,
    };
  }

  if (attachment.data.length > MAX_IMAGE_BYTES) {
    const sizeMB = (attachment.data.length / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `Image too large: ${sizeMB}MB exceeds ${maxMB}MB limit${attachment.name ? ` (${attachment.name})` : ""}`,
    };
  }

  return { valid: true };
}

/**
 * Validate multiple attachments
 */
export function validateAttachments(attachments: Attachment[]): AttachmentValidationResult {
  let totalSize = 0;

  for (const attachment of attachments) {
    const result = validateAttachment(attachment);
    if (!result.valid) {
      return result;
    }
    totalSize += attachment.data.length;
  }

  if (totalSize > MAX_TOTAL_BYTES) {
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_TOTAL_BYTES / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `Total attachments too large: ${sizeMB}MB exceeds ${maxMB}MB limit`,
    };
  }

  return { valid: true };
}

/**
 * Convert Uint8Array to base64 string
 */
export function uint8ArrayToBase64(data: Uint8Array): string {
  // Node.js environment
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  // Browser environment
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  // Node.js environment
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  // Browser environment
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Claude API image block format
 */
export interface ClaudeImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: SupportedImageType;
    data: string;
  };
}

/**
 * Claude API text block format
 */
export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeImageBlock;

/**
 * Build Claude API content blocks from text and attachments
 */
export function buildClaudeContentBlocks(
  text: string | undefined,
  attachments: Attachment[] | undefined
): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = [];

  // Add image blocks first (Claude prefers images before text for context)
  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      if (isImageMimeType(attachment.mimeType)) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: attachment.mimeType,
            data: uint8ArrayToBase64(attachment.data),
          },
        });
      }
    }
  }

  // Add text block if present
  if (text) {
    blocks.push({
      type: "text",
      text,
    });
  }

  return blocks;
}

/**
 * OpenAI API image content format
 */
export interface OpenAIImageContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

/**
 * OpenAI API text content format
 */
export interface OpenAITextContent {
  type: "text";
  text: string;
}

export type OpenAIContent = OpenAITextContent | OpenAIImageContent;

/**
 * Build OpenAI API content array from text and attachments
 */
export function buildOpenAIContents(
  text: string | undefined,
  attachments: Attachment[] | undefined,
  detail: "auto" | "low" | "high" = "auto"
): OpenAIContent[] {
  const contents: OpenAIContent[] = [];

  // Add text content first (OpenAI convention)
  if (text) {
    contents.push({
      type: "text",
      text,
    });
  }

  // Add image contents
  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      if (isImageMimeType(attachment.mimeType)) {
        const base64 = uint8ArrayToBase64(attachment.data);
        contents.push({
          type: "image_url",
          image_url: {
            url: `data:${attachment.mimeType};base64,${base64}`,
            detail,
          },
        });
      }
    }
  }

  return contents;
}

/**
 * Filter attachments to only include valid images
 */
export function filterImageAttachments(attachments: Attachment[] | undefined): Attachment[] {
  if (!attachments) return [];
  return attachments.filter((a) => isImageMimeType(a.mimeType));
}

/**
 * Get human-readable size string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
