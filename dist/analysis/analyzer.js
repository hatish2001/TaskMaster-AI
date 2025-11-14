"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeSource = analyzeSource;
exports.buildDependencyGraph = buildDependencyGraph;
exports.detectUnusedSymbols = detectUnusedSymbols;
const language_1 = require("./language");
const tsAnalyzer_1 = require("./tsAnalyzer");
const genericAnalyzer_1 = require("./genericAnalyzer");
const utils_1 = require("./utils");
function analyzeSource({ relativePath, sourceText, }) {
    const language = (0, language_1.detectLanguage)(relativePath);
    if (language === "typescript" || language === "javascript") {
        return {
            file: relativePath,
            analysis: (0, tsAnalyzer_1.analyzeTypeScript)({
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
                hash: (0, utils_1.hashContent)(sourceText),
            },
        };
    }
    return {
        file: relativePath,
        analysis: (0, genericAnalyzer_1.analyzeGenerically)({
            language,
            sourceText,
            fileName: relativePath,
        }),
    };
}
function buildDependencyGraph(analyses) {
    const edges = [];
    const adjacency = {};
    analyses.forEach(({ file, analysis }) => {
        const neighbors = [];
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
        adjacency[file] = (0, utils_1.dedupeStrings)(neighbors);
    });
    return {
        edges,
        adjacency,
    };
}
function detectUnusedSymbols(analyses, dependencyGraph) {
    const unused = [];
    const importUsage = new Map();
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
        const isConsumedElsewhere = (symbol) => (consumers?.size ?? 0) > 0 || symbol.isExported === false;
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
function normalizeImport(fromFile, specifier) {
    if (!specifier) {
        return undefined;
    }
    if (specifier.startsWith(".")) {
        const joined = normalizePath(fromFile, specifier);
        return joined;
    }
    return specifier;
}
function normalizePath(fromFile, specifier) {
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
function inferEdgeKind(spec) {
    if (/dynamic|require\(/i.test(spec)) {
        return "dynamic";
    }
    if (/^@|^\./.test(spec)) {
        return "import";
    }
    return "import";
}
//# sourceMappingURL=analyzer.js.map