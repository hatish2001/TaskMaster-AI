import * as vscode from "vscode";

export interface PipelineConfig {
  apiKey: string;
  model: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  ignoredGlobs: string[];
  embeddingBatchSize: number;
  maxConcurrentWorkers: number;
  memoryBudgetMb: number;
}

export function getPipelineConfig(): PipelineConfig {
  const config = vscode.workspace.getConfiguration("aiPipeline");
  const envKey = process.env.OPENAI_API_KEY ?? "";
  const configuredKey = config.get<string>("openaiApiKey") ?? "";

  const apiKey = configuredKey.trim() || envKey.trim();

  if (!apiKey) {
    throw new Error(
      "Set aiPipeline.openaiApiKey or OPENAI_API_KEY environment variable."
    );
  }

  return {
    apiKey,
    model: config.get<string>("model") ?? "gpt-4.1",
    embeddingModel:
      config.get<string>("embeddingModel") ?? "text-embedding-3-large",
    chunkSize: config.get<number>("contextChunkSize") ?? 800,
    chunkOverlap: config.get<number>("contextChunkOverlap") ?? 120,
    ignoredGlobs: config.get<string[]>("ignoredGlobs") ?? [],
    embeddingBatchSize: Math.max(
      1,
      config.get<number>("embeddingBatchSize") ?? 64
    ),
    maxConcurrentWorkers: Math.max(
      1,
      config.get<number>("maxConcurrentWorkers") ?? 4
    ),
    memoryBudgetMb: Math.max(
      0,
      config.get<number>("memoryBudgetMb") ?? 0
    ),
  };
}

