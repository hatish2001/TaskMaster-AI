# AI Pipeline Ticket Builder

VSCode-compatible extension that spins up a planning pipeline (product manager + UX agents) grounded in the open workspace, producing a `Ticket.md` you can hand to your implementation agent. Works in Cursor, Windsurf, and vanilla VSCode.

## Features

- Index the current workspace with OpenAI embeddings (configurable chunking & ignores).
- Respects `.gitignore`, optional `.contextignore`, and VSCode settings to ensure noisy files stay out of the context.
- Streams and chunks very large text files (>10 MB) without exhausting memory while still capturing their contents.
- Prioritizes critical entry points, config, and documentation files first for faster high-signal indexing.
- Builds a dependency graph and symbol index (JS/TS-first, graceful fallbacks for other languages) to surface relationships, comments, and complexity insights.
- Performs semantic chunking at class/function boundaries with dynamic sizing, deduplication, and metadata about the symbols covered.
- Flags likely generated assets, high-complexity areas, and exports without downstream consumers so you know where to focus planning time.
- Background watcher reacts to saves/renames/deletes, incrementally refreshing only changed files while reusing cached embeddings.
- Git-aware metadata surfaces branch, status summaries, and merge-conflict hints directly in the stored index.
- Monorepo-aware topology metadata highlights workspace packages, language modules, and git submodules for cross-repo planning.
- Parallel chunking workers respect CPU and memory budgets so even very large monorepos stay responsive.
- Product manager and UX designer agents reason over repo context to output a structured spec.
- `AI Pipeline: Generate Ticket` command creates a Markdown ticket in-editor.
- `AI Pipeline: Rebuild Repo Index` lets you refresh embeddings after refactors.

## Setup

1. `npm install`
2. Expose an OpenAI API key either via VSCode settings (`aiPipeline.openaiApiKey`) or environment variable `OPENAI_API_KEY`.
3. `npm run compile`
4. Launch the extension (`F5`) or package with `npm run package`.

## Usage

1. Open any project in Cursor or Windsurf.
2. Run command palette → **AI Pipeline: Generate Ticket**.
3. Enter the feature goal (e.g., “Build AI insights page”).
4. Review the generated `Ticket.md` and pass it to your implementation agent.

Use **AI Pipeline: Rebuild Repo Index** whenever repository content changes dramatically.

## Configuration

- `aiPipeline.model`: chat model for agents (default `gpt-4.1`).
- `aiPipeline.embeddingModel`: embedding model for indexing (default `text-embedding-3-large`).
- `aiPipeline.ignoredGlobs`: extend the ignore list beyond `node_modules`, `dist`, etc.
- `aiPipeline.embeddingBatchSize`: number of chunks sent per embedding request (default `64`). Increase if you rarely hit rate limits; decrease if you run into provider throttling.
- `aiPipeline.maxConcurrentWorkers`: cap parallel file analyzers (default `4`). Raise on beefy machines to speed large repos.
- `aiPipeline.memoryBudgetMb`: optional soft cap for file processing (0 = auto based on system RAM). Streamed chunking kicks in after the budget is crossed.

### Context Acquisition Defaults

- Walks the entire workspace (including dot-directories) while respecting `.gitignore`, `.contextignore`, and `aiPipeline.ignoredGlobs`.
- Skips binary content and safely ignores symlinks to avoid infinite recursion.
- Streams files larger than 10 MB so even huge sources can be chunked without loading them fully into memory.
- Applies a priority heuristic so core entry points, configuration, and documentation surface first.
- Extracts imports/exports, symbols, comments, and basic complexity metrics per file (deep TypeScript/JavaScript analysis, heuristic fallback for other languages).
- Enriches the repo index with dependency adjacency data and unused-export hints to inform future planning steps.
- Semantic chunker keeps related logic together (class + methods, function + helpers) and deduplicates redundant slices before embedding.
- Incremental rebuilds reuse cached metadata and embeddings when file size/mtime is unchanged (or untouched), making large-workspace refreshes fast.
- Background saves, creates, deletes, and renames automatically schedule a silent index refresh with status-bar feedback.
- Stored metadata includes per-file hashes, git status codes, and conflict markers so downstream agents can prioritize risky diffs.
- Repo topology metadata captures workspace manifests (npm/pnpm/yarn), Go modules, Cargo crates, Python projects, and git submodule paths for multi-repo context.

## Roadmap Ideas

- Add implementation & review loops directly in-extension.
- Support Anthropic models with an alternate provider setting.
- Persist richer metadata (git blame, tests) for deeper planning context.

