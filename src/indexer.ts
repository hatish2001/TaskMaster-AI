import * as path from "path";
import { createReadStream, promises as fs, Stats } from "fs";
import * as vscode from "vscode";
import { glob } from "glob";
import { OpenAIEmbeddings } from "@langchain/openai";
import { createHash } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { cpus, totalmem } from "os";
import { getPipelineConfig } from "./config";
import {
  analyzeSource,
  buildDependencyGraph,
  detectUnusedSymbols,
  AnalysisResult,
} from "./analysis/analyzer";
import { semanticChunk, Chunk } from "./analysis/chunking";
import {
  DependencyGraph,
  FileAnalysis,
  UnusedSymbol,
} from "./analysis/types";
import { detectLanguage } from "./analysis/language";

const STORE_DIR = ".ai-pipeline";
const INDEX_FILE = "index.json";
const LARGE_FILE_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_STREAM_HIGH_WATER_MARK = 256 * 1024; // 256 KB
const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  ".svn/",
  ".hg/",
  `${STORE_DIR}/`,
  "node_modules/",
  "bower_components/",
  ".DS_Store",
  ".gitignore",
  ".contextignore",
];

const INDEX_VERSION = 3;

interface IgnoreRule {
  regex: RegExp;
  negated: boolean;
}

interface FileEntry {
  filePath: string;
  relativePath: string;
  posixPath: string;
  priority: number;
}

const execAsync = promisify(exec);

export interface IndexedChunk {
  id: string;
  relativePath: string;
  content: string;
  embedding: number[];
  symbols?: string[];
  language?: string;
  start?: number;
  end?: number;
  complexity?: number;
  hash?: string;
}

export interface IndexedFileMetadata extends FileAnalysis {
  hash: string;
  size: number;
  mtimeMs: number;
  gitStatus?: string;
  hasConflicts?: boolean;
}

export interface GitMetadata {
  branch?: string;
  statusSummary?: string[];
}

export interface PackageInfo {
  path: string;
  name?: string;
  kind: "workspace" | "package" | "module";
  language?: string;
}

export interface RepoTopology {
  packages: PackageInfo[];
  submodules: string[];
}

export interface RepoIndex {
  embeddingModel: string;
  createdAt: string;
  chunks: IndexedChunk[];
  fileMetadata?: Record<string, IndexedFileMetadata>;
  dependencyGraph?: DependencyGraph;
  unusedSymbols?: UnusedSymbol[];
  git?: GitMetadata;
  topology?: RepoTopology;
  version?: number;
}

export async function ensureIndex(
  workspace: vscode.WorkspaceFolder
): Promise<RepoIndex> {
  const existing = await loadIndex(workspace);
  if (existing) {
    return existing;
  }
  return rebuildIndex(workspace);
}

