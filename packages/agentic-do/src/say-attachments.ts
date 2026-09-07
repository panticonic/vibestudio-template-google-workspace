/**
 * Attachment loading for the `notify` tool — resolves working-tree file paths
 * into base64 channel attachments (see ChannelAttachment in channel-client.ts).
 * Image-only for now: the chat panel renders message attachments through its
 * image gallery, so accepting other types would silently show nothing.
 */
import {
    SUPPORTED_IMAGE_TYPES,
    uint8ArrayToBase64,
    validateAttachments,
} from "@workspace/pubsub";
import type { ChannelAttachment } from "./channel-client.js";

/** The one fs capability the loader needs (satisfied by createRpcFs). */
interface AttachmentFs {
    readFile(path: string): Promise<string | Uint8Array>;
}

function sniffImageMimeType(bytes: Uint8Array): string | undefined {
    if (
        bytes.length >= 4 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    ) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (bytes.length >= 6) {
        const gif = String.fromCharCode(...bytes.slice(0, 6));
        if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
    }
    if (bytes.length >= 12) {
        const riff = String.fromCharCode(...bytes.slice(0, 4));
        const webp = String.fromCharCode(...bytes.slice(8, 12));
        if (riff === "RIFF" && webp === "WEBP") return "image/webp";
    }
    return undefined;
}

function attachmentMimeType(path: string, bytes: Uint8Array): string {
    const mimeType = sniffImageMimeType(bytes);
    if (!mimeType) {
        throw new Error(
            `say attachment "${path}": unsupported file content — attachments must be images (${SUPPORTED_IMAGE_TYPES.join(", ")})`
        );
    }
    return mimeType;
}

export async function readSayAttachments(
    fs: AttachmentFs,
    paths: string[]
): Promise<Array<Required<Pick<ChannelAttachment, "id" | "data" | "mimeType" | "size">> & { name: string }>> {
    const loaded = await Promise.all(
        paths.map(async (path, index) => {
            let contents: string | Uint8Array;
            try {
                contents = await fs.readFile(path);
            } catch (error) {
                throw new Error(
                    `say attachment "${path}": ${error instanceof Error ? error.message : String(error)}`
                );
            }
            if (typeof contents === "string") {
                throw new Error(`say attachment "${path}": expected binary image data, got text`);
            }
            const mimeType = attachmentMimeType(path, contents);
            const name = path.split("/").filter(Boolean).pop() ?? path;
            return { id: `att_${index}`, bytes: contents, mimeType, name };
        })
    );
    const validation = validateAttachments(
        loaded.map((attachment) => ({
            id: attachment.id,
            data: attachment.bytes,
            mimeType: attachment.mimeType,
            name: attachment.name,
        }))
    );
    if (!validation.valid) throw new Error(`say attachments: ${validation.error}`);
    return loaded.map((attachment) => ({
        id: attachment.id,
        data: uint8ArrayToBase64(attachment.bytes),
        mimeType: attachment.mimeType,
        name: attachment.name,
        size: attachment.bytes.length,
    }));
}
