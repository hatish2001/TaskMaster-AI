"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.semanticChunk = semanticChunk;
exports.chunkSummary = chunkSummary;
const utils_1 = require("./utils");
function semanticChunk(text, filePath, analysis, { maxChars, overlapChars, dynamicScaling = true }) {
    if (analysis.symbols.length === 0) {
        return slidingChunks(text, filePath, { maxChars, overlapChars });
    }
    const effectiveMax = dynamicScaling
        ? computeDynamicChunkSize(maxChars, analysis)
        : maxChars;
    const chunks = [];
    let buffer = "";
    let start = 0;
    let activeSymbols = [];
    const emitChunk = (end) => {
        if (!buffer.trim()) {
            buffer = "";
            start = end;
            activeSymbols = [];
            return;
        }
        chunks.push({
            id: `${filePath}:${chunks.length}`,
            content: buffer,
            start,
            end,
            symbols: (0, utils_1.dedupeStrings)(activeSymbols),
        });
        const retainFrom = (0, utils_1.clamp)(buffer.length - overlapChars, 0, buffer.length);
        buffer = buffer.slice(retainFrom);
        start = end - buffer.length;
        activeSymbols = activeSymbols.slice(-2);
    };
    analysis.symbols
        .slice()
        .sort((a, b) => a.range.start - b.range.start)
        .forEach((symbol) => {
        const snippet = text.slice(symbol.range.start, symbol.range.end);
        if (buffer.length + snippet.length > effectiveMax) {
            emitChunk(symbol.range.start);
        }
        buffer += snippet;
        activeSymbols.push(symbol.name);
        if (buffer.length >= effectiveMax * 0.75) {
            emitChunk(symbol.range.end);
        }
    });
    if (buffer.length > 0) {
        emitChunk(text.length);
    }
    if (chunks.length === 0) {
        return slidingChunks(text, filePath, { maxChars, overlapChars });
    }
    return dedupeChunks(chunks);
}
function slidingChunks(text, filePath, { maxChars, overlapChars }) {
    const results = [];
    let pointer = 0;
    while (pointer < text.length) {
        const end = Math.min(text.length, pointer + maxChars);
        const chunk = text.slice(pointer, end);
        results.push({
            id: `${filePath}:${results.length}`,
            content: chunk,
            start: pointer,
            end,
            symbols: [],
        });
        if (end === text.length) {
            break;
        }
        pointer = end - overlapChars;
        if (pointer < 0) {
            pointer = 0;
        }
    }
    return results;
}
function computeDynamicChunkSize(maxChars, analysis) {
    const complexity = analysis.complexity.totalComplexity || 1;
    if (complexity > 50) {
        return Math.floor(maxChars * 0.75);
    }
    if (complexity < 10) {
        return Math.floor(maxChars * 1.1);
    }
    return maxChars;
}
function dedupeChunks(chunks) {
    const seen = new Set();
    return chunks.filter((chunk) => {
        const key = chunk.content.trim();
        if (!key) {
            return false;
        }
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function chunkSummary(chunks) {
    return chunks.map((chunk) => chunk.symbols.join(",")).filter(Boolean);
}
//# sourceMappingURL=chunking.js.map