export type LanguageId =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "go"
  | "rust"
  | "csharp"
  | "ruby"
  | "php"
  | "unknown";

export interface SymbolRange {
  start: number;
  end: number;
}

export type SymbolKind =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "property"
  | "enum"
  | "type"
  | "variable";

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  range: SymbolRange;
  complexity?: number;
  isExported?: boolean;
}

export interface CommentBlock {
  type: "block" | "line";
  text: string;
  range: SymbolRange;
}

export interface ComplexityReport {
  totalComplexity: number;
  averagePerSymbol: number;
  maxPerSymbol: number;
  symbolComplexities: Record<string, number>;
}

export interface FileAnalysis {
  language: LanguageId;
  imports: string[];
  exports: string[];
  symbols: SymbolInfo[];
  comments: CommentBlock[];
  complexity: ComplexityReport;
  isLikelyGenerated: boolean;
  hasShebang: boolean;
  hash: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: "import" | "require" | "dynamic";
}

export interface DependencyGraph {
  edges: DependencyEdge[];
  adjacency: Record<string, string[]>;
}

export interface UnusedSymbol {
  file: string;
  symbol: string;
  kind: SymbolKind;
}


