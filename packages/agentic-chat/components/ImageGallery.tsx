/**
 * ImageGallery component for displaying images in chat messages
 */

import { useState, useEffect, useMemo } from "react";
import { Box, Button, Dialog, Flex, IconButton, Text } from "@radix-ui/themes";
import { Cross2Icon, DownloadIcon, ImageIcon, ZoomInIcon } from "@radix-ui/react-icons";
import type { Attachment } from "@workspace/pubsub";
import { formatBytes, createImagePreviewUrl, revokeImagePreviewUrl, isImageMimeType } from "../utils/imageUtils";

interface ImageGalleryProps {
  attachments: Attachment[];
  /** Maximum number of images to show in collapsed view */
  maxVisible?: number;
}

interface ImagePreview {
  url: string;
  attachment: Attachment;
}

export function ImageGallery({ attachments, maxVisible = 4 }: ImageGalleryProps) {
  const [selectedImage, setSelectedImage] = useState<ImagePreview | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Filter to only image attachments
  const imageAttachments = useMemo(
    () => attachments.filter((a) => isImageMimeType(a.mimeType)),
    [attachments]
  );

  // Create preview URLs for visible images
  const [previews, setPreviews] = useState<ImagePreview[]>([]);

  useEffect(() => {
    const newPreviews: ImagePreview[] = imageAttachments.map((attachment) => ({
      url: createImagePreviewUrl(attachment.data, attachment.mimeType),
      attachment,
    }));
    setPreviews(newPreviews);

    // Cleanup URLs on unmount or when attachments change
    return () => {
      newPreviews.forEach((p) => revokeImagePreviewUrl(p.url));
    };
  }, [imageAttachments]);

  if (imageAttachments.length === 0) {
    return null;
  }

  const visiblePreviews = showAll ? previews : previews.slice(0, maxVisible);
  const hiddenCount = previews.length - maxVisible;

  const handleDownload = (preview: ImagePreview) => {
    const link = document.createElement("a");
    link.href = preview.url;
    link.download = preview.attachment.name || `image.${preview.attachment.mimeType.split("/")[1]}`;
    link.click();
  };

  const isSingle = imageAttachments.length === 1;
  const thumbSize = 120;

  return (
    <>
      {!expanded ? (
        <Flex mt="2">
          <Button
            size="1"
            variant="soft"
            color="gray"
            onClick={() => setExpanded(true)}
            title="Show attached images"
          >
            <ImageIcon />
            {imageAttachments.length} attached image{imageAttachments.length > 1 ? "s" : ""}
          </Button>
        </Flex>
      ) : (
      <Flex gap="2" wrap="wrap" mt="2">
        {visiblePreviews.map((preview, index) => (
          <Box
            key={index}
            position="relative"
            overflow="hidden"
            tabIndex={0}
            style={{ cursor: "pointer", borderRadius: "var(--radius-2)" }}
            onClick={() => setSelectedImage(preview)}
          >
            <img
              src={preview.url}
              alt={preview.attachment.name || `Image ${index + 1}`}
              width={isSingle ? undefined : thumbSize}
              height={isSingle ? undefined : thumbSize}
              style={{
                maxWidth: isSingle ? "min(400px, 100%)" : `min(${thumbSize}px, calc(50% - 8px))`,
                maxHeight: isSingle ? 300 : thumbSize,
                objectFit: "cover",
                display: "block",
              }}
            />
            {/* Show attachment ID badge */}
            <Box
              position="absolute"
              top="0"
              left="0"
              px="1"
              style={{ background: "rgba(0,0,0,0.7)", borderBottomRightRadius: "var(--radius-2)" }}
            >
              <Text size="1" style={{ color: "white", fontFamily: "monospace" }}>
                {preview.attachment.id}
              </Text>
            </Box>
            {!isSingle && (
              <Box
                position="absolute"
                bottom="0"
                left="0"
                right="0"
                p="1"
                style={{ background: "rgba(0,0,0,0.6)" }}
              >
                <Text size="1" style={{ color: "white" }}>
                  {formatBytes(preview.attachment.data.length)}
                </Text>
              </Box>
            )}
          </Box>
        ))}
        {!showAll && hiddenCount > 0 && (
          <Flex
            align="center"
            justify="center"
            width="120px"
            height="120px"
            tabIndex={0}
            style={{ background: "var(--gray-4)", borderRadius: "var(--radius-2)", cursor: "pointer" }}
            onClick={() => setShowAll(true)}
          >
            <Text size="3" weight="bold" color="gray">
              +{hiddenCount}
            </Text>
          </Flex>
        )}
      </Flex>
      )}

      {/* Lightbox dialog */}
      <Dialog.Root open={selectedImage !== null} onOpenChange={(open) => !open && setSelectedImage(null)}>
        <Dialog.Content maxWidth="90vw" style={{ maxHeight: "90dvh", padding: 0 }}>
          {selectedImage && (
            <Flex direction="column" height="100%">
              {/* Header */}
              <Flex justify="between" align="center" p="3">
                <Flex gap="2" align="center">
                  <Text size="1" style={{ fontFamily: "monospace", background: "var(--gray-4)", padding: "2px 6px", borderRadius: "var(--radius-1)" }}>
                    {selectedImage.attachment.id}
                  </Text>
                  <Text size="2" weight="medium">
                    {selectedImage.attachment.name || "Image"} ({formatBytes(selectedImage.attachment.data.length)})
                  </Text>
                </Flex>
                <Flex gap="2">
                  <IconButton
                    size="2"
                    variant="ghost"
                    onClick={() => handleDownload(selectedImage)}
                    title="Download"
                    style={{ padding: 8 }}
                  >
                    <DownloadIcon />
                  </IconButton>
                  <Dialog.Close>
                    <IconButton size="2" variant="ghost" title="Close" style={{ padding: 8 }}>
                      <Cross2Icon />
                    </IconButton>
                  </Dialog.Close>
                </Flex>
              </Flex>
              {/* Image */}
              <Flex flexGrow="1" align="center" justify="center" p="4" overflow="auto">
                <img
                  src={selectedImage.url}
                  alt={selectedImage.attachment.name || "Image"}
                  style={{ maxWidth: "100%", maxHeight: "calc(90dvh - 80px)", objectFit: "contain" }}
                />
              </Flex>
            </Flex>
          )}
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

/**
 * Compact image indicator for inline display
 */
interface ImageIndicatorProps {
  count: number;
  onClick?: () => void;
}

export function ImageIndicator({ count, onClick }: ImageIndicatorProps) {
  if (count === 0) return null;

  return (
    <Flex
      gap="1"
      align="center"
      px="2"
      py="1"
      tabIndex={0}
      style={{ background: "var(--gray-3)", borderRadius: "var(--radius-2)", cursor: onClick ? "pointer" : undefined }}
      onClick={onClick}
    >
      <ZoomInIcon width={12} height={12} />
      <Text size="1" color="gray">
        {count} image{count > 1 ? "s" : ""}
      </Text>
    </Flex>
  );
}
