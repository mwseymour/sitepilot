import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ALL_WORDPRESS_CORE_BLOCK_NAMES,
  coreBlockLabel,
  isSupportedWordPressCoreBlockName,
  type IndexedCoreBlockEntry,
  type WordPressCoreBlockIndex
} from "@sitepilot/contracts";

const DEFAULT_WORDPRESS_CORE_ROOT = path.resolve(process.cwd(), "wordpress-core");
const BLOCK_INDEX_CACHE_FILE = ".sitepilot-core-block-index.json";
const REFERENCE_BLOCK_NAME_SET = new Set<string>(ALL_WORDPRESS_CORE_BLOCK_NAMES);

function sortStrings(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function relativeToSnapshot(root: string, targetPath: string | null): string | undefined {
  if (!targetPath) {
    return undefined;
  }
  return path.relative(root, targetPath).replaceAll(path.sep, "/");
}

async function readJsonFile(targetPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(targetPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected object JSON in ${targetPath}.`);
  }
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return sortStrings(
    value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
  );
}

function recordKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return sortStrings(Object.keys(value as Record<string, unknown>));
}

function parseWordPressVersion(versionPhp: string): string | null {
  const match = /\$wp_version\s*=\s*'([^']+)'/.exec(versionPhp);
  return match?.[1] ?? null;
}

async function listBlockDirectories(blocksRoot: string): Promise<string[]> {
  const entries = await fs.readdir(blocksRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(blocksRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function listStyleFiles(blockDir: string, root: string): Promise<string[]> {
  const entries = await fs.readdir(blockDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(css|js|php)$/.test(entry.name) &&
        !/^block\.json$/i.test(entry.name)
    )
    .map((entry) => relativeToSnapshot(root, path.join(blockDir, entry.name)) ?? entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function blockReason(name: string, executable: boolean): string {
  return executable
    ? "Indexed from the local WordPress snapshot and executable because SitePilot already has explicit parsed-block canonicalization for it."
    : "Indexed from the local WordPress snapshot, but execution remains blocked until SitePilot has explicit parsed-block canonicalization for it.";
}

async function indexSingleBlock(input: {
  root: string;
  blocksRoot: string;
  blockDir: string;
}): Promise<IndexedCoreBlockEntry | null> {
  const metadataPath = path.join(input.blockDir, "block.json");
  if (!(await pathExists(metadataPath))) {
    return null;
  }

  const metadata = await readJsonFile(metadataPath);
  const name =
    typeof metadata.name === "string" && metadata.name.trim().length > 0
      ? metadata.name.trim()
      : "";
  if (name.length === 0) {
    return null;
  }

  const slug = path.basename(input.blockDir);
  const phpRegistrationPath = path.join(input.blocksRoot, `${slug}.php`);
  const renderValue =
    typeof metadata.render === "string" && metadata.render.trim().length > 0
      ? metadata.render.trim()
      : null;
  const renderPath = renderValue?.startsWith("file:./")
    ? path.join(input.blockDir, renderValue.slice("file:./".length))
    : null;
  const title =
    typeof metadata.title === "string" && metadata.title.trim().length > 0
      ? metadata.title.trim()
      : coreBlockLabel(name);
  const executable = isSupportedWordPressCoreBlockName(name);
  const hasRenderPath = renderPath ? await pathExists(renderPath) : false;
  const hasPhpRegistrationPath = await pathExists(phpRegistrationPath);
  const parent = stringArray(metadata.parent);
  const ancestor = stringArray(metadata.ancestor);
  const allowedBlocks = stringArray(metadata.allowedBlocks);
  const canContainInnerBlocks = allowedBlocks.length > 0;
  const likelyUsesInnerBlocks =
    canContainInnerBlocks || hasRenderPath || hasPhpRegistrationPath;

  return {
    name,
    label: coreBlockLabel(name),
    title,
    executable,
    status: executable ? "executable" : "indexed",
    reason: blockReason(name, executable),
    metadataPath: relativeToSnapshot(input.root, metadataPath) ?? "block.json",
    canContainInnerBlocks,
    likelyUsesInnerBlocks,
    hasParentRestriction: parent.length > 0,
    hasAncestorRestriction: ancestor.length > 0,
    ...(hasRenderPath && renderPath
      ? { renderPath: relativeToSnapshot(input.root, renderPath) ?? renderPath }
      : {}),
    ...(hasPhpRegistrationPath
      ? {
          phpRegistrationPath:
            relativeToSnapshot(input.root, phpRegistrationPath) ??
            phpRegistrationPath
        }
      : {}),
    ...(typeof metadata.apiVersion === "number" ? { apiVersion: metadata.apiVersion } : {}),
    ...(typeof metadata.category === "string" ? { category: metadata.category } : {}),
    parent,
    ancestor,
    allowedBlocks,
    attributes: recordKeys(metadata.attributes),
    supports: recordKeys(metadata.supports),
    styleFiles: await listStyleFiles(input.blockDir, input.root)
  };
}

export function defaultWordPressCoreRoot(): string {
  return DEFAULT_WORDPRESS_CORE_ROOT;
}

export function defaultWordPressCoreIndexCachePath(
  root = DEFAULT_WORDPRESS_CORE_ROOT
): string {
  return path.join(root, BLOCK_INDEX_CACHE_FILE);
}

export async function buildWordPressCoreBlockIndex(
  root = DEFAULT_WORDPRESS_CORE_ROOT
): Promise<WordPressCoreBlockIndex | null> {
  const versionPath = path.join(root, "wp-includes", "version.php");
  const blocksRoot = path.join(root, "wp-includes", "blocks");
  if (!(await pathExists(versionPath)) || !(await pathExists(blocksRoot))) {
    return null;
  }

  const versionPhp = await fs.readFile(versionPath, "utf8");
  const blockDirs = await listBlockDirectories(blocksRoot);
  const blocks = (
    await Promise.all(
      blockDirs.map((blockDir) =>
        indexSingleBlock({
          root,
          blocksRoot,
          blockDir
        })
      )
    )
  )
    .filter((entry): entry is IndexedCoreBlockEntry => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  const blockNames = new Set(blocks.map((entry) => entry.name));
  const missingReferenceBlocks = ALL_WORDPRESS_CORE_BLOCK_NAMES.filter(
    (name) => !blockNames.has(name)
  );
  const additionalSnapshotBlocks = blocks
    .map((entry) => entry.name)
    .filter((name) => !REFERENCE_BLOCK_NAME_SET.has(name));

  return {
    sourceRoot: root,
    cachePath: defaultWordPressCoreIndexCachePath(root),
    generatedAt: new Date().toISOString(),
    wordpressVersion: parseWordPressVersion(versionPhp),
    indexedBlockCount: blocks.length,
    executableBlockCount: blocks.filter((entry) => entry.executable).length,
    missingReferenceBlocks,
    additionalSnapshotBlocks,
    blocks
  };
}

export async function readCachedWordPressCoreBlockIndex(
  root = DEFAULT_WORDPRESS_CORE_ROOT
): Promise<WordPressCoreBlockIndex | null> {
  const cachePath = defaultWordPressCoreIndexCachePath(root);
  if (!(await pathExists(cachePath))) {
    return null;
  }
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as WordPressCoreBlockIndex;
  } catch {
    return null;
  }
}

export async function writeWordPressCoreBlockIndex(
  index: WordPressCoreBlockIndex
): Promise<void> {
  await fs.writeFile(index.cachePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export async function getWordPressCoreBlockIndex(
  root = DEFAULT_WORDPRESS_CORE_ROOT
): Promise<WordPressCoreBlockIndex | null> {
  const cached = await readCachedWordPressCoreBlockIndex(root);
  if (cached) {
    return cached;
  }
  const built = await buildWordPressCoreBlockIndex(root);
  if (!built) {
    return null;
  }
  await writeWordPressCoreBlockIndex(built);
  return built;
}

export async function reindexWordPressCoreBlockIndex(
  root = DEFAULT_WORDPRESS_CORE_ROOT
): Promise<WordPressCoreBlockIndex | null> {
  const built = await buildWordPressCoreBlockIndex(root);
  if (!built) {
    return null;
  }
  await writeWordPressCoreBlockIndex(built);
  return built;
}
