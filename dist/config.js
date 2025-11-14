"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPipelineConfig = getPipelineConfig;
const vscode = __importStar(require("vscode"));
function getPipelineConfig() {
    const config = vscode.workspace.getConfiguration("aiPipeline");
    const envKey = process.env.OPENAI_API_KEY ?? "";
    const configuredKey = config.get("openaiApiKey") ?? "";
    const apiKey = configuredKey.trim() || envKey.trim();
    if (!apiKey) {
        throw new Error("Set aiPipeline.openaiApiKey or OPENAI_API_KEY environment variable.");
    }
    return {
        apiKey,
        model: config.get("model") ?? "gpt-4.1",
        embeddingModel: config.get("embeddingModel") ?? "text-embedding-3-large",
        chunkSize: config.get("contextChunkSize") ?? 800,
        chunkOverlap: config.get("contextChunkOverlap") ?? 120,
        ignoredGlobs: config.get("ignoredGlobs") ?? [],
        embeddingBatchSize: Math.max(1, config.get("embeddingBatchSize") ?? 64),
        maxConcurrentWorkers: Math.max(1, config.get("maxConcurrentWorkers") ?? 4),
        memoryBudgetMb: Math.max(0, config.get("memoryBudgetMb") ?? 0),
    };
}
//# sourceMappingURL=config.js.map