export async function loadIndex(
  workspace: vscode.WorkspaceFolder
): Promise<RepoIndex | undefined> {
  const indexPath = await getIndexPath(workspace);
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(raw) as RepoIndex;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function rebuildIndex(
  workspace: vscode.WorkspaceFolder,
  options: { silent?: boolean; touchedFiles?: string[] } = {}
): Promise<RepoIndex> {
  const { silent = false } = options;
  const config = getPipelineConfig();
  const workspacePath = workspace.uri.fsPath;
  const pattern = "**/*";
  const ignoreMatcher = await buildIgnoreMatcher(
    workspacePath,
    config.ignoredGlobs
  );
  let previousIndex: RepoIndex | undefined;
  try {
    previousIndex = await loadIndex(workspace);
  } catch (error) {
    console.warn("Failed to load previous index, proceeding with a fresh build", error);
  }

  const previousFileMetadata =
    previousIndex?.fileMetadata ?? ({} as Record<string, IndexedFileMetadata>);
  const previousChunksByFile = new Map<string, IndexedChunk[]>();

  previousIndex?.chunks.forEach((chunk) => {
    const list = previousChunksByFile.get(chunk.relativePath) ?? [];
    list.push(chunk);
    previousChunksByFile.set(chunk.relativePath, list);
  });

  const gitInfo = await collectGitMetadata(workspacePath);
  const touchedSet = new Set<string>();
  (options.touchedFiles ?? []).forEach((file) => {
    const relative = path.relative(workspacePath, file);
    if (!relative || relative.startsWith("..")) {
      return;
    }
    touchedSet.add(toPosixPath(relative));
  });

  if (!silent) {
    vscode.window.showInformationMessage(
      "AI pipeline is indexing workspace files..."
    );
  }

  const files = await glob(pattern, {
    cwd: workspacePath,
    nodir: true,
    absolute: true,
    dot: true,
    follow: false,
  });

  const fileEntries = files
    .map((filePath) => {
      const relativePath = path.relative(workspacePath, filePath);
      const posixPath = toPosixPath(relativePath);
      const priority = computeFilePriority(posixPath);
      return { filePath, relativePath, posixPath, priority };
    })
    .filter((entry) => !shouldIgnore(entry.posixPath, ignoreMatcher))
    .sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.posixPath.localeCompare(b.posixPath);
    });

  const topology = await collectRepoTopology(workspacePath, fileEntries);

  const chunks: IndexedChunk[] = [];
  const newChunks: IndexedChunk[] = [];
  const analyses: AnalysisResult[] = [];
  const fileMetadata: Record<string, IndexedFileMetadata> = {};
  const charSize = config.chunkSize * 4;
  const overlapChars = config.chunkOverlap * 4;
  const changedFiles: string[] = [];
  const reusedFiles: string[] = [];

  const cpuCount = cpus().length || 1;
  const maxWorkers =
    config.maxConcurrentWorkers > 0
      ? config.maxConcurrentWorkers
      : Math.max(1, Math.min(8, cpuCount - 1));
  const concurrency = Math.max(
    1,
    Math.min(maxWorkers, fileEntries.length || 1)
  );

  const defaultBudget = Math.floor(totalmem() * 0.25);
  const configuredBudget =
    config.memoryBudgetMb > 0 ? config.memoryBudgetMb * 1024 * 1024 : 0;
  const memoryBudget =
    configuredBudget > 0
      ? configuredBudget
      : Math.max(256 * 1024 * 1024, defaultBudget);
  let processedBytes = 0;
  let memoryWarningIssued = false;

  let nextIndex = 0;
  const fileCount = fileEntries.length;

  const processEntry = async () => {
    while (true) {
      const current = nextIndex;
      if (current >= fileCount) {
        return;
      }
      nextIndex += 1;
      const entry = fileEntries[current];

      const { filePath, posixPath } = entry;
      let lstat: Stats;
      try {
        lstat = await fs.lstat(filePath);
      } catch (error) {
        console.warn(`Failed to stat file ${filePath}`, error);
        continue;
      }

      if (!lstat.isFile() || lstat.isSymbolicLink()) {
        continue;
      }

      if (lstat.size === 0) {
        continue;
      }

      const isBinary = await isBinaryFile(filePath, lstat.size);
      if (isBinary) {
        continue;
      }

      const gitStatus = gitInfo.statusMap.get(posixPath);
      const hasConflicts = gitInfo.conflictFiles.has(posixPath);
      const previousMeta = previousFileMetadata[posixPath];
      const previousChunks = previousChunksByFile.get(posixPath) ?? [];
      const isTouched =
        touchedSet.size === 0 ? true : touchedSet.has(posixPath);
      const hasSameStat =
        previousMeta != null &&
        previousMeta.size === lstat.size &&
        Math.round(previousMeta.mtimeMs) === Math.round(lstat.mtimeMs);
      const canReuse =
        previousMeta != null &&
        previousChunks.length > 0 &&
        (!isTouched || hasSameStat);

      if (canReuse) {
        reusedFiles.push(posixPath);
        const updatedMeta: IndexedFileMetadata = {
          ...previousMeta,
          gitStatus,
          hasConflicts,
          size: lstat.size,
          mtimeMs: lstat.mtimeMs,
        };
        fileMetadata[posixPath] = updatedMeta;
        analyses.push({
          file: posixPath,
          analysis: updatedMeta,
        });
        previousChunks.forEach((chunk) => {
          const existingHash =
            chunk.hash ?? createChunkHash(posixPath, chunk.content);
          chunks.push({ ...chunk, hash: existingHash });
        });
        continue;
      }

      const nextTotal = processedBytes + lstat.size;
      processedBytes = nextTotal;
      const forceStream = nextTotal > memoryBudget;
      if (forceStream && !memoryWarningIssued) {
        memoryWarningIssued = true;
        console.warn(
          `AI Pipeline indexer hit memory budget (${Math.round(
            memoryBudget / (1024 * 1024)
          )} MB). Falling back to streaming mode for remaining files.`
        );
      }

      const result = await processFile({
        filePath,
        relativePath: posixPath,
        charSize,
        overlapChars,
        stat: lstat,
        forceStream,
      });

      if (!result || !result.analysis) {
        continue;
      }

      result.analysis.hash = result.hash;
      changedFiles.push(posixPath);
      analyses.push({
        file: posixPath,
        analysis: result.analysis,
      });

      const metadata: IndexedFileMetadata = {
        ...result.analysis,
        hash: result.hash,
        size: lstat.size,
        mtimeMs: lstat.mtimeMs,
        gitStatus,
        hasConflicts,
      };
      fileMetadata[posixPath] = metadata;

      result.chunks.forEach((chunk, index) => {
        const chunkRecord: IndexedChunk = {
          id: `${posixPath}:${index}`,
          relativePath: posixPath,
          content: chunk.content,
          embedding: [],
          symbols: chunk.symbols,
          language: result.analysis?.language,
          start: chunk.start,
          end: chunk.end,
          complexity: computeChunkComplexity(chunk.symbols, result.analysis),
          hash: createChunkHash(posixPath, chunk.content),
        };
        newChunks.push(chunkRecord);
        chunks.push(chunkRecord);
      });
    }
  };

  const workers = Array.from({ length: concurrency }, () => processEntry());
  await Promise.all(workers);

  const dependencyGraph = buildDependencyGraph(analyses);
  const unusedSymbols = detectUnusedSymbols(analyses, dependencyGraph);

  if (newChunks.length > 0) {
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: config.apiKey,
      modelName: config.embeddingModel,
    });
    const batchSize = config.embeddingBatchSize;
    for (let i = 0; i < newChunks.length; i += batchSize) {
      const batch = newChunks.slice(i, i + batchSize);
      const documents = batch.map((chunk) => chunk.content);
      const vectors = await embeddings.embedDocuments(documents);
      vectors.forEach((embedding, offset) => {
        batch[offset].embedding = embedding;
      });
    }
  }

  const repoIndex: RepoIndex = {
    embeddingModel: config.embeddingModel,
    createdAt: new Date().toISOString(),
    chunks,
    fileMetadata,
    dependencyGraph,
    unusedSymbols,
    git: {
      branch: gitInfo.branch,
      statusSummary: gitInfo.summary.length > 0 ? gitInfo.summary : undefined,
    },
    topology,
    version: INDEX_VERSION,
  };

  const indexPath = await getIndexPath(workspace);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(repoIndex), "utf-8");

  if (!silent) {
    vscode.window.showInformationMessage(
      `AI pipeline index refreshed (${changedFiles.length} updated, ${reusedFiles.length} cached).`
    );
  }

  return repoIndex;
}

