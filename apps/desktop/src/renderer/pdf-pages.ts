import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type { ImageAttachmentPayload } from "@sitepilot/contracts";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Pages beyond this are not sent; long documents are summarised by page 6. */
export const MAX_PDF_PAGES = 6;
const PAGE_WIDTH_PX = 1400;
const PAGE_JPEG_QUALITY = 0.85;

/**
 * Render a PDF's pages to JPEG images in the renderer, as layout references
 * for the planner. Nothing is uploaded; the pages travel like image
 * attachments marked `purpose: "reference"`.
 */
export async function pdfToReferencePages(
  file: File
): Promise<{ pages: ImageAttachmentPayload[]; totalPages: number }> {
  const document = await getDocument({
    data: new Uint8Array(await file.arrayBuffer())
  }).promise;
  try {
    const count = Math.min(document.numPages, MAX_PDF_PAGES);
    const pages: ImageAttachmentPayload[] = [];
    for (let number = 1; number <= count; number += 1) {
      const page = await document.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PAGE_WIDTH_PX / base.width });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error(`Failed to render ${file.name}.`);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", PAGE_JPEG_QUALITY);
      const base64 = dataUrl.split(",")[1] ?? "";
      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
      pages.push({
        fileName: `${file.name} (page ${number} of ${document.numPages})`,
        mediaType: "image/jpeg",
        sizeBytes: (base64.length * 3) / 4 - padding,
        dataUrl,
        purpose: "reference"
      });
      page.cleanup();
    }
    return { pages, totalPages: document.numPages };
  } finally {
    await document.destroy();
  }
}
