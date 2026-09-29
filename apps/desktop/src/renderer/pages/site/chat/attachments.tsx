import type { ReactElement, ReactNode } from "react";

import type { ImageAttachmentPayload } from "@sitepilot/contracts";

import { pdfToReferencePages } from "../../../pdf-pages.js";

export const MAX_IMAGE_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
// Matches the Gutenberg v2 staged media limit for one asset.
const MAX_VIDEO_BYTES = 10_000_000;
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const MAX_IMAGE_DIMENSION = 1280;
const IMAGE_JPEG_QUALITY = 0.82;

export function formatAttachmentCount(count: number): string {
  return `${count} image${count === 1 ? "" : "s"}`;
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Failed to read ${file.name}.`));
    };
    image.src = objectUrl;
  });
}

async function fileToImageAttachment(
  file: File,
  preserveOriginal: boolean
): Promise<ImageAttachmentPayload> {
  if (preserveOriginal) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error(`Failed to read ${file.name}.`));
      };
      reader.onerror = () => {
        reject(new Error(`Failed to read ${file.name}.`));
      };
      reader.readAsDataURL(file);
    });

    return {
      fileName: file.name,
      mediaType: file.type || "image/jpeg",
      sizeBytes: file.size,
      dataUrl
    };
  }

  const image = await loadImageElement(file);
  const scale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(image.width, image.height)
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(`Failed to process ${file.name}.`);
  }
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);

  const base64 = dataUrl.split(",")[1] ?? "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const sizeBytes = (base64.length * 3) / 4 - padding;

  return new Promise((resolve) => {
    resolve({
      fileName: file.name,
      mediaType: "image/jpeg",
      sizeBytes,
      dataUrl
    });
  });
}

export function summarizeImageAttachment(
  attachment: ImageAttachmentPayload
): Record<string, unknown> {
  return {
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes
  };
}

/**
 * Checks type and size limits for picked files. Returns the first error
 * message, or null when every file is acceptable.
 */
export function validateAttachmentFiles(files: File[]): string | null {
  for (const file of files) {
    const isPdf = file.type === "application/pdf";
    const isVideo = VIDEO_TYPES.has(file.type);
    if (!isPdf && !isVideo && !file.type.startsWith("image/")) {
      return `${file.name} is not an image, MP4/WebM video or PDF.`;
    }
    if (isVideo && file.size > MAX_VIDEO_BYTES) {
      return `${file.name} is larger than 10 MB, the current video limit.`;
    }
    if (!isVideo && file.size > (isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
      return `${file.name} is larger than ${isPdf ? "20" : "8"} MB.`;
    }
  }
  return null;
}

/**
 * Converts validated files into attachment payloads. Throws if a file cannot
 * be read; `notes` carries non-fatal messages such as truncated PDFs.
 */
export async function prepareAttachments(
  files: File[],
  preserveOriginalImageUploads: boolean
): Promise<{ attachments: ImageAttachmentPayload[]; notes: string[] }> {
  const notes: string[] = [];
  const attachments: ImageAttachmentPayload[] = [];
  for (const file of files) {
    if (file.type === "application/pdf") {
      // PDFs are layout/content references: each page becomes an image
      // the planner reads; nothing from them is uploaded to the site.
      const { pages, totalPages } = await pdfToReferencePages(file);
      attachments.push(...pages);
      if (totalPages > pages.length) {
        notes.push(
          `${file.name}: only the first ${pages.length} of ${totalPages} pages are used.`
        );
      }
    } else {
      // Videos are never re-encoded; images may be resized unless the
      // operator prefers originals.
      attachments.push(
        await fileToImageAttachment(
          file,
          VIDEO_TYPES.has(file.type) || preserveOriginalImageUploads
        )
      );
    }
  }
  return { attachments, notes };
}

type AttachmentGridProps = {
  attachments: ImageAttachmentPayload[];
  keyFor: (attachment: ImageAttachmentPayload, index: number) => string;
  renderActions?:
    | ((attachment: ImageAttachmentPayload, index: number) => ReactNode)
    | undefined;
};

export function AttachmentGrid({
  attachments,
  keyFor,
  renderActions
}: AttachmentGridProps): ReactElement {
  return (
    <div className="chat-image-grid">
      {attachments.map((attachment, index) => (
        <figure key={keyFor(attachment, index)} className="chat-image-card">
          {attachment.mediaType.startsWith("video/") ? (
            <video
              src={attachment.dataUrl}
              aria-label={attachment.fileName}
              className="chat-image-preview"
              controls
              muted
              preload="metadata"
            />
          ) : (
            <img
              src={attachment.dataUrl}
              alt={attachment.fileName}
              className="chat-image-preview"
            />
          )}
          <figcaption className="small-print">{attachment.fileName}</figcaption>
          {renderActions ? renderActions(attachment, index) : null}
        </figure>
      ))}
    </div>
  );
}