export function similaritySearch(
  repoIndex: RepoIndex,
  queryEmbedding: number[],
  topK = 8
): IndexedChunk[] {
  const scored = repoIndex.chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  return scored
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => item.chunk);
}

async function getIndexPath(workspace: vscode.WorkspaceFolder) {
  const dir = path.join(workspace.uri.fsPath, STORE_DIR);
  return path.join(dir, INDEX_FILE);
}

interface ProcessFileOptions {
  filePath: string;
  relativePath: string;
  charSize: number;
  overlapChars: number;
  stat: Stats;
  forceStream?: boolean;
}

interface ProcessFileResult {
  chunks: Chunk[];
  analysis?: FileAnalysis;
  hash: string;
}

async function processFile({
  filePath,
  relativePath,
  charSize,
  overlapChars,
  stat,
  forceStream = false,
}: ProcessFileOptions): Promise<ProcessFileResult | undefined> {
  const treatAsLarge = forceStream || stat.size > LARGE_FILE_THRESHOLD_BYTES;
  if (treatAsLarge) {
    const sample = await readFilePrefix(filePath, 128 * 1024);
    const previewText = sample.toString("utf-8");
    const previewAnalysis = analyzeSource({
      relativePath,
      sourceText: previewText,
    }).analysis;
    const streamed = await streamAndChunkFile(
      filePath,
      charSize,
      overlapChars,
      relativePath
    );
    return {
      chunks: streamed.chunks,
      analysis: annotateLargeFileAnalysis(
        previewAnalysis,
        stat.size,
        relativePath,
        streamed.hash
      ),
      hash: streamed.hash,
    };
  }

  const text = await fs.readFile(filePath, "utf-8");
  const analysisResult = analyzeSource({
    relativePath,
    sourceText: text,
  });
  const analysis = analysisResult.analysis;
  const semanticChunks = semanticChunk(text, relativePath, analysis, {
    maxChars: charSize,
    overlapChars,
    dynamicScaling: true,
  });
  const hash = analysis.hash;

  return {
    chunks: semanticChunks,
    analysis,
    hash,
  };
}

