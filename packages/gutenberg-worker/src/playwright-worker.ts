import { randomUUID } from "node:crypto";

import {
  gutenbergV2BlockPlanSchema,
  gutenbergV2EditorCapabilitySnapshotSchema,
  gutenbergV2EditorCompileResultSchema,
  gutenbergV2EditorPreviewRequestSchema,
  gutenbergV2EditorPreviewResultSchema,
  gutenbergV2EditorVerifyRequestSchema,
  gutenbergV2ReadbackSchema,
  gutenbergV2SourceSnapshotSchema,
  gutenbergV2ValidationReportSchema,
  type GutenbergV2BlockPlan,
  type GutenbergV2EditorCapabilitySnapshot,
  type GutenbergV2MediaMapping,
  type GutenbergV2SourceSnapshot,
  type GutenbergV2ValidationReport
} from "@sitepilot/contracts";
import {
  detectGutenbergV2MediaType,
  hashGutenbergV2Bytes,
  hashGutenbergV2Content,
  hashGutenbergV2PreviewMediaManifest,
  hashGutenbergV2Value,
  type GutenbergV2PreviewMediaResolver,
  type GutenbergV2Worker,
  type GutenbergV2WorkerCompileResult
} from "@sitepilot/services";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page
} from "playwright";

import type { GutenbergV2ReviewArtifactStore } from "./review-artifact-store.js";
import type { GutenbergV2EditorSessionProvider } from "./session-client.js";
import { GutenbergV2WorkerError } from "./worker-error.js";

export type PlaywrightGutenbergV2WorkerOptions = {
  siteUrl: string;
  sessionProvider: GutenbergV2EditorSessionProvider;
  reviewArtifacts: GutenbergV2ReviewArtifactStore;
  previewMedia?: GutenbergV2PreviewMediaResolver;
  browserFactory?: () => Promise<Browser>;
  launchOptions?: LaunchOptions;
  allowedAssetOrigins?: string[];
  ignoreHTTPSErrors?: boolean;
  maxConcurrentJobs?: number;
  jobTimeoutMs?: number;
};

type EditorContextInput = {
  executionId: string;
  siteId: string;
  postType: "post" | "page";
  postId?: number;
  expectedFingerprint?: string;
};

const MAX_REVIEW_SCREENSHOT_HEIGHT = 24_000;
const MAX_REVIEW_SCREENSHOT_PIXELS = 40_000_000;
const MAX_REVIEW_SCREENSHOT_BYTES = 20_000_000;

function pngDimensions(
  bytes: Buffer
): { width: number; height: number } | null {
  if (
    bytes.byteLength < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return null;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  public constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new TypeError(
        "Worker concurrency must be an integer between 1 and 32."
      );
    }
    this.#limit = limit;
  }

  public async acquire(timeoutMs: number): Promise<() => void> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.#waiting.indexOf(resume);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(
            new GutenbergV2WorkerError(
              "editor_unavailable",
              "The Gutenberg worker queue deadline expired.",
              true
            )
          );
        }, timeoutMs);
        this.#waiting.push(resume);
      });
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiting.shift()?.();
    };
  }
}

function assertOrigin(
  allowedOrigins: ReadonlySet<string>,
  value: string,
  label: string
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GutenbergV2WorkerError(
      "permission_denied",
      `${label} is not a valid absolute URL.`,
      false,
      error
    );
  }
  if (!allowedOrigins.has(url.origin)) {
    throw new GutenbergV2WorkerError(
      "permission_denied",
      `${label} is outside the configured worker origins.`,
      false
    );
  }
}

export class PlaywrightGutenbergV2Worker implements GutenbergV2Worker {
  readonly #siteUrl: URL;
  readonly #sessionProvider: GutenbergV2EditorSessionProvider;
  readonly #reviewArtifacts: GutenbergV2ReviewArtifactStore;
  readonly #previewMedia: GutenbergV2PreviewMediaResolver | undefined;
  readonly #browserFactory: () => Promise<Browser>;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #ignoreHTTPSErrors: boolean;
  readonly #jobTimeoutMs: number;
  readonly #semaphore: Semaphore;
  #browserPromise: Promise<Browser> | undefined;

