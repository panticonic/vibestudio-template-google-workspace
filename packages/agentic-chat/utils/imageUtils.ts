/**
 * Browser-side image utilities for the chat UI
 */

import type { AttachmentInput, Attachment } from "@workspace/pubsub";
import {
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  isImageMimeType,
  formatBytes,
} from "@workspace/pubsub";

// Re-export constants and utilities from pubsub
export { SUPPORTED_IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, isImageMimeType, formatBytes };
export type { AttachmentInput, Attachment };
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * Read a File as Uint8Array
 */
export async function fileToUint8Array(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Convert a File to an AttachmentInput (no ID - server assigns IDs)
 */
export async function fileToAttachmentInput(file: File): Promise<AttachmentInput> {
  const data = await fileToUint8Array(file);
  return {
    data,
    mimeType: file.type,
    name: file.name,
  };
}

/**
 * Validate a single image file
 */
export function validateImageFile(file: File): { valid: boolean; error?: string } {
  if (!isImageMimeType(file.type)) {
    return {
      valid: false,
      error: `Unsupported image type: ${file.type}. Supported: ${SUPPORTED_IMAGE_TYPES.join(", ")}`,
    };
  }

  if (file.size > MAX_IMAGE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `Image too large: ${sizeMB}MB exceeds ${maxMB}MB limit (${file.name})`,
    };
  }

  return { valid: true };
}

/**
 * Validate multiple image files
 */
export function validateImageFiles(files: File[]): { valid: boolean; error?: string } {
  let totalSize = 0;

  for (const file of files) {
    const result = validateImageFile(file);
    if (!result.valid) {
      return result;
    }
    totalSize += file.size;
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
 * Filter and validate files from a FileList or DataTransfer
 */
export function filterImageFiles(files: FileList | File[]): File[] {
  const fileArray = Array.from(files);
  return fileArray.filter((f) => isImageMimeType(f.type));
}

/**
 * Create an object URL for previewing an image
 */
export function createImagePreviewUrl(data: Uint8Array, mimeType: string): string {
  // Cast to fix ArrayBufferLike vs ArrayBuffer type mismatch
  const blob = new Blob([data as BlobPart], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Revoke an object URL to free memory
 */
export function revokeImagePreviewUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/**
 * Get images from clipboard paste event
 */
export function getImagesFromClipboard(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];

  const images: File[] = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        images.push(file);
      }
    }
  }
  return images;
}

/**
 * Get images from drag event
 */
export function getImagesFromDragEvent(event: DragEvent): File[] {
  const files = event.dataTransfer?.files;
  if (!files) return [];
  return filterImageFiles(files);
}

/** Counter for generating local IDs (for React keys only, not attachment IDs) */
let localIdCounter = 0;

/**
 * Pending image for preview before sending.
 * Note: localId is for React keys only - the server will assign real attachment IDs.
 */
export interface PendingImage {
  /** Local ID for React keys (NOT the attachment ID - server assigns those) */
  localId: number;
  file: File;
  previewUrl: string;
  attachmentInput: AttachmentInput;
}

/**
 * Create a pending image from a file
 */
export async function createPendingImage(file: File): Promise<PendingImage> {
  const attachmentInput = await fileToAttachmentInput(file);
  const previewUrl = createImagePreviewUrl(attachmentInput.data, attachmentInput.mimeType);
  return {
    localId: ++localIdCounter,
    file,
    previewUrl,
    attachmentInput,
  };
}

/**
 * Clean up pending images (revoke URLs)
 */
export function cleanupPendingImages(images: PendingImage[]): void {
  for (const image of images) {
    revokeImagePreviewUrl(image.previewUrl);
  }
}