function computeChunkComplexity(
  symbols: string[] | undefined,
  analysis?: FileAnalysis
): number | undefined {
  if (!analysis || !symbols || symbols.length === 0) {
    return undefined;
  }
  const complexities = analysis.complexity.symbolComplexities;
  let total = 0;
  let count = 0;
  symbols.forEach((symbol) => {
    const value = complexities[symbol];
    if (typeof value === "number") {
      total += value;
      count += 1;
    }
  });
  if (count === 0) {
    return undefined;
  }
  return parseFloat((total / count).toFixed(2));
}

interface StreamChunkResult {
  chunks: Chunk[];
  hash: string;
}

async function streamAndChunkFile(
  filePath: string,
  chunkSize: number,
  overlap: number,
  relativePath: string
): Promise<StreamChunkResult> {
  const results: Chunk[] = [];
  const stream = createReadStream(filePath, {
    encoding: "utf-8",
    highWaterMark: Math.max(chunkSize, MAX_STREAM_HIGH_WATER_MARK),
  });
  const hash = createHash("sha1");

  let buffer = "";
  let offset = 0;

  for await (const fragment of stream) {
    buffer += fragment;
    hash.update(fragment, "utf8");

    while (buffer.length >= chunkSize) {
      const slice = buffer.slice(0, chunkSize);
      const chunkStart = offset;
      const chunkEnd = offset + slice.length;
      results.push({
        id: `${relativePath}:${results.length}`,
        content: slice,
        start: chunkStart,
        end: chunkEnd,
        symbols: [],
      });
      const retainFrom = Math.max(chunkSize - overlap, 0);
      buffer = buffer.slice(retainFrom);
      offset = chunkEnd - buffer.length;
    }
  }

  if (buffer.length > 0) {
    const chunkStart = offset;
    const chunkEnd = offset + buffer.length;
    results.push({
      id: `${relativePath}:${results.length}`,
      content: buffer,
      start: chunkStart,
      end: chunkEnd,
      symbols: [],
    });
  }

  return {
    chunks: results,
    hash: hash.digest("hex"),
  };
}

async function readFilePrefix(
  filePath: string,
  bytes: number
): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function annotateLargeFileAnalysis(
  analysis: FileAnalysis,
  fileSize: number,
  relativePath: string,
  fileHash: string
): FileAnalysis {
  const language =
    analysis.language === "unknown"
      ? detectLanguage(relativePath)
      : analysis.language;
  return {
    ...analysis,
    language,
    hash: fileHash,
    complexity: {
      ...analysis.complexity,
      totalComplexity: Math.max(analysis.complexity.totalComplexity, 1),
    },
    isLikelyGenerated:
      analysis.isLikelyGenerated || fileSize > 20 * 1024 * 1024,
  };
}

function createChunkHash(relativePath: string, content: string): string {
  return createHash("sha1")
    .update(relativePath)
    .update("\u0000")
    .update(content)
    .digest("hex");
}

function isBinaryContent(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function collectGitMetadata(workspacePath: string): Promise<{
  branch?: string;
  statusMap: Map<string, string>;
  conflictFiles: Set<string>;
  summary: string[];
}> {
  const statusMap = new Map<string, string>();
  const conflictFiles = new Set<string>();
  const summary: string[] = [];
  let branch: string | undefined;

  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspacePath,
    });
    branch = stdout.trim() || undefined;
  } catch {
    branch = undefined;
  }

  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: workspacePath,
    });
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    lines.forEach((line) => {
      const code = line.slice(0, 2);
      let fileSpec = line.slice(3).trim();
      if (!fileSpec) {
        return;
      }
      if (fileSpec.includes(" -> ")) {
        const parts = fileSpec.split(" -> ");
        fileSpec = parts[parts.length - 1] ?? fileSpec;
      }
      const posix = toPosixPath(fileSpec);
      statusMap.set(posix, code.trim());
      summary.push(`${code.trim()} ${posix}`);
      if (code.includes("U") || code.trim() === "AA" || code.trim() === "DD") {
        conflictFiles.add(posix);
      }
    });
  } catch {
    // not a git repository, ignore
  }

  return {
    branch,
    statusMap,
    conflictFiles,
    summary,
  };
}

