import {
  CommentBlock,
  ComplexityReport,
  FileAnalysis,
  SymbolInfo,
  SymbolKind,
} from "./types";
import { hashContent } from "./utils";

interface GenericAnalyzerOptions {
  language: string;
  sourceText: string;
  fileName: string;
}

const IMPORT_PATTERNS: Array<{ language: string; regex: RegExp }> = [
  { language: "python", regex: /^\s*(from\s+\S+\s+)?import\s+.+$/gm },
  { language: "go", regex: /^\s*import\s+\(.+?\)|^\s*import\s+.+$/gms },
  { language: "java", regex: /^\s*import\s+[\w.*]+;/gm },
  { language: "rust", regex: /^\s*use\s+.+$/gm },
  { language: "php", regex: /^\s*use\s+.+;/gm },
  { language: "ruby", regex: /^\s*(require|include)\s+.+$/gm },
];

const COMMENT_PATTERNS: Array<{ regex: RegExp; kind: "line" | "block" }> = [
  { regex: /#.*$/gm, kind: "line" },
  { regex: /\/\/.*$/gm, kind: "line" },
  { regex: /\/\*[\s\S]*?\*\//gm, kind: "block" },
];

export function analyzeGenerically({
  language,
  sourceText,
  fileName,
}: GenericAnalyzerOptions): FileAnalysis {
  const imports = collectImports(language, sourceText);
  const comments = collectComments(sourceText);
  const symbols = collectSymbolHeuristics(language, sourceText);
  const complexity = {
    totalComplexity: symbols.length,
    averagePerSymbol: symbols.length ? 1 : 0,
    maxPerSymbol: symbols.length ? 1 : 0,
    symbolComplexities: Object.fromEntries(symbols.map((s) => [s.name, 1])),
  } satisfies ComplexityReport;

  return {
    language: language as any,
    imports,
    exports: [],
    symbols,
    comments,
    complexity,
    isLikelyGenerated: /@generated|do not edit/i.test(sourceText),
    hasShebang: sourceText.startsWith("#!"),
    hash: hashContent(sourceText),
  };
}

function collectImports(language: string, text: string): string[] {
  const pattern = IMPORT_PATTERNS.find((item) => item.language === language);
  if (!pattern) {
    return [];
  }
  const matches = text.match(pattern.regex) ?? [];
  return matches.map((line) => line.trim());
}

function collectComments(text: string): CommentBlock[] {
  const comments: CommentBlock[] = [];
  COMMENT_PATTERNS.forEach((entry) => {
    const match = text.matchAll(entry.regex);
    for (const found of match) {
      if (found.index === undefined) {
        continue;
      }
      comments.push({
        type: entry.kind,
        text: found[0],
        range: {
          start: found.index,
          end: found.index + found[0].length,
        },
      });
    }
  });
  return comments;
}

function collectSymbolHeuristics(
  language: string,
  text: string
): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const patterns: Record<string, RegExp> = {
    python: /^def\s+([\w_]+)\s*\(.*\)|^class\s+([\w_]+)/gm,
    go: /^func\s+([\w_]+)\s*\(.*\)/gm,
    java: /(class|interface)\s+([\w_]+)/gm,
    rust: /(fn|struct|enum)\s+([\w_]+)/gm,
    ruby: /(def|class)\s+([\w_]+)/gm,
    php: /(function|class)\s+([\w_]+)/gm,
  };

  const pattern = patterns[language];
  if (!pattern) {
    return symbols;
  }

  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const name = match[1] ?? match[2];
    if (name) {
      symbols.push({
        name,
        kind: inferKind(language, match[0]),
        range: {
          start: match.index ?? 0,
          end: (match.index ?? 0) + match[0].length,
        },
      });
    }
    match = pattern.exec(text);
  }

  return symbols;
}

function inferKind(language: string, snippet: string): SymbolKind {
  if (/class/.test(snippet)) {
    return "class";
  }
  if (/interface/.test(snippet)) {
    return "interface";
  }
  if (/(fn|def|function)/.test(snippet)) {
    return "function";
  }
  if (/enum/.test(snippet)) {
    return "enum";
  }
  return "variable";
}


