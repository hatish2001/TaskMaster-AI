import crypto from "crypto";

export function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

export function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