async function collectRepoTopology(
  workspacePath: string,
  entries: FileEntry[]
): Promise<RepoTopology> {
  const packages: PackageInfo[] = [];
  const seen = new Set<string>();
  const addPackage = (info: PackageInfo) => {
    if (seen.has(info.path)) {
      return;
    }
    seen.add(info.path);
    packages.push(info);
  };

  const manifestEntries = entries.filter((entry) =>
    entry.posixPath.endsWith("package.json")
  );

  for (const entry of manifestEntries) {
    const manifestPath = path.join(workspacePath, entry.relativePath);
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw);
      const dir = entry.posixPath === "package.json"
        ? "."
        : path.posix.dirname(entry.posixPath);
      const name =
        typeof manifest.name === "string" ? manifest.name : undefined;
      const hasWorkspaces =
        Array.isArray(manifest.workspaces) ||
        (manifest.workspaces &&
          Array.isArray(manifest.workspaces.packages));
      const kind: PackageInfo["kind"] = hasWorkspaces
        ? "workspace"
        : "package";
      addPackage({
        path: dir,
        name,
        kind,
        language: "javascript",
      });
    } catch (error) {
      console.warn(`Failed to parse package manifest at ${manifestPath}`, error);
    }
  }

  const goModules = entries.filter((entry) =>
    entry.posixPath.endsWith("go.mod")
  );
  for (const entry of goModules) {
    const modulePath = path.join(workspacePath, entry.relativePath);
    try {
      const raw = await fs.readFile(modulePath, "utf-8");
      const match = raw.match(/^\s*module\s+([^\s]+)/m);
      const moduleName = match ? match[1].trim() : undefined;
      const dir =
        entry.posixPath === "go.mod"
          ? "."
          : path.posix.dirname(entry.posixPath);
      addPackage({
        path: dir,
        name: moduleName,
        kind: "module",
        language: "go",
      });
    } catch (error) {
      console.warn(`Failed to parse go.mod at ${modulePath}`, error);
    }
  }

  const cargoTomls = entries.filter((entry) =>
    entry.posixPath.endsWith("Cargo.toml")
  );
  for (const entry of cargoTomls) {
    const cargoPath = path.join(workspacePath, entry.relativePath);
    try {
      const raw = await fs.readFile(cargoPath, "utf-8");
      const match = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      const dir =
        entry.posixPath === "Cargo.toml"
          ? "."
          : path.posix.dirname(entry.posixPath);
      addPackage({
        path: dir,
        name: match ? match[1] : undefined,
        kind: "module",
        language: "rust",
      });
    } catch (error) {
      console.warn(`Failed to parse Cargo.toml at ${cargoPath}`, error);
    }
  }

  const pyProjects = entries.filter((entry) =>
    entry.posixPath.endsWith("pyproject.toml")
  );
  for (const entry of pyProjects) {
    const projectPath = path.join(workspacePath, entry.relativePath);
    try {
      const raw = await fs.readFile(projectPath, "utf-8");
      const match =
        raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m) ??
        raw.match(/^\s*project\s*=\s*["']([^"']+)["']/m);
      const dir =
        entry.posixPath === "pyproject.toml"
          ? "."
          : path.posix.dirname(entry.posixPath);
      addPackage({
        path: dir,
        name: match ? match[1] : undefined,
        kind: "module",
        language: "python",
      });
    } catch (error) {
      console.warn(`Failed to parse pyproject.toml at ${projectPath}`, error);
    }
  }

  const specialWorkspaceFiles = [
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
    "turbo.json",
    "nx.json",
  ];
  entries
    .filter((entry) => specialWorkspaceFiles.includes(entry.posixPath))
    .forEach((entry) => {
      addPackage({
        path:
          entry.posixPath.indexOf("/") === -1
            ? "."
            : path.posix.dirname(entry.posixPath),
        kind: "workspace",
        language: "javascript",
      });
    });

  let submodules: string[] = [];
  try {
    const gitmodules = await fs.readFile(
      path.join(workspacePath, ".gitmodules"),
      "utf-8"
    );
    const matches = gitmodules.matchAll(/^\s*path\s*=\s*(.+)$/gm);
    submodules = Array.from(matches)
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value))
      .map((value) => toPosixPath(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Failed to read .gitmodules", error);
    }
  }

  return {
    packages,
    submodules,
  };
}

