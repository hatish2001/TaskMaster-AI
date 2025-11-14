import {
  DependencyEdge,
  DependencyGraph,
  FileAnalysis,
  LanguageId,
  SymbolInfo,
  UnusedSymbol,
} from "./types";
import { detectLanguage } from "./language";
import { analyzeTypeScript } from "./tsAnalyzer";
import { analyzeGenerically } from "./genericAnalyzer";
import { dedupeStrings, hashContent } from "./utils";

export interface AnalysisOptions {
  relativePath: string;
  sourceText: string;
}

export interface AnalysisResult {
  file: string;
  analysis: FileAnalysis;
}

export function analyzeSource({
  relativePath,
  sourceText,
}: AnalysisOptions): AnalysisResult {
  const language = detectLanguage(relativePath);

  if (language === "typescript" || language === "javascript") {
    return {
      file: relativePath,
      analysis: analyzeTypeScript({
        fileName: relativePath,
        sourceText,
      }),
    };
  }

  if (language === "unknown") {
    return {
      file: relativePath,
      analysis: {
        language,
        imports: [],
        exports: [],
        symbols: [],
        comments: [],
        complexity: {
          totalComplexity: 0,
          averagePerSymbol: 0,
          maxPerSymbol: 0,
          symbolComplexities: {},
        },
        isLikelyGenerated: /@generated|do not edit/i.test(sourceText),
        hasShebang: sourceText.startsWith("#!"),
        hash: hashContent(sourceText),
      },
    };
  }

  return {
    file: relativePath,
    analysis: analyzeGenerically({
      language,
      sourceText,
      fileName: relativePath,
    }),
  };
}

export function buildDependencyGraph(
  analyses: AnalysisResult[]
): DependencyGraph {
  const edges: DependencyEdge[] = [];
  const adjacency: Record<string, string[]> = {};

  analyses.forEach(({ file, analysis }) => {
    const neighbors: string[] = [];
    analysis.imports.forEach((spec) => {
      const normalized = normalizeImport(file, spec);
      if (!normalized) {
        return;
      }
      edges.push({
        from: file,
        to: normalized,
        kind: inferEdgeKind(spec),
      });
      neighbors.push(normalized);
    });
    adjacency[file] = dedupeStrings(neighbors);
  });

  return {
    edges,
    adjacency,
  };
}

export function detectUnusedSymbols(
  analyses: AnalysisResult[],
  dependencyGraph: DependencyGraph
): UnusedSymbol[] {
  const unused: UnusedSymbol[] = [];
  const importUsage = new Map<string, Set<string>>();

  analyses.forEach(({ file }) => {
    importUsage.set(file, new Set());
  });

  dependencyGraph.edges.forEach((edge) => {
    const usage = importUsage.get(edge.to);
    if (!usage) {
      return;
    }
    usage.add(edge.from);
  });

  analyses.forEach(({ file, analysis }) => {
    const consumers = importUsage.get(file);
    const isConsumedElsewhere = (symbol: SymbolInfo) =>
      (consumers?.size ?? 0) > 0 || symbol.isExported === false;

    analysis.symbols.forEach((symbol) => {
      if (symbol.isExported && !isConsumedElsewhere(symbol)) {
        unused.push({
          file,
          symbol: symbol.name,
          kind: symbol.kind,
        });
      }
    });
  });

  return unused;
}

function normalizeImport(
  fromFile: string,
  specifier: string
): string | undefined {
  if (!specifier) {
    return undefined;
  }

  if (specifier.startsWith(".")) {
    const joined = normalizePath(fromFile, specifier);
    return joined;
  }

  return specifier;
}

function normalizePath(fromFile: string, specifier: string): string {
  const baseSegments = fromFile.split("/");
  baseSegments.pop();
  const specSegments = specifier.split("/");

  specSegments.forEach((segment) => {
    if (segment === "." || segment.length === 0) {
      return;
    }
    if (segment === "..") {
      baseSegments.pop();
      return;
    }
    baseSegments.push(segment);
  });

  return baseSegments.join("/");
}

function inferEdgeKind(spec: string): DependencyEdge["kind"] {
  if (/dynamic|require\(/i.test(spec)) {
    return "dynamic";
  }
  if (/^@|^\./.test(spec)) {
    return "import";
  }
  return "import";
}


