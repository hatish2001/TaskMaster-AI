"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeTypeScript = analyzeTypeScript;
const typescript_1 = __importDefault(require("typescript"));
const utils_1 = require("./utils");
const CYCLIC_KINDS = new Set([
    typescript_1.default.SyntaxKind.IfStatement,
    typescript_1.default.SyntaxKind.ForStatement,
    typescript_1.default.SyntaxKind.ForOfStatement,
    typescript_1.default.SyntaxKind.ForInStatement,
    typescript_1.default.SyntaxKind.WhileStatement,
    typescript_1.default.SyntaxKind.DoStatement,
    typescript_1.default.SyntaxKind.CaseClause,
    typescript_1.default.SyntaxKind.CatchClause,
    typescript_1.default.SyntaxKind.ConditionalExpression,
    typescript_1.default.SyntaxKind.BinaryExpression,
    typescript_1.default.SyntaxKind.SwitchStatement,
]);
const COMPLEXITY_BINARY_OPERATORS = new Set([
    typescript_1.default.SyntaxKind.AmpersandAmpersandToken,
    typescript_1.default.SyntaxKind.BarBarToken,
    typescript_1.default.SyntaxKind.QuestionQuestionToken,
]);
function analyzeTypeScript({ fileName, sourceText, }) {
    const sourceFile = typescript_1.default.createSourceFile(fileName, sourceText, typescript_1.default.ScriptTarget.Latest, 
    /*setParentNodes*/ true);
    const imports = [];
    const exports = [];
    const symbols = [];
    const comments = [];
    const symbolComplexity = new Map();
    let totalComplexity = 0;
    let maxComplexity = 0;
    const visit = (node) => {
        if (typescript_1.default.isImportDeclaration(node) && node.moduleSpecifier) {
            imports.push(stripQuotes(node.moduleSpecifier.getText(sourceFile)));
        }
        if (typescript_1.default.isExportDeclaration(node) && node.moduleSpecifier) {
            exports.push(stripQuotes(node.moduleSpecifier.getText(sourceFile)));
        }
        if (typescript_1.default.isExportAssignment(node)) {
            exports.push("default");
        }
        if (isSymbolDeclaration(node)) {
            const symbol = createSymbolInfo(node, sourceFile);
            symbols.push(symbol);
            analyzeSymbolComplexity(node, sourceFile, symbol, symbolComplexity);
        }
        const nodeComments = collectComments(node, sourceText);
        nodeComments.forEach((comment) => comments.push(comment));
        typescript_1.default.forEachChild(node, visit);
    };
    visit(sourceFile);
    symbolComplexity.forEach((value, name) => {
        totalComplexity += value;
        if (value > maxComplexity) {
            maxComplexity = value;
        }
    });
    const isLikelyGenerated = hasGeneratedMarker(sourceText) ||
        /(^|\/)(dist|build|generated|vendor)\//.test(fileName);
    return {
        language: "typescript",
        imports: Array.from(new Set(imports)),
        exports: Array.from(new Set(exports)),
        symbols,
        comments,
        complexity: buildComplexityReport(symbols, totalComplexity, maxComplexity, symbolComplexity),
        isLikelyGenerated,
        hasShebang: sourceText.startsWith("#!"),
        hash: (0, utils_1.hashContent)(sourceText),
    };
}
function stripQuotes(value) {
    return value.replace(/^['"`]|['"`]$/g, "");
}
function isSymbolDeclaration(node) {
    return (typescript_1.default.isClassDeclaration(node) ||
        typescript_1.default.isInterfaceDeclaration(node) ||
        typescript_1.default.isFunctionDeclaration(node) ||
        typescript_1.default.isMethodDeclaration(node) ||
        typescript_1.default.isEnumDeclaration(node) ||
        typescript_1.default.isVariableDeclaration(node) ||
        typescript_1.default.isTypeAliasDeclaration(node));
}
function createSymbolInfo(node, sourceFile) {
    const name = node.name
        ? node.name.getText(sourceFile)
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
function inferSymbolKind(node) {
    if (typescript_1.default.isClassDeclaration(node)) {
        return "class";
    }
    if (typescript_1.default.isInterfaceDeclaration(node)) {
        return "interface";
    }
    if (typescript_1.default.isEnumDeclaration(node)) {
        return "enum";
    }
    if (typescript_1.default.isMethodDeclaration(node)) {
        return "method";
    }
    if (typescript_1.default.isFunctionDeclaration(node)) {
        return "function";
    }
    if (typescript_1.default.isTypeAliasDeclaration(node)) {
        return "type";
    }
    if (typescript_1.default.isVariableDeclaration(node)) {
        return "variable";
    }
    return "property";
}
function createRange(node, sourceFile) {
    return {
        start: node.getStart(sourceFile),
        end: node.getEnd(),
    };
}
function hasExportModifier(node) {
    if (typeof typescript_1.default.canHaveModifiers === "function" && typeof typescript_1.default.getModifiers === "function") {
        if (!typescript_1.default.canHaveModifiers(node)) {
            return false;
        }
        const modifiers = typescript_1.default.getModifiers(node) ?? [];
        return modifiers.some((modifier) => modifier.kind === typescript_1.default.SyntaxKind.ExportKeyword);
    }
    const legacyModifiers = node.modifiers;
    return (legacyModifiers?.some((modifier) => modifier.kind === typescript_1.default.SyntaxKind.ExportKeyword) ?? false);
}
function analyzeSymbolComplexity(node, sourceFile, complexityStore, symbolComplexity) {
    let complexity = 1; // baseline
    const walk = (child) => {
        if (CYCLIC_KINDS.has(child.kind)) {
            complexity += 1;
        }
        if (typescript_1.default.isBinaryExpression(child)) {
            if (COMPLEXITY_BINARY_OPERATORS.has(child.operatorToken.kind)) {
                complexity += 1;
            }
        }
        typescript_1.default.forEachChild(child, walk);
    };
    typescript_1.default.forEachChild(node, walk);
    const existing = symbolComplexity.get(complexityStore.name) ?? 0;
    const total = existing + complexity;
    symbolComplexity.set(complexityStore.name, total);
}
function collectComments(node, text) {
    const comments = [];
    const processRange = (pos, end, kind) => {
        const commentText = text.slice(pos, end);
        comments.push({
            type: kind,
            text: commentText,
            range: { start: pos, end },
        });
    };
    const ranges = typescript_1.default.getLeadingCommentRanges(text, node.pos) ?? [];
    const trailing = typescript_1.default.getTrailingCommentRanges(text, node.end) ?? [];
    [...ranges, ...trailing].forEach((range) => {
        const kind = range.kind === typescript_1.default.SyntaxKind.SingleLineCommentTrivia ? "line" : "block";
        processRange(range.pos, range.end, kind);
    });
    return comments;
}
function hasGeneratedMarker(text) {
    return /@generated|do not edit|auto[- ]generated/i.test(text);
}
function buildComplexityReport(symbols, totalComplexity, maxComplexity, store) {
    const count = symbols.length || 1;
    const average = totalComplexity / count;
    const map = {};
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
//# sourceMappingURL=tsAnalyzer.js.map