import { LanguageId } from "./types";

const LANGUAGE_MAP: Array<{ match: RegExp; language: LanguageId }> = [
  { match: /\.(ts|tsx)$/, language: "typescript" },
  { match: /\.(js|jsx|cjs|mjs)$/, language: "javascript" },
  { match: /\.py$/, language: "python" },
  { match: /\.java$/, language: "java" },
  { match: /\.go$/, language: "go" },
  { match: /\.rs$/, language: "rust" },
  { match: /\.(cs|csx)$/, language: "csharp" },
  { match: /\.rb$/, language: "ruby" },
  { match: /\.(php|phtml)$/, language: "php" },
];

export function detectLanguage(relativePath: string): LanguageId {
  for (const candidate of LANGUAGE_MAP) {
    if (candidate.match.test(relativePath)) {
      return candidate.language;
    }
  }
  return "unknown";
}


