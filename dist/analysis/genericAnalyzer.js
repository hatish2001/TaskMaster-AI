"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeGenerically = analyzeGenerically;
const utils_1 = require("./utils");
const IMPORT_PATTERNS = [
    { language: "python", regex: /^\s*(from\s+\S+\s+)?import\s+.+$/gm },
    { language: "go", regex: /^\s*import\s+\(.+?\)|^\s*import\s+.+$/gms },
    { language: "java", regex: /^\s*import\s+[\w.*]+;/gm },
    { language: "rust", regex: /^\s*use\s+.+$/gm },
    { language: "php", regex: /^\s*use\s+.+;/gm },
    { language: "ruby", regex: /^\s*(require|include)\s+.+$/gm },
];
const COMMENT_PATTERNS = [
    { regex: /#.*$/gm, kind: "line" },
    { regex: /\/\/.*$/gm, kind: "line" },
    { regex: /\/\*[\s\S]*?\*\//gm, kind: "block" },
];
function analyzeGenerically({ language, sourceText, fileName, }) {
    const imports = collectImports(language, sourceText);
    const comments = collectComments(sourceText);
    const symbols = collectSymbolHeuristics(language, sourceText);
    const complexity = {
        totalComplexity: symbols.length,
        averagePerSymbol: symbols.length ? 1 : 0,
        maxPerSymbol: symbols.length ? 1 : 0,
        symbolComplexities: Object.fromEntries(symbols.map((s) => [s.name, 1])),
    };
    return {
        language: language,
        imports,
        exports: [],
        symbols,
        comments,
        complexity,
        isLikelyGenerated: /@generated|do not edit/i.test(sourceText),
        hasShebang: sourceText.startsWith("#!"),
        hash: (0, utils_1.hashContent)(sourceText),
    };
}
function collectImports(language, text) {
    const pattern = IMPORT_PATTERNS.find((item) => item.language === language);
    if (!pattern) {
        return [];
    }
    const matches = text.match(pattern.regex) ?? [];
    return matches.map((line) => line.trim());
}
function collectComments(text) {
    const comments = [];
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
function collectSymbolHeuristics(language, text) {
    const symbols = [];
    const patterns = {
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
    let match = pattern.exec(text);
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
function inferKind(language, snippet) {
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
//# sourceMappingURL=genericAnalyzer.js.map