  public constructor(options: PlaywrightGutenbergV2WorkerOptions) {
    this.#siteUrl = new URL(options.siteUrl);
    this.#sessionProvider = options.sessionProvider;
    this.#reviewArtifacts = options.reviewArtifacts;
    this.#previewMedia = options.previewMedia;
    this.#browserFactory =
      options.browserFactory ??
      (() => chromium.launch({ headless: true, ...options.launchOptions }));
    this.#allowedOrigins = new Set([
      this.#siteUrl.origin,
      ...(options.allowedAssetOrigins ?? []).map(
        (entry) => new URL(entry).origin
      )
    ]);
    this.#ignoreHTTPSErrors = options.ignoreHTTPSErrors ?? false;
    this.#jobTimeoutMs = options.jobTimeoutMs ?? 30_000;
    if (this.#jobTimeoutMs < 1_000 || this.#jobTimeoutMs > 120_000) {
      throw new TypeError(
        "Worker job timeout must be between 1 and 120 seconds."
      );
    }
    this.#semaphore = new Semaphore(options.maxConcurrentJobs ?? 2);
  }

  public async close(): Promise<void> {
    if (this.#browserPromise) await (await this.#browserPromise).close();
    this.#browserPromise = undefined;
  }

  public async discoverCapabilities(input: {
    siteId: string;
    postType: "post" | "page";
    postId?: number;
    expectedFingerprint?: string;
  }): Promise<GutenbergV2EditorCapabilitySnapshot> {
    return this.#withEditor(
      {
        executionId: `discover-${randomUUID()}`,
        siteId: input.siteId,
        postType: input.postType,
        ...(input.postId === undefined ? {} : { postId: input.postId }),
        ...(input.expectedFingerprint === undefined
          ? {}
          : { expectedFingerprint: input.expectedFingerprint })
      },
      async (_page, capabilities) => capabilities
    );
  }

  public async compile(
    input: Parameters<GutenbergV2Worker["compile"]>[0]
  ): Promise<GutenbergV2WorkerCompileResult> {
    const plan = gutenbergV2BlockPlanSchema.parse(input.plan);
    return this.#withEditor(
      {
        executionId: input.candidateId,
        siteId: plan.siteId,
        postType: plan.target.postType,
        ...(plan.operation === "create_draft"
          ? {}
          : { postId: plan.target.postId }),
        expectedFingerprint: input.capabilities.fingerprint
      },
      async (page, capabilities) => {
        const previewResolver =
          plan.media.length === 0 ? undefined : this.#requirePreviewMedia();
        const effectiveMediaMapping =
          input.mediaMapping ??
          (previewResolver?.resolveExistingMediaBindings
            ? await previewResolver.resolveExistingMediaBindings(plan)
            : []);
        const previewMediaMapping =
          plan.media.length === 0
            ? []
            : await previewResolver!.resolvePreviewMedia(
                plan,
                effectiveMediaMapping
              );
        const approvedMedia = new Map(
          plan.media.map((media) => [media.ref, media.source.checksum])
        );
        if (
          previewMediaMapping.length !== approvedMedia.size ||
          previewMediaMapping.some(
            (mapping) =>
              approvedMedia.get(mapping.ref) !== mapping.approvedChecksum
          )
        ) {
          throw new GutenbergV2WorkerError(
            "media_changed",
            "The private preview media does not cover the approved media intent exactly.",
            false
          );
        }
        const previewMediaManifestHash =
          hashGutenbergV2PreviewMediaManifest(previewMediaMapping);
        const raw = await page.evaluate(
          async (payload) => {
            const bridge = (
              globalThis as unknown as {
                sitepilotV2?: {
                  compile?: (value: unknown) => Promise<unknown>;
                };
              }
            ).sitepilotV2;
            if (typeof bridge?.compile !== "function")
              throw new Error("sitepilotV2.compile is unavailable");
            return bridge.compile(payload);
          },
          {
            plan,
            ...(input.source === undefined ? {} : { source: input.source }),
            ...(effectiveMediaMapping.length === 0
              ? {}
              : { mediaMapping: effectiveMediaMapping })
          }
        );
        const compiled = gutenbergV2EditorCompileResultSchema.parse(raw);
        const intentHash = hashGutenbergV2Value(plan);
        const contentHash = hashGutenbergV2Content(compiled.serializedContent);
        if (
          compiled.planId !== plan.planId ||
          compiled.operation !== plan.operation ||
          compiled.intentHash !== intentHash ||
          compiled.contentHash !== contentHash ||
          compiled.capabilityFingerprint !== capabilities.fingerprint
        ) {
          throw new GutenbergV2WorkerError(
            "content_changed",
            "The editor bridge returned hashes or identity for different content.",
            false
          );
        }
        const validation = gutenbergV2ValidationReportSchema.parse(
          compiled.validation
        );
        if (validation.outcome !== "valid") {
          const firstError = validation.issues.find(
            (entry) => entry.severity === "error"
          );
          throw new GutenbergV2WorkerError(
            firstError?.code ?? "invalid_block_markup",
            firstError?.message ??
              "The destination editor rejected the compiled candidate.",
            false,
            undefined,
            validation.issues
          );
        }
        const screenshots: Array<{
          viewport: "desktop" | "mobile";
          data: Buffer;
        }> = [];
        for (const viewport of ["desktop", "mobile"] as const) {
          await page.setViewportSize(
            viewport === "desktop"
              ? { width: 1440, height: 1000 }
              : { width: 390, height: 844 }
          );
          const previewRequest = gutenbergV2EditorPreviewRequestSchema.parse({
            serializedContent: compiled.serializedContent,
            intent: plan,
            viewport,
            ...(effectiveMediaMapping.length === 0
              ? {}
              : { mediaMapping: effectiveMediaMapping }),
            ...(previewMediaMapping.length === 0 ? {} : { previewMediaMapping })
          });
          const rawPreview = await page.evaluate(async (payload) => {
            const bridge = (
              globalThis as unknown as {
                sitepilotV2?: {
                  preview?: (value: unknown) => Promise<unknown>;
                };
              }
            ).sitepilotV2;
            if (typeof bridge?.preview !== "function")
              throw new Error("sitepilotV2.preview is unavailable");
            return bridge.preview(payload);
          }, previewRequest);
          const preview =
            gutenbergV2EditorPreviewResultSchema.parse(rawPreview);
          if (
            preview.renderedContentHash !== contentHash ||
            preview.previewMediaManifestHash !== previewMediaManifestHash
          ) {
            throw new GutenbergV2WorkerError(
              "content_changed",
              "The review preview rendered different content bytes or media.",
              false
            );
          }
          const root = page.locator(preview.rootSelector);
          await root.waitFor({ state: "visible" });
          const screenshot = await this.#captureFullPreview(
            root,
            viewport === "mobile" ? 390 : 1_440
          );
          screenshots.push({ viewport, data: Buffer.from(screenshot) });
        }
        const reviewArtifact = await this.#reviewArtifacts.write({
          candidateId: input.candidateId,
          plan,
          ...(input.source === undefined ? {} : { source: input.source }),
          serializedContent: compiled.serializedContent,
          serializedContentHash: contentHash,
          capabilityFingerprint: capabilities.fingerprint,
          screenshots
        });
        return {
          intent: plan,
          serializedContent: compiled.serializedContent,
          contentHash,
          intentHash,
          capabilityFingerprint: capabilities.fingerprint,
          validation,
          reviewArtifact
        };
      }
    );
  }

  #requirePreviewMedia(): GutenbergV2PreviewMediaResolver {
    if (!this.#previewMedia) {
      throw new GutenbergV2WorkerError(
        "media_changed",
        "A private preview media resolver is required for media plans.",
        false
      );
    }
    return this.#previewMedia;
  }

  async #captureFullPreview(
    root: ReturnType<Page["locator"]>,
    maximumViewportWidth: number
  ): Promise<Buffer> {
    const measurement = await root.evaluate(
      async (element, limits) => {
        type MeasurableElement = {
          tagName: string;
          getAttribute(name: string): string | null;
          setAttribute(name: string, value: string): void;
          removeAttribute(name: string): void;
          scrollHeight: number;
          offsetHeight: number;
          clientHeight: number;
          style: {
            setProperty(name: string, value: string, priority?: string): void;
          };
          getBoundingClientRect(): { width: number; height: number };
          contentDocument?: {
            body?: { scrollHeight: number; offsetHeight: number };
            documentElement?: {
              scrollHeight: number;
              offsetHeight: number;
              scrollTop: number;
            };
            querySelector(name: string): MeasurableContentElement | null;
            querySelectorAll(name: string): {
              length: number;
              item(index: number): MeasurableContentElement | null;
            };
            defaultView?: {
              getComputedStyle(value: unknown): { paddingBottom: string };
            } | null;
          } | null;
          parentElement?: MeasurableElement | null;
          isConnected: boolean;
          ownerDocument: {
            head?: { appendChild(value: unknown): void };
            createElement(name: string): {
              id: string;
              textContent: string | null;
            };
          };
        };
        type MeasurableContentElement = {
          getBoundingClientRect(): { bottom: number };
        };
        const previewRoot = element as unknown as MeasurableElement;
        const originalStyle = previewRoot.getAttribute("style");
        const originalHeightAttribute = previewRoot.getAttribute("height");
        const ancestorStyles: Array<string | null> = [];
        let ancestor: MeasurableElement | null | undefined = previewRoot;
        while (ancestor && ancestorStyles.length < 32) {
          ancestorStyles.push(ancestor.getAttribute("style"));
          ancestor = ancestor.parentElement;
        }
        const isIframe = previewRoot.tagName === "IFRAME";
        const iframe = isIframe ? previewRoot : undefined;
        const frameDocument = iframe?.contentDocument;
        if (isIframe && !frameDocument) {
          return {
            originalStyle,
            originalHeightAttribute,
            ancestorStyles,
            kind: "iframe",
            accessible: false,
            stable: false,
            covered: false,
            width: 0,
            renderedHeight: 0,
            contentHeight: 0
          };
        }
        const captureSelector = isIframe
          ? 'iframe[name="editor-canvas"], iframe.editor-canvas__iframe'
          : "#sitepilot-v2-preview, .editor-styles-wrapper, .block-editor-block-list__layout";
        const captureStyleId = `sitepilot-v2-capture-${String(Date.now())}`;
        const captureStyle = previewRoot.ownerDocument.createElement("style");
        captureStyle.id = captureStyleId;
        captureStyle.textContent = `
body { visibility: hidden !important; }
${captureSelector}, ${captureSelector} * {
  visibility: visible !important;
  transition: none !important;
  animation: none !important;
}`;
        previewRoot.ownerDocument.head?.appendChild(captureStyle);
        await new Promise<void>((resolve) => {
          const browserGlobal = globalThis as unknown as {
            requestAnimationFrame(callback: () => void): number;
          };
          browserGlobal.requestAnimationFrame(() =>
            browserGlobal.requestAnimationFrame(() => resolve())
          );
        });
        const initialContentNodes = frameDocument?.querySelectorAll(
          ".editor-post-title, .wp-block-post-title, [data-block]"
        );
        let initialContentBottom = 0;
        if (frameDocument && initialContentNodes) {
          const scrollTop = frameDocument.documentElement?.scrollTop ?? 0;
          for (let index = 0; index < initialContentNodes.length; index += 1) {
            const node = initialContentNodes.item(index);
            if (node)
              initialContentBottom = Math.max(
                initialContentBottom,
                node.getBoundingClientRect().bottom + scrollTop
              );
          }
        }
        const initialPaddingTarget = frameDocument?.querySelector(
          ".block-editor-block-list__layout.is-root-container, .editor-styles-wrapper"
        );
        const initialPadding = Math.max(
          Number.parseFloat(
            frameDocument?.defaultView?.getComputedStyle(
              initialPaddingTarget ?? frameDocument.body
            ).paddingBottom ?? "0"
          ) || 0,
          Number.parseFloat(
            frameDocument?.defaultView?.getComputedStyle(frameDocument.body)
              .paddingBottom ?? "0"
          ) || 0
        );
        let requestedHeight = frameDocument
          ? Math.ceil(initialContentBottom + initialPadding)
          : Math.ceil(
              Math.max(previewRoot.scrollHeight, previewRoot.offsetHeight)
            );
        const initialWidth = Math.ceil(
          previewRoot.getBoundingClientRect().width
        );
        let stable = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (requestedHeight < 1 || requestedHeight > limits.maxHeight) {
            break;
          }
          previewRoot.style.setProperty(
            "height",
            `${requestedHeight}px`,
            "important"
          );
          previewRoot.style.setProperty(
            "min-height",
            `${requestedHeight}px`,
            "important"
          );
          previewRoot.setAttribute("height", String(requestedHeight));
          previewRoot.style.setProperty("max-height", "none", "important");
          previewRoot.style.setProperty("overflow", "visible", "important");
          previewRoot.style.setProperty("flex", "none", "important");
          previewRoot.style.setProperty("display", "block", "important");
          previewRoot.style.setProperty("transition", "none", "important");
          previewRoot.style.setProperty("animation", "none", "important");
          captureStyle.textContent = `
body { visibility: hidden !important; }
${captureSelector} {
  visibility: visible !important;
  display: block !important;
  flex: none !important;
  height: ${requestedHeight}px !important;
  min-height: ${requestedHeight}px !important;
  max-height: none !important;
  width: ${initialWidth}px !important;
  max-width: none !important;
  overflow: visible !important;
  transition: none !important;
  animation: none !important;
}
${captureSelector} * { visibility: visible !important; }
html:has(${captureSelector}),
body:has(${captureSelector}),
body *:has(${captureSelector}) {
  height: auto !important;
  min-height: ${requestedHeight}px !important;
  max-height: none !important;
  overflow: visible !important;
  contain: none !important;
  flex-shrink: 0 !important;
  transition: none !important;
  animation: none !important;
}`;
          if (initialWidth > 0) {
            previewRoot.style.setProperty(
              "width",
              `${initialWidth}px`,
              "important"
            );
            previewRoot.style.setProperty("max-width", "none", "important");
          }
          let parent = previewRoot.parentElement;
          let parentIndex = 1;
          while (parent && parentIndex < ancestorStyles.length) {
            parent.style.setProperty("height", "auto", "important");
            parent.style.setProperty(
              "min-height",
              `${requestedHeight}px`,
              "important"
            );
            parent.style.setProperty("max-height", "none", "important");
            parent.style.setProperty("overflow", "visible", "important");
            parent.style.setProperty("contain", "none", "important");
            parent.style.setProperty("flex-shrink", "0", "important");
            parent.style.setProperty("transition", "none", "important");
            parent.style.setProperty("animation", "none", "important");
            parent = parent.parentElement;
            parentIndex += 1;
          }
          await new Promise<void>((resolve) => {
            const browserGlobal = globalThis as unknown as {
              requestAnimationFrame(callback: () => void): number;
            };
            browserGlobal.requestAnimationFrame(() =>
              browserGlobal.requestAnimationFrame(() => resolve())
            );
          });
          const nextContentNodes = frameDocument?.querySelectorAll(
            ".editor-post-title, .wp-block-post-title, [data-block]"
          );
          let nextContentBottom = 0;
          if (frameDocument && nextContentNodes) {
            const scrollTop = frameDocument.documentElement?.scrollTop ?? 0;
            for (let index = 0; index < nextContentNodes.length; index += 1) {
              const node = nextContentNodes.item(index);
              if (node)
                nextContentBottom = Math.max(
                  nextContentBottom,
                  node.getBoundingClientRect().bottom + scrollTop
                );
            }
          }
          const nextPaddingTarget = frameDocument?.querySelector(
            ".block-editor-block-list__layout.is-root-container, .editor-styles-wrapper"
          );
          const nextPadding = Math.max(
            Number.parseFloat(
              frameDocument?.defaultView?.getComputedStyle(
                nextPaddingTarget ?? frameDocument.body
              ).paddingBottom ?? "0"
            ) || 0,
            Number.parseFloat(
              frameDocument?.defaultView?.getComputedStyle(frameDocument.body)
                .paddingBottom ?? "0"
            ) || 0
          );
          const nextHeight = frameDocument
            ? Math.ceil(nextContentBottom + nextPadding)
            : Math.ceil(
                Math.max(previewRoot.scrollHeight, previewRoot.offsetHeight)
              );
          const visibleHeight = frameDocument
            ? (iframe?.clientHeight ?? 0)
            : previewRoot.getBoundingClientRect().height;
          if (nextHeight <= visibleHeight + 1) {
            requestedHeight = nextHeight;
            stable = true;
            break;
          }
          requestedHeight = nextHeight;
        }
        const bounds = previewRoot.getBoundingClientRect();
        const finalContentNodes = frameDocument?.querySelectorAll(
          ".editor-post-title, .wp-block-post-title, [data-block]"
        );
        let finalContentBottom = 0;
        if (frameDocument && finalContentNodes) {
          const scrollTop = frameDocument.documentElement?.scrollTop ?? 0;
          for (let index = 0; index < finalContentNodes.length; index += 1) {
            const node = finalContentNodes.item(index);
            if (node)
              finalContentBottom = Math.max(
                finalContentBottom,
                node.getBoundingClientRect().bottom + scrollTop
              );
          }
        }
        const finalPaddingTarget = frameDocument?.querySelector(
          ".block-editor-block-list__layout.is-root-container, .editor-styles-wrapper"
        );
        const finalPadding = Math.max(
          Number.parseFloat(
            frameDocument?.defaultView?.getComputedStyle(
              finalPaddingTarget ?? frameDocument.body
            ).paddingBottom ?? "0"
          ) || 0,
          Number.parseFloat(
            frameDocument?.defaultView?.getComputedStyle(frameDocument.body)
              .paddingBottom ?? "0"
          ) || 0
        );
        const finalContentHeight = frameDocument
          ? Math.ceil(finalContentBottom + finalPadding)
          : Math.ceil(
              Math.max(previewRoot.scrollHeight, previewRoot.offsetHeight)
            );
        const visibleHeight = frameDocument
          ? (iframe?.clientHeight ?? 0)
          : bounds.height;
        const browserGlobal = globalThis as unknown as {
          getComputedStyle(value: unknown): {
            height: string;
            minHeight: string;
            maxHeight: string;
            flex: string;
          };
        };
        const computedStyle = browserGlobal.getComputedStyle(previewRoot);
        return {
          originalStyle,
          originalHeightAttribute,
          captureStyleId,
          ancestorStyles,
          kind: isIframe ? "iframe" : "element",
          accessible: true,
          stable,
          covered: finalContentHeight <= visibleHeight + 1,
          width: Math.ceil(bounds.width),
          renderedHeight: Math.ceil(bounds.height),
          contentHeight: finalContentHeight,
          requestedHeight,
          inlineHeight: previewRoot.getAttribute("height"),
          computedHeight: computedStyle.height,
          computedMinHeight: computedStyle.minHeight,
          computedMaxHeight: computedStyle.maxHeight,
          computedFlex: computedStyle.flex,
          isConnected: previewRoot.isConnected,
          contentNodeCount: finalContentNodes?.length ?? 0,
          documentScrollHeight: Math.ceil(
            Math.max(
              frameDocument?.body?.scrollHeight ?? 0,
              frameDocument?.documentElement?.scrollHeight ?? 0
            )
          )
        };
      },
      {
        maxHeight: MAX_REVIEW_SCREENSHOT_HEIGHT,
        maxWidth: maximumViewportWidth
      }
    );

    try {
      if (
        measurement.contentHeight > MAX_REVIEW_SCREENSHOT_HEIGHT ||
        measurement.renderedHeight > MAX_REVIEW_SCREENSHOT_HEIGHT ||
        measurement.width * measurement.renderedHeight >
          MAX_REVIEW_SCREENSHOT_PIXELS
      ) {
        throw new GutenbergV2WorkerError(
          "request_too_large",
          "The complete native editor canvas exceeds the bounded review screenshot dimensions.",
          false
        );
      }
      if (
        !measurement.accessible ||
        !measurement.stable ||
        !measurement.covered ||
        measurement.width < 1 ||
        measurement.width > maximumViewportWidth + 1
      ) {
        throw new GutenbergV2WorkerError(
          "verification_failed",
          `The complete native editor canvas could not be captured for review (kind=${measurement.kind}, accessible=${measurement.accessible}, stable=${measurement.stable}, covered=${measurement.covered}, connected=${measurement.isConnected}, contentNodes=${measurement.contentNodeCount ?? 0}, width=${measurement.width}, maximumViewportWidth=${maximumViewportWidth}, renderedHeight=${measurement.renderedHeight}, contentHeight=${measurement.contentHeight}, documentScrollHeight=${measurement.documentScrollHeight ?? 0}, requestedHeight=${measurement.requestedHeight}, inlineHeight=${measurement.inlineHeight ?? "none"}, computedHeight=${measurement.computedHeight ?? "unknown"}, computedMinHeight=${measurement.computedMinHeight ?? "unknown"}, computedMaxHeight=${measurement.computedMaxHeight ?? "unknown"}, computedFlex=${measurement.computedFlex ?? "unknown"}).`,
          false
        );
      }
      const screenshot = await root.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide"
      });
      if (screenshot.byteLength > MAX_REVIEW_SCREENSHOT_BYTES) {
        throw new GutenbergV2WorkerError(
          "request_too_large",
          "A review screenshot exceeded its 20 MB limit.",
          false
        );
      }
      const dimensions = pngDimensions(Buffer.from(screenshot));
      if (
        !dimensions ||
        dimensions.width + 1 < measurement.width ||
        dimensions.height + 1 < measurement.renderedHeight
      ) {
        throw new GutenbergV2WorkerError(
          "verification_failed",
          "The review screenshot did not contain the complete measured editor canvas.",
          false
        );
      }
      return Buffer.from(screenshot);
    } finally {
      await root.evaluate(
        (element, restoration) => {
          type RestorableElement = {
            parentElement?: RestorableElement | null;
            removeAttribute(name: string): void;
            setAttribute(name: string, value: string): void;
            ownerDocument: {
              getElementById(name: string): { remove(): void } | null;
            };
          };
          const previewRoot = element as unknown as RestorableElement;
          let current: typeof previewRoot | null | undefined = previewRoot;
          for (const style of restoration.ancestorStyles) {
            if (!current) break;
            if (style === null) current.removeAttribute("style");
            else current.setAttribute("style", style);
            current = current.parentElement;
          }
          if (restoration.originalHeightAttribute === null)
            previewRoot.removeAttribute("height");
          else
            previewRoot.setAttribute(
              "height",
              restoration.originalHeightAttribute
            );
          if (restoration.captureStyleId)
            previewRoot.ownerDocument
              .getElementById(restoration.captureStyleId)
              ?.remove();
        },
        {
          ancestorStyles: measurement.ancestorStyles,
          originalHeightAttribute: measurement.originalHeightAttribute,
          captureStyleId: measurement.captureStyleId
        }
      );
    }
  }

  public async validatePreparedContent(
    input: Parameters<GutenbergV2Worker["validatePreparedContent"]>[0]
  ): Promise<GutenbergV2ValidationReport> {
    return this.#verify({
      executionId: `prepare-${input.candidate.candidateId}`,
      plan: input.candidate.intent,
      serializedContent: input.serializedContent,
      expectedSerializedContent: input.expectedSerializedContent,
      mediaMapping: input.mediaMapping,
      expectedFingerprint: input.capabilities.fingerprint
    });
  }

  public async verifyPersistedContent(
    input: Parameters<GutenbergV2Worker["verifyPersistedContent"]>[0]
  ): Promise<GutenbergV2ValidationReport> {
    const readback = gutenbergV2ReadbackSchema.parse(input.readback);
    const report = await this.#verify({
      executionId: readback.executionId,
      plan: input.candidate.intent,
      serializedContent: readback.rawContent,
      expectedSerializedContent: input.preparedCommit.finalContent,
      mediaMapping: input.preparedCommit.mediaMapping,
      expectedFingerprint: input.capabilities.fingerprint,
      postId: readback.postId
    });
    const featuredRef = input.candidate.requestedPostFields.featuredMediaRef;
    return this.#withPostFieldValidation(
      report,
      input.candidate.requestedPostFields,
      readback.fields,
      featuredRef === undefined
        ? undefined
        : {
            expectedId:
              input.preparedCommit.featuredMediaId ??
              input.preparedCommit.mediaMapping.find(
                (entry) => entry.ref === featuredRef
              )?.attachmentId,
            actualId: readback.featuredMediaId
          }
    );
  }

  public async readSource(
    input: EditorContextInput
  ): Promise<GutenbergV2SourceSnapshot> {
    return this.#withEditor(input, async (page) => {
      const raw = await page.evaluate(async () => {
        const bridge = (
          globalThis as unknown as {
            sitepilotV2?: { readSource?: () => Promise<unknown> };
          }
        ).sitepilotV2;
        if (typeof bridge?.readSource !== "function")
          throw new Error("sitepilotV2.readSource is unavailable");
        return bridge.readSource();
      });
      return gutenbergV2SourceSnapshotSchema.parse(raw);
    });
  }

  async #verify(input: {
    executionId: string;
    plan: GutenbergV2BlockPlan;
    serializedContent: string;
    expectedSerializedContent: string;
    mediaMapping: GutenbergV2MediaMapping[];
    expectedFingerprint: string;
    postId?: number;
  }): Promise<GutenbergV2ValidationReport> {
    const postId =
      input.postId ??
      (input.plan.operation === "create_draft"
        ? undefined
        : input.plan.target.postId);
    return this.#withEditor(
      {
        executionId: input.executionId,
        siteId: input.plan.siteId,
        postType: input.plan.target.postType,
        ...(postId === undefined ? {} : { postId }),
        expectedFingerprint: input.expectedFingerprint
      },
      async (page) => {
        await this.#assertMappedMediaLoads(page, input.mediaMapping);
        const verifyRequest = gutenbergV2EditorVerifyRequestSchema.parse({
          serializedContent: input.serializedContent,
          expectedSerializedContent: input.expectedSerializedContent,
          intent: input.plan,
          mediaMapping: input.mediaMapping
        });
        const raw = await page.evaluate(async (payload) => {
          const bridge = (
            globalThis as unknown as {
              sitepilotV2?: { verify?: (value: unknown) => Promise<unknown> };
            }
          ).sitepilotV2;
          if (typeof bridge?.verify !== "function")
            throw new Error("sitepilotV2.verify is unavailable");
          return bridge.verify(payload);
        }, verifyRequest);
        return gutenbergV2ValidationReportSchema.parse(raw);
      }
    );
  }

  async #assertMappedMediaLoads(
    page: Page,
    mapping: GutenbergV2MediaMapping[]
  ): Promise<void> {
    if (mapping.length === 0) return;
    const images: GutenbergV2MediaMapping[] = [];
    for (const item of mapping) {
      assertOrigin(this.#allowedOrigins, item.url, `Media ${item.ref} URL`);
      let response;
      try {
        response = await page.request.get(item.url, {
          failOnStatusCode: false,
          maxRedirects: 0,
          timeout: 5_000
        });
      } catch (error) {
        throw new GutenbergV2WorkerError(
          "editor_unavailable",
          `Bound media ${item.ref} could not be fetched for checksum verification.`,
          true,
          error
        );
      }
      const declaredLength = Number(response.headers()["content-length"]);
      if (
        response.status() < 200 ||
        response.status() >= 300 ||
        (Number.isFinite(declaredLength) && declaredLength > 10_000_000)
      ) {
        throw new GutenbergV2WorkerError(
          "media_changed",
          `Bound media ${item.ref} is unavailable or exceeds the 10 MB verification limit.`,
          false
        );
      }
      const bytes = await response.body();
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > 10_000_000 ||
        hashGutenbergV2Bytes(bytes) !== item.finalChecksum
      ) {
        throw new GutenbergV2WorkerError(
          "media_changed",
          `Bound media ${item.ref} no longer matches its approved checksum.`,
          false
        );
      }
      const detected = detectGutenbergV2MediaType(bytes);
      if (detected?.startsWith("video/")) {
        // Headless browsers often lack video codecs, so a video is verified by
        // its checksum, container signature and served type instead of playback.
        const servedType = String(response.headers()["content-type"] ?? "");
        if (!servedType.toLowerCase().startsWith("video/")) {
          throw new GutenbergV2WorkerError(
            "media_changed",
            `Bound video ${item.ref} is not served as a video.`,
            false
          );
        }
        continue;
      }
      images.push(item);
    }
    if (images.length === 0) return;
    const failures = await page.evaluate(
      async (items) => {
        const results = await Promise.all(
          items.map(
            (item) =>
              new Promise<string | null>((resolve) => {
                const BrowserImage = (
                  globalThis as unknown as {
                    Image: new () => {
                      naturalWidth: number;
                      src: string;
                      addEventListener(
                        type: string,
                        listener: () => void,
                        options: { once: boolean }
                      ): void;
                    };
                  }
                ).Image;
                const image = new BrowserImage();
                const timeout = globalThis.setTimeout(
                  () => resolve(item.ref),
                  5_000
                );
                image.addEventListener(
                  "load",
                  () => {
                    globalThis.clearTimeout(timeout);
                    resolve(image.naturalWidth > 0 ? null : item.ref);
                  },
                  { once: true }
                );
                image.addEventListener(
                  "error",
                  () => {
                    globalThis.clearTimeout(timeout);
                    resolve(item.ref);
                  },
                  { once: true }
                );
                image.src = item.url;
              })
          )
        );
        return results.filter((entry): entry is string => entry !== null);
      },
      images.map(({ ref, url }) => ({ ref, url }))
    );
    if (failures.length > 0) {
      throw new GutenbergV2WorkerError(
        "media_changed",
        `Bound media failed to load in the destination editor: ${failures.join(", ")}.`,
        false
      );
    }
  }

  #withPostFieldValidation(
    report: GutenbergV2ValidationReport,
    expected: {
      title?: string | undefined;
      excerpt?: string | undefined;
      featuredMediaRef?: string | undefined;
      status?: "draft" | undefined;
    },
    actual: { title: string; excerpt: string; status: string },
    featured?: { expectedId: number | undefined; actualId: number | undefined }
  ): GutenbergV2ValidationReport {
    const mismatches: string[] = (
      ["title", "excerpt", "status"] as const
    ).filter(
      (field) =>
        expected[field] !== undefined && actual[field] !== expected[field]
    );
    if (
      featured !== undefined &&
      (featured.expectedId === undefined ||
        featured.actualId !== featured.expectedId)
    ) {
      mismatches.push("featured image");
    }
    const checked = report.contentPreservation.checked.includes("post_fields")
      ? report.contentPreservation.checked
      : [...report.contentPreservation.checked, "post_fields" as const];
    if (mismatches.length === 0) {
      return gutenbergV2ValidationReportSchema.parse({
        ...report,
        contentPreservation: { ...report.contentPreservation, checked }
      });
    }
    return gutenbergV2ValidationReportSchema.parse({
      ...report,
      outcome: "invalid",
      issues: [
        ...report.issues,
        {
          code: "content_changed",
          severity: "error",
          phase: "verify",
          message: `Persisted post fields differ from approval: ${mismatches.join(", ")}.`
        }
      ],
      contentPreservation: {
        ...report.contentPreservation,
        passed: false,
        checked
      }
    });
  }

  async #withEditor<T>(
    input: EditorContextInput,
    operation: (
      page: Page,
      capabilities: GutenbergV2EditorCapabilitySnapshot
    ) => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    const release = await this.#semaphore.acquire(this.#jobTimeoutMs);
    let context: BrowserContext | undefined;
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const remainingMs = Math.max(
        1,
        this.#jobTimeoutMs - (Date.now() - startedAt)
      );
      const run = async (): Promise<T> => {
        const browser = await this.#browser();
        context = await browser.newContext({
          acceptDownloads: false,
          ignoreHTTPSErrors: this.#ignoreHTTPSErrors,
          serviceWorkers: "block"
        });
        await context.route("**/*", async (route) => {
          const request = route.request();
          let origin: string;
          try {
            origin = new URL(request.url()).origin;
          } catch {
            await route.abort("blockedbyclient");
            return;
          }
          if (!this.#allowedOrigins.has(origin)) {
            await route.abort("blockedbyclient");
            return;
          }
          if (
            !["GET", "HEAD", "OPTIONS"].includes(request.method().toUpperCase())
          ) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        });
        const session = await this.#sessionProvider.createSession(
          {
            schemaVersion: "sitepilot.editor-session-request/v2",
            executionId: input.executionId,
            siteId: input.siteId,
            context: {
              postType: input.postType,
              ...(input.postId === undefined ? {} : { postId: input.postId }),
              ...(input.expectedFingerprint === undefined
                ? {}
                : { expectedCapabilityFingerprint: input.expectedFingerprint })
            }
          },
          { signal: abortController.signal }
        );
        if (Date.parse(session.expiresAt) <= Date.now()) {
          throw new GutenbergV2WorkerError(
            "permission_denied",
            "The WordPress editor session was already expired.",
            false
          );
        }
        const bootstrap = await this.#sessionProvider.bootstrapSession(
          context,
          session
        );
        assertOrigin(this.#allowedOrigins, bootstrap.editorUrl, "Editor URL");
        const page = await context.newPage();
        page.setDefaultTimeout(this.#jobTimeoutMs);
        const response = await page.goto(bootstrap.editorUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.#jobTimeoutMs
        });
        if (!response?.ok()) {
          throw new GutenbergV2WorkerError(
            "editor_unavailable",
            `The destination editor did not load successfully${response ? ` (HTTP ${response.status()})` : ""}.`,
            true
          );
        }
        assertOrigin(this.#allowedOrigins, page.url(), "Loaded editor URL");
        await page.waitForFunction(() => {
          const bridge = (
            globalThis as unknown as {
              sitepilotV2?: {
                ready?: () => Promise<unknown>;
                compile?: (value: unknown) => Promise<unknown>;
                verify?: (value: unknown) => Promise<unknown>;
                readSource?: () => Promise<unknown>;
                preview?: (value: unknown) => Promise<unknown>;
              };
            }
          ).sitepilotV2;
          return (
            typeof bridge?.ready === "function" &&
            typeof bridge.compile === "function" &&
            typeof bridge.verify === "function" &&
            typeof bridge.readSource === "function" &&
            typeof bridge.preview === "function"
          );
        });
        const rawCapabilities = await page.evaluate(async () => {
          const bridge = (
            globalThis as unknown as {
              sitepilotV2?: { ready?: () => Promise<unknown> };
            }
          ).sitepilotV2;
          if (typeof bridge?.ready !== "function")
            throw new Error("sitepilotV2.ready is unavailable");
          return bridge.ready();
        });
        const capabilities =
          gutenbergV2EditorCapabilitySnapshotSchema.parse(rawCapabilities);
        if (
          capabilities.siteId !== input.siteId ||
          capabilities.context.postType !== input.postType ||
          (input.expectedFingerprint !== undefined &&
            capabilities.fingerprint !== input.expectedFingerprint)
        ) {
          throw new GutenbergV2WorkerError(
            "runtime_changed",
            "The loaded editor context or capability fingerprint changed.",
            false
          );
        }
        return await operation(page, capabilities);
      };
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          void context?.close().catch(() => undefined);
          reject(
            new GutenbergV2WorkerError(
              "editor_unavailable",
              "The Gutenberg worker job deadline expired.",
              true
            )
          );
        }, remainingMs);
      });
      return await Promise.race([run(), deadline]);
    } catch (error) {
      if (error instanceof GutenbergV2WorkerError) throw error;
      // Keep the underlying cause (bounded) so operators and the technical
      // report can see what actually failed.
      const cause =
        error instanceof Error ? error.message : String(error ?? "");
      const detail = cause.replace(/\s+/g, " ").trim().slice(0, 400);
      throw new GutenbergV2WorkerError(
        "editor_unavailable",
        `The destination Gutenberg editor worker failed before producing a trusted result.${
          detail.length > 0 ? ` Cause: ${detail}` : ""
        }`,
        true,
        error
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      abortController.abort();
      await context?.close().catch(() => undefined);
      release();
    }
  }

  async #browser(): Promise<Browser> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#browserPromise ??= this.#browserFactory();
      try {
        const browser = await this.#browserPromise;
        if (browser.isConnected()) return browser;
        await browser.close().catch(() => undefined);
        this.#browserPromise = undefined;
      } catch (error) {
        this.#browserPromise = undefined;
        if (attempt === 1) {
          const cause = error instanceof Error ? error.message : "";
          throw new GutenbergV2WorkerError(
            "editor_unavailable",
            `Chromium could not start.${
              cause
                ? ` Cause: ${cause.replace(/\s+/g, " ").trim().slice(0, 400)}`
                : ""
            }`,
            true,
            error
          );
        }
      }
    }
    throw new GutenbergV2WorkerError(
      "editor_unavailable",
      "Chromium repeatedly started in a disconnected state.",
      true
    );
  }
}
