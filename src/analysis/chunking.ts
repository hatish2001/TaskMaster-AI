import { clamp, dedupeStrings } from "./utils";
import { FileAnalysis, SymbolInfo } from "./types";

export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
  dynamicScaling?: boolean;
}

export interface Chunk {
  id: string;
  content: string;
  start: number;
  end: number;
  symbols: string[];
}

export function semanticChunk(
  text: string,
  filePath: string,
  analysis: FileAnalysis,
  { maxChars, overlapChars, dynamicScaling = true }: ChunkOptions
): Chunk[] {
  if (analysis.symbols.length === 0) {
    return slidingChunks(text, filePath, { maxChars, overlapChars });
  }

  const effectiveMax = dynamicScaling
    ? computeDynamicChunkSize(maxChars, analysis)
    : maxChars;

  const chunks: Chunk[] = [];
  let buffer = "";
  let start = 0;
  let activeSymbols: string[] = [];

  const emitChunk = (end: number) => {
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
      symbols: dedupeStrings(activeSymbols),
    });
    const retainFrom = clamp(buffer.length - overlapChars, 0, buffer.length);
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

function slidingChunks(
  text: string,
  filePath: string,
  { maxChars, overlapChars }: ChunkOptions
): Chunk[] {
  const results: Chunk[] = [];
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

function computeDynamicChunkSize(
  maxChars: number,
  analysis: FileAnalysis
): number {
  const complexity = analysis.complexity.totalComplexity || 1;
  if (complexity > 50) {
    return Math.floor(maxChars * 0.75);
  }
  if (complexity < 10) {
    return Math.floor(maxChars * 1.1);
  }
  return maxChars;
}

function dedupeChunks(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
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

export function chunkSummary(chunks: Chunk[]): string[] {
  return chunks.map((chunk) => chunk.symbols.join(",")).filter(Boolean);
}


