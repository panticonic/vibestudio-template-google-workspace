/**
 * ImageInput component for uploading, dragging, and pasting images
 */

import { useCallback, useRef, useState, useEffect } from "react";
import { Box, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import { ImageIcon, Cross2Icon, PlusIcon } from "@radix-ui/react-icons";
import type { AttachmentInput } from "@workspace/pubsub";
import {
  type PendingImage,
  createPendingImage,
  cleanupPendingImages,
  validateImageFiles,
  filterImageFiles,
  getImagesFromDragEvent,
  formatBytes,
  SUPPORTED_IMAGE_TYPES,
} from "../utils/imageUtils";

interface ImageInputProps {
  /** Currently pending images */
  images: PendingImage[];
  /** Callback when images change */
  onImagesChange: (images: PendingImage[]) => void;
  /** Error callback for validation failures */
  onError?: (error: string) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Maximum number of images allowed */
  maxImages?: number;
}

export function ImageInput({
  images,
  onImagesChange,
  onError,
  disabled = false,
  maxImages = 10,
}: ImageInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const previousImagesRef = useRef<PendingImage[]>([]);
  const imagesRef = useRef<PendingImage[]>(images);

  // Track latest images for unmount cleanup
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // Cleanup URLs for removed images
  useEffect(() => {
    const removed = previousImagesRef.current.filter(
      (prev) => !images.some((img) => img.localId === prev.localId)
    );
    if (removed.length > 0) {
      cleanupPendingImages(removed);
    }
    previousImagesRef.current = images;
  }, [images]);

  // Cleanup URLs on unmount
  useEffect(() => {
    return () => {
      cleanupPendingImages(imagesRef.current);
    };
  }, []);

  const addImages = useCallback(
    async (files: File[]) => {
      const imageFiles = filterImageFiles(files);

      if (imageFiles.length === 0) {
        onError?.("No valid image files found");
        return;
      }

      // Check max images limit
      if (images.length + imageFiles.length > maxImages) {
        onError?.(`Maximum ${maxImages} images allowed`);
        return;
      }

      // Validate files
      const validation = validateImageFiles(imageFiles);
      if (!validation.valid) {
        onError?.(validation.error!);
        return;
      }

      // Create pending images
      const newImages: PendingImage[] = [];
      for (const file of imageFiles) {
        try {
          const pending = await createPendingImage(file);
          newImages.push(pending);
        } catch (err) {
          onError?.(`Failed to process ${file.name}: ${err}`);
        }
      }

      onImagesChange([...images, ...newImages]);
    },
    [images, onImagesChange, onError, maxImages]
  );

  const removeImage = useCallback(
    (localId: number) => {
      const image = images.find((img) => img.localId === localId);
      if (image) {
        URL.revokeObjectURL(image.previewUrl);
      }
      onImagesChange(images.filter((img) => img.localId !== localId));
    },
    [images, onImagesChange]
  );

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        void addImages(Array.from(files));
      }
      // Reset input so same file can be selected again
      event.target.value = "";
    },
    [addImages]
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);

      if (disabled) return;

      const files = getImagesFromDragEvent(event.nativeEvent);
      if (files.length > 0) {
        void addImages(files);
      }
    },
    [disabled, addImages]
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const acceptTypes = SUPPORTED_IMAGE_TYPES.join(",");

  return (
    <Flex direction="column" gap="2">
      {/* Image previews */}
      {images.length > 0 && (
        <Flex gap="2" wrap="wrap">
          {images.map((image) => (
            <Box key={image.localId} position="relative">
              <img
                src={image.previewUrl}
                alt={image.file.name}
                width={64}
                height={64}
                style={{ objectFit: "cover", borderRadius: "var(--radius-2)" }}
              />
              {/* Show pending indicator */}
              <Box
                position="absolute"
                bottom="0"
                left="0"
                px="1"
                style={{
                  background: "rgba(0,0,0,0.7)",
                  borderTopRightRadius: "var(--radius-1)",
                  borderBottomLeftRadius: "var(--radius-2)",
                  maxWidth: "100%",
                  overflow: "hidden",
                }}
              >
                <Text size="1" style={{ color: "var(--amber-9)", fontFamily: "monospace", fontSize: "9px" }}>
                  pending
                </Text>
              </Box>
              <Tooltip content={`${image.file.name} (${formatBytes(image.file.size)})`}>
                <IconButton
                  size="1"
                  variant="soft"
                  color="gray"
                  radius="full"
                  style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18 }}
                  onClick={() => removeImage(image.localId)}
                >
                  <Cross2Icon width={10} height={10} />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
          {images.length < maxImages && (
            <Tooltip content="Add more images">
              <IconButton
                size="4"
                variant="soft"
                color="gray"
                disabled={disabled}
                onClick={openFilePicker}
              >
                <PlusIcon width={24} height={24} />
              </IconButton>
            </Tooltip>
          )}
        </Flex>
      )}

      {/* Drop zone (only visible when no images or dragging) */}
      {(images.length === 0 || isDragging) && (
        <Box
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${isDragging ? "var(--accent-9)" : "var(--gray-6)"}`,
            borderRadius: "var(--radius-2)",
            padding: "12px",
            textAlign: "center",
            background: isDragging ? "var(--accent-2)" : "transparent",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.5 : 1,
            transition: "all 0.15s ease",
          }}
          onClick={disabled ? undefined : openFilePicker}
        >
          <Flex direction="column" align="center" gap="1">
            <ImageIcon width={20} height={20} style={{ color: "var(--gray-9)" }} />
            <Text size="1" color="gray">
              {isDragging ? "Drop images here" : "Click or drop images (paste also works)"}
            </Text>
          </Flex>
        </Box>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptTypes}
        multiple
        onChange={handleFileSelect}
        style={{ display: "none" }}
      />
    </Flex>
  );
}

/**
 * Compact image button for inline use in message input
 */
interface ImageButtonProps {
  onClick: () => void;
  disabled?: boolean;
  hasImages?: boolean;
  imageCount?: number;
}

export function ImageButton({ onClick, disabled = false, hasImages = false, imageCount = 0 }: ImageButtonProps) {
  return (
    <Tooltip content={hasImages ? `${imageCount} image(s) attached` : "Attach images"}>
      <IconButton
        size="1"
        variant={hasImages ? "solid" : "ghost"}
        color={hasImages ? "blue" : "gray"}
        disabled={disabled}
        onClick={onClick}
      >
        <ImageIcon />
        {hasImages && imageCount > 0 && (
          <Text size="1" style={{ marginLeft: 2 }}>
            {imageCount}
          </Text>
        )}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Get attachment inputs from pending images (for sending - server assigns IDs)
 */
export function getAttachmentInputsFromPendingImages(images: PendingImage[]): AttachmentInput[] {
  return images.map((img) => img.attachmentInput);
}