async function buildIgnoreMatcher(
  workspacePath: string,
  additionalPatterns: string[]
): Promise<IgnoreRule[]> {
  const patterns: IgnoreRule[] = [];
  const filesToRead = [".gitignore", ".contextignore"];

  DEFAULT_IGNORE_PATTERNS.forEach((pattern) => {
    patterns.push(createIgnoreRule(pattern));
  });

  for (const fileName of filesToRead) {
    const fullPath = path.join(workspacePath, fileName);
    const content = await readIgnoreFile(fullPath);
    if (!content) {
      continue;
    }
    content.forEach((line) => {
      patterns.push(createIgnoreRule(line));
    });
  }

  additionalPatterns.forEach((pattern) => {
    patterns.push(createIgnoreRule(pattern));
  });

  return patterns;
}

async function readIgnoreFile(filePath: string): Promise<string[] | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    console.warn(`Failed to read ignore file at ${filePath}`, error);
    return undefined;
  }
}

function shouldIgnore(relativePath: string, rules: IgnoreRule[]): boolean {
  if (rules.length === 0) {
    return false;
  }

  const normalized = relativePath.startsWith("./")
    ? relativePath.slice(2)
    : relativePath;

  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(normalized)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function createIgnoreRule(pattern: string): IgnoreRule {
  let current = pattern;
  let negated = false;

  if (current.startsWith("\\")) {
    current = current.slice(1);
  }

  if (current.startsWith("!")) {
    negated = true;
    current = current.slice(1);
  }

  const normalizedPattern = current.replace(/\\/g, "/");
  const anchored = normalizedPattern.startsWith("/");
  const directoryOnly = normalizedPattern.endsWith("/");

  let workingPattern = anchored
    ? normalizedPattern.slice(1)
    : normalizedPattern;

  if (!anchored && !workingPattern.startsWith("**/")) {
    workingPattern = `**/${workingPattern}`;
  }

  if (directoryOnly) {
    workingPattern = `${workingPattern}**`;
  }

  const regex = globToRegExp(workingPattern);
  return { regex, negated };
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === "*" && next === "*") {
      const nextChar = pattern[i + 2];
      if (nextChar === "/") {
        regex += "(?:.*/)?";
        i += 2;
        continue;
      }
      regex += ".*";
      i += 1;
      continue;
    }

    if (char === "*") {
      regex += "[^/]*";
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegExp(char);
  }

  regex += "$";
  return new RegExp(regex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function computeFilePriority(relativePath: string): number {
  const value = relativePath.toLowerCase();
  let score = 0;

  const priorityPatterns: Array<{ regex: RegExp; weight: number }> = [
    { regex: /(^|\/)(package|pnpm|yarn|composer|go)\.(json|lock|sum|mod)$/, weight: 120 },
    { regex: /(^|\/)(package-lock|pnpm-lock|yarn-lock)\.json$/, weight: 115 },
    { regex: /(^|\/)(tsconfig|vite|webpack|rollup|babel|eslint|prettier|jest)\.([^/]+)$/, weight: 110 },
    { regex: /(^|\/)(dockerfile|makefile|procfile)$/, weight: 100 },
    { regex: /\.config\.(js|ts|cjs|mjs|json|yaml|yml)$/, weight: 95 },
    { regex: /(^|\/)(index|main|app|server|cli|api)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|rs|php|cs)$/, weight: 90 },
    { regex: /(^|\/)(src|app|lib|services|packages)\//, weight: 80 },
    { regex: /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|DESIGN)(\.md|\.rst)?$/, weight: 70 },
    { regex: /(^|\/)config\//, weight: 60 },
    { regex: /(^|\/)(env|\.env|\.env\.[^/]+)$/, weight: 50 },
    { regex: /(^|\/)(tests?|__tests__|specs?)\//, weight: -10 },
    { regex: /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rb|java|rs)$/, weight: -10 },
    { regex: /(^|\/)(docs?|examples?)\//, weight: 30 },
  ];

  for (const matcher of priorityPatterns) {
    if (matcher.regex.test(value)) {
      score += matcher.weight;
    }
  }

  const depth = value.split("/").length;
  score -= depth;

  return score;
}

async function isBinaryFile(filePath: string, size: number): Promise<boolean> {
  if (size === 0) {
    return false;
  }

  const sampleSize = Math.min(size, 4096);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
    return isBinaryContent(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

