"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureIndex = ensureIndex;
exports.loadIndex = loadIndex;
exports.rebuildIndex = rebuildIndex;
exports.similaritySearch = similaritySearch;
const path = __importStar(require("path"));
const fs_1 = require("fs");
const vscode = __importStar(require("vscode"));
const glob_1 = require("glob");
const openai_1 = require("@langchain/openai");
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const util_1 = require("util");
const os_1 = require("os");
const config_1 = require("./config");
const analyzer_1 = require("./analysis/analyzer");
const chunking_1 = require("./analysis/chunking");
const language_1 = require("./analysis/language");
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
const execAsync = (0, util_1.promisify)(child_process_1.exec);
async function ensureIndex(workspace) {
    const existing = await loadIndex(workspace);
    if (existing) {
        return existing;
    }
    return rebuildIndex(workspace);
}
async function loadIndex(workspace) {
    const indexPath = await getIndexPath(workspace);
    try {
        const raw = await fs_1.promises.readFile(indexPath, "utf-8");
        return JSON.parse(raw);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
async function rebuildIndex(workspace, options = {}) {
    const { silent = false } = options;
    const config = (0, config_1.getPipelineConfig)();
    const workspacePath = workspace.uri.fsPath;
    const pattern = "**/*";
    const ignoreMatcher = await buildIgnoreMatcher(workspacePath, config.ignoredGlobs);
    let previousIndex;
    try {
        previousIndex = await loadIndex(workspace);
    }
    catch (error) {
        console.warn("Failed to load previous index, proceeding with a fresh build", error);
    }
    const previousFileMetadata = previousIndex?.fileMetadata ?? {};
    const previousChunksByFile = new Map();
    previousIndex?.chunks.forEach((chunk) => {
        const list = previousChunksByFile.get(chunk.relativePath) ?? [];
        list.push(chunk);
        previousChunksByFile.set(chunk.relativePath, list);
    });
    const gitInfo = await collectGitMetadata(workspacePath);
    const touchedSet = new Set();
    (options.touchedFiles ?? []).forEach((file) => {
        const relative = path.relative(workspacePath, file);
        if (!relative || relative.startsWith("..")) {
            return;
        }
        touchedSet.add(toPosixPath(relative));
    });
    if (!silent) {
        vscode.window.showInformationMessage("AI pipeline is indexing workspace files...");
    }
    const files = await (0, glob_1.glob)(pattern, {
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
    const chunks = [];
    const newChunks = [];
    const analyses = [];
    const fileMetadata = {};
    const charSize = config.chunkSize * 4;
    const overlapChars = config.chunkOverlap * 4;
    const changedFiles = [];
    const reusedFiles = [];
    const cpuCount = (0, os_1.cpus)().length || 1;
    const maxWorkers = config.maxConcurrentWorkers > 0
        ? config.maxConcurrentWorkers
        : Math.max(1, Math.min(8, cpuCount - 1));
    const concurrency = Math.max(1, Math.min(maxWorkers, fileEntries.length || 1));
    const defaultBudget = Math.floor((0, os_1.totalmem)() * 0.25);
    const configuredBudget = config.memoryBudgetMb > 0 ? config.memoryBudgetMb * 1024 * 1024 : 0;
    const memoryBudget = configuredBudget > 0
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
            let lstat;
            try {
                lstat = await fs_1.promises.lstat(filePath);
            }
            catch (error) {
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
            const isTouched = touchedSet.size === 0 ? true : touchedSet.has(posixPath);
            const hasSameStat = previousMeta != null &&
                previousMeta.size === lstat.size &&
                Math.round(previousMeta.mtimeMs) === Math.round(lstat.mtimeMs);
            const canReuse = previousMeta != null &&
                previousChunks.length > 0 &&
                (!isTouched || hasSameStat);
            if (canReuse) {
                reusedFiles.push(posixPath);
                const updatedMeta = {
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
                    const existingHash = chunk.hash ?? createChunkHash(posixPath, chunk.content);
                    chunks.push({ ...chunk, hash: existingHash });
                });
                continue;
            }
            const nextTotal = processedBytes + lstat.size;
            processedBytes = nextTotal;
            const forceStream = nextTotal > memoryBudget;
            if (forceStream && !memoryWarningIssued) {
                memoryWarningIssued = true;
                console.warn(`AI Pipeline indexer hit memory budget (${Math.round(memoryBudget / (1024 * 1024))} MB). Falling back to streaming mode for remaining files.`);
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
            const metadata = {
                ...result.analysis,
                hash: result.hash,
                size: lstat.size,
                mtimeMs: lstat.mtimeMs,
                gitStatus,
                hasConflicts,
            };
            fileMetadata[posixPath] = metadata;
            result.chunks.forEach((chunk, index) => {
                const chunkRecord = {
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
    const dependencyGraph = (0, analyzer_1.buildDependencyGraph)(analyses);
    const unusedSymbols = (0, analyzer_1.detectUnusedSymbols)(analyses, dependencyGraph);
    if (newChunks.length > 0) {
        const embeddings = new openai_1.OpenAIEmbeddings({
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
    const repoIndex = {
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
    await fs_1.promises.mkdir(path.dirname(indexPath), { recursive: true });
    await fs_1.promises.writeFile(indexPath, JSON.stringify(repoIndex), "utf-8");
    if (!silent) {
        vscode.window.showInformationMessage(`AI pipeline index refreshed (${changedFiles.length} updated, ${reusedFiles.length} cached).`);
    }
    return repoIndex;
}
function similaritySearch(repoIndex, queryEmbedding, topK = 8) {
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
async function getIndexPath(workspace) {
    const dir = path.join(workspace.uri.fsPath, STORE_DIR);
    return path.join(dir, INDEX_FILE);
}
async function processFile({ filePath, relativePath, charSize, overlapChars, stat, forceStream = false, }) {
    const treatAsLarge = forceStream || stat.size > LARGE_FILE_THRESHOLD_BYTES;
    if (treatAsLarge) {
        const sample = await readFilePrefix(filePath, 128 * 1024);
        const previewText = sample.toString("utf-8");
        const previewAnalysis = (0, analyzer_1.analyzeSource)({
            relativePath,
            sourceText: previewText,
        }).analysis;
        const streamed = await streamAndChunkFile(filePath, charSize, overlapChars, relativePath);
        return {
            chunks: streamed.chunks,
            analysis: annotateLargeFileAnalysis(previewAnalysis, stat.size, relativePath, streamed.hash),
            hash: streamed.hash,
        };
    }
    const text = await fs_1.promises.readFile(filePath, "utf-8");
    const analysisResult = (0, analyzer_1.analyzeSource)({
        relativePath,
        sourceText: text,
    });
    const analysis = analysisResult.analysis;
    const semanticChunks = (0, chunking_1.semanticChunk)(text, relativePath, analysis, {
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
function computeChunkComplexity(symbols, analysis) {
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
async function streamAndChunkFile(filePath, chunkSize, overlap, relativePath) {
    const results = [];
    const stream = (0, fs_1.createReadStream)(filePath, {
        encoding: "utf-8",
        highWaterMark: Math.max(chunkSize, MAX_STREAM_HIGH_WATER_MARK),
    });
    const hash = (0, crypto_1.createHash)("sha1");
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
async function readFilePrefix(filePath, bytes) {
    const handle = await fs_1.promises.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}
function annotateLargeFileAnalysis(analysis, fileSize, relativePath, fileHash) {
    const language = analysis.language === "unknown"
        ? (0, language_1.detectLanguage)(relativePath)
        : analysis.language;
    return {
        ...analysis,
        language,
        hash: fileHash,
        complexity: {
            ...analysis.complexity,
            totalComplexity: Math.max(analysis.complexity.totalComplexity, 1),
        },
        isLikelyGenerated: analysis.isLikelyGenerated || fileSize > 20 * 1024 * 1024,
    };
}
function createChunkHash(relativePath, content) {
    return (0, crypto_1.createHash)("sha1")
        .update(relativePath)
        .update("\u0000")
        .update(content)
        .digest("hex");
}
function isBinaryContent(buffer) {
    for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] === 0) {
            return true;
        }
    }
    return false;
}
function cosineSimilarity(a, b) {
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
async function collectGitMetadata(workspacePath) {
    const statusMap = new Map();
    const conflictFiles = new Set();
    const summary = [];
    let branch;
    try {
        const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
            cwd: workspacePath,
        });
        branch = stdout.trim() || undefined;
    }
    catch {
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
    }
    catch {
        // not a git repository, ignore
    }
    return {
        branch,
        statusMap,
        conflictFiles,
        summary,
    };
}
async function collectRepoTopology(workspacePath, entries) {
    const packages = [];
    const seen = new Set();
    const addPackage = (info) => {
        if (seen.has(info.path)) {
            return;
        }
        seen.add(info.path);
        packages.push(info);
    };
    const manifestEntries = entries.filter((entry) => entry.posixPath.endsWith("package.json"));
    for (const entry of manifestEntries) {
        const manifestPath = path.join(workspacePath, entry.relativePath);
        try {
            const raw = await fs_1.promises.readFile(manifestPath, "utf-8");
            const manifest = JSON.parse(raw);
            const dir = entry.posixPath === "package.json"
                ? "."
                : path.posix.dirname(entry.posixPath);
            const name = typeof manifest.name === "string" ? manifest.name : undefined;
            const hasWorkspaces = Array.isArray(manifest.workspaces) ||
                (manifest.workspaces &&
                    Array.isArray(manifest.workspaces.packages));
            const kind = hasWorkspaces
                ? "workspace"
                : "package";
            addPackage({
                path: dir,
                name,
                kind,
                language: "javascript",
            });
        }
        catch (error) {
            console.warn(`Failed to parse package manifest at ${manifestPath}`, error);
        }
    }
    const goModules = entries.filter((entry) => entry.posixPath.endsWith("go.mod"));
    for (const entry of goModules) {
        const modulePath = path.join(workspacePath, entry.relativePath);
        try {
            const raw = await fs_1.promises.readFile(modulePath, "utf-8");
            const match = raw.match(/^\s*module\s+([^\s]+)/m);
            const moduleName = match ? match[1].trim() : undefined;
            const dir = entry.posixPath === "go.mod"
                ? "."
                : path.posix.dirname(entry.posixPath);
            addPackage({
                path: dir,
                name: moduleName,
                kind: "module",
                language: "go",
            });
        }
        catch (error) {
            console.warn(`Failed to parse go.mod at ${modulePath}`, error);
        }
    }
    const cargoTomls = entries.filter((entry) => entry.posixPath.endsWith("Cargo.toml"));
    for (const entry of cargoTomls) {
        const cargoPath = path.join(workspacePath, entry.relativePath);
        try {
            const raw = await fs_1.promises.readFile(cargoPath, "utf-8");
            const match = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
            const dir = entry.posixPath === "Cargo.toml"
                ? "."
                : path.posix.dirname(entry.posixPath);
            addPackage({
                path: dir,
                name: match ? match[1] : undefined,
                kind: "module",
                language: "rust",
            });
        }
        catch (error) {
            console.warn(`Failed to parse Cargo.toml at ${cargoPath}`, error);
        }
    }
    const pyProjects = entries.filter((entry) => entry.posixPath.endsWith("pyproject.toml"));
    for (const entry of pyProjects) {
        const projectPath = path.join(workspacePath, entry.relativePath);
        try {
            const raw = await fs_1.promises.readFile(projectPath, "utf-8");
            const match = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m) ??
                raw.match(/^\s*project\s*=\s*["']([^"']+)["']/m);
            const dir = entry.posixPath === "pyproject.toml"
                ? "."
                : path.posix.dirname(entry.posixPath);
            addPackage({
                path: dir,
                name: match ? match[1] : undefined,
                kind: "module",
                language: "python",
            });
        }
        catch (error) {
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
            path: entry.posixPath.indexOf("/") === -1
                ? "."
                : path.posix.dirname(entry.posixPath),
            kind: "workspace",
            language: "javascript",
        });
    });
    let submodules = [];
    try {
        const gitmodules = await fs_1.promises.readFile(path.join(workspacePath, ".gitmodules"), "utf-8");
        const matches = gitmodules.matchAll(/^\s*path\s*=\s*(.+)$/gm);
        submodules = Array.from(matches)
            .map((match) => match[1]?.trim())
            .filter((value) => Boolean(value))
            .map((value) => toPosixPath(value));
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            console.warn("Failed to read .gitmodules", error);
        }
    }
    return {
        packages,
        submodules,
    };
}
async function buildIgnoreMatcher(workspacePath, additionalPatterns) {
    const patterns = [];
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
async function readIgnoreFile(filePath) {
    try {
        const raw = await fs_1.promises.readFile(filePath, "utf-8");
        return raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        console.warn(`Failed to read ignore file at ${filePath}`, error);
        return undefined;
    }
}
function shouldIgnore(relativePath, rules) {
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
function createIgnoreRule(pattern) {
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
function globToRegExp(pattern) {
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
function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function toPosixPath(relativePath) {
    return relativePath.split(path.sep).join("/");
}
function computeFilePriority(relativePath) {
    const value = relativePath.toLowerCase();
    let score = 0;
    const priorityPatterns = [
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
async function isBinaryFile(filePath, size) {
    if (size === 0) {
        return false;
    }
    const sampleSize = Math.min(size, 4096);
    const handle = await fs_1.promises.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(sampleSize);
        const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
        return isBinaryContent(buffer.subarray(0, bytesRead));
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=indexer.js.map