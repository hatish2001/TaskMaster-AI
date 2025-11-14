import ts from "typescript";
import {
  CommentBlock,
  ComplexityReport,
  FileAnalysis,
  SymbolInfo,
  SymbolKind,
  SymbolRange,
} from "./types";
import { hashContent } from "./utils";

interface AnalyzeOptions {
  fileName: string;
  sourceText: string;
}

const CYCLIC_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.SwitchStatement,
]);

const COMPLEXITY_BINARY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

export function analyzeTypeScript({
  fileName,
  sourceText,
}: AnalyzeOptions): FileAnalysis {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true
  );

  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: SymbolInfo[] = [];
  const comments: CommentBlock[] = [];
  const symbolComplexity = new Map<string, number>();
  let totalComplexity = 0;
  let maxComplexity = 0;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      imports.push(stripQuotes(node.moduleSpecifier.getText(sourceFile)));
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      exports.push(stripQuotes(node.moduleSpecifier.getText(sourceFile)));
    }

    if (ts.isExportAssignment(node)) {
      exports.push("default");
    }

    if (isSymbolDeclaration(node)) {
      const symbol = createSymbolInfo(node, sourceFile);
      symbols.push(symbol);
      analyzeSymbolComplexity(node, sourceFile, symbol, symbolComplexity);
    }

    const nodeComments = collectComments(node, sourceText);
    nodeComments.forEach((comment) => comments.push(comment));

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  symbolComplexity.forEach((value, name) => {
    totalComplexity += value;
    if (value > maxComplexity) {
      maxComplexity = value;
    }
  });

  const isLikelyGenerated =
    hasGeneratedMarker(sourceText) ||
    /(^|\/)(dist|build|generated|vendor)\//.test(fileName);

  return {
    language: "typescript",
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
    symbols,
    comments,
    complexity: buildComplexityReport(
      symbols,
      totalComplexity,
      maxComplexity,
      symbolComplexity
    ),
    isLikelyGenerated,
    hasShebang: sourceText.startsWith("#!"),
    hash: hashContent(sourceText),
  };
}

function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}

function isSymbolDeclaration(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  );
}

function createSymbolInfo(
  node: ts.Node,
  sourceFile: ts.SourceFile
): SymbolInfo {
  const name = (node as { name?: ts.Node }).name
    ? (node as { name?: ts.Node }).name!.getText(sourceFile)
    : "default";

  const kind = inferSymbolKind(node);
  const range = createRange(node, sourceFile);
  const isExported = hasExportModifier(node);

  return {
    name,
    kind,
    range,
    isExported,
  };
}

function inferSymbolKind(node: ts.Node): SymbolKind {
  if (ts.isClassDeclaration(node)) {
    return "class";
  }
  if (ts.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (ts.isEnumDeclaration(node)) {
    return "enum";
  }
  if (ts.isMethodDeclaration(node)) {
    return "method";
  }
  if (ts.isFunctionDeclaration(node)) {
    return "function";
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return "type";
  }
  if (ts.isVariableDeclaration(node)) {
    return "variable";
  }
  return "property";
}

function createRange(node: ts.Node, sourceFile: ts.SourceFile): SymbolRange {
  return {
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  };
}

function hasExportModifier(node: ts.Node): boolean {
  if (typeof ts.canHaveModifiers === "function" && typeof ts.getModifiers === "function") {
    if (!ts.canHaveModifiers(node)) {
      return false;
    }
    const modifiers = ts.getModifiers(node) ?? [];
    return modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
  }

  const legacyModifiers = (node as ts.Node & {
    modifiers?: ts.NodeArray<ts.Modifier>;
  }).modifiers;
  return (
    legacyModifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    ) ?? false
  );
}

function analyzeSymbolComplexity(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  complexityStore: SymbolInfo,
  symbolComplexity: Map<string, number>
) {
  let complexity = 1; // baseline

  const walk = (child: ts.Node) => {
    if (CYCLIC_KINDS.has(child.kind)) {
      complexity += 1;
    }
    if (ts.isBinaryExpression(child)) {
      if (COMPLEXITY_BINARY_OPERATORS.has(child.operatorToken.kind)) {
        complexity += 1;
      }
    }
    ts.forEachChild(child, walk);
  };

  ts.forEachChild(node, walk);
  const existing = symbolComplexity.get(complexityStore.name) ?? 0;
  const total = existing + complexity;
  symbolComplexity.set(complexityStore.name, total);
}

function collectComments(node: ts.Node, text: string): CommentBlock[] {
  const comments: CommentBlock[] = [];

  const processRange = (
    pos: number,
    end: number,
    kind: "line" | "block"
  ) => {
    const commentText = text.slice(pos, end);
    comments.push({
      type: kind,
      text: commentText,
      range: { start: pos, end },
    });
  };

  const ranges =
    ts.getLeadingCommentRanges(text, node.pos) ?? ([] as ts.CommentRange[]);
  const trailing =
    ts.getTrailingCommentRanges(text, node.end) ?? ([] as ts.CommentRange[]);

  [...ranges, ...trailing].forEach((range) => {
    const kind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block";
    processRange(range.pos, range.end, kind);
  });

  return comments;
}

function hasGeneratedMarker(text: string): boolean {
  return /@generated|do not edit|auto[- ]generated/i.test(text);
}

function buildComplexityReport(
  symbols: SymbolInfo[],
  totalComplexity: number,
  maxComplexity: number,
  store: Map<string, number>
): ComplexityReport {
  const count = symbols.length || 1;
  const average = totalComplexity / count;
  const map: Record<string, number> = {};
  store.forEach((value, key) => {
    map[key] = value;
  });
  return {
    totalComplexity,
    averagePerSymbol: parseFloat(average.toFixed(2)),
    maxPerSymbol: maxComplexity,
    symbolComplexities: map,
  };
}


