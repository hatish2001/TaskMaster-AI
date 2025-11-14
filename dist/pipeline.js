"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPlanningPipeline = runPlanningPipeline;
const openai_1 = require("@langchain/openai");
const messages_1 = require("@langchain/core/messages");
const config_1 = require("./config");
const indexer_1 = require("./indexer");
async function runPlanningPipeline(goal, repoIndex, workspace) {
    const config = (0, config_1.getPipelineConfig)();
    const chat = new openai_1.ChatOpenAI({
        openAIApiKey: config.apiKey,
        modelName: config.model,
        temperature: 0.4,
    });
    const embeddings = new openai_1.OpenAIEmbeddings({
        openAIApiKey: config.apiKey,
        modelName: config.embeddingModel,
    });
    const queryEmbedding = await embeddings.embedQuery(goal);
    const topChunks = (0, indexer_1.similaritySearch)(repoIndex, queryEmbedding, 12);
    const context = topChunks
        .map((chunk, index) => `Context ${index + 1}\nSource: ${chunk.relativePath}\n---\n${chunk.content}`)
        .join("\n\n");
    const pmMessages = [
        new messages_1.SystemMessage(`You are product_manager_agent. Build a comprehensive product spec grounded in the provided repository context.
Return strict JSON with the following shape:
{
  "summary": string,
  "background": string,
  "current_state": string,
  "objectives": [
    { "priority": "P0" | "P1" | "P2", "statement": string }
  ],
  "user_stories": string[],
  "functional_requirements": [
    {
      "title": string,
      "priority": "P0" | "P1" | "P2",
      "description": string,
      "acceptance_criteria": string[]
    }
  ],
  "non_functional_requirements": [
    { "category": string, "items": string[] }
  ],
  "migration_strategy": {
    "approach": string,
    "phased_plan": [
      { "phase": string, "goals": string[], "parallel_streamlit": boolean }
    ],
    "rollback_plan": string[],
    "data_migration": string[]
  },
  "technical_architecture": {
    "frontend": string[],
    "backend": string[],
    "state_management": string,
    "component_library": string,
    "build_tooling": string[],
    "testing_strategy": string[],
    "deployment": string[]
  },
  "api_contracts": [
    { "method": string, "path": string, "description": string, "notes": string }
  ],
  "performance_metrics": {
    "current": string[],
    "targets": string[],
    "monitoring": string[]
  },
  "success_criteria": string[],
  "dependencies": string[],
  "blockers": string[],
  "cost_benefit": {
    "development_effort": string,
    "maintenance": string,
    "infrastructure": string,
    "roi_timeline": string
  },
  "delivery_plan": [
    {
      "phase": string,
      "duration": string,
      "tasks": string[],
      "owner": string,
      "team": string
    }
  ],
  "qa_plan": string[],
  "risks": [
    { "risk": string, "impact": string, "mitigation": string }
  ],
  "open_questions": string[],
  "telemetry": string[],
  "analytics": string[],
  "data_dependencies": string[],
  "decision_log": [
    { "topic": string, "decision": string, "rationale": string, "status": string }
  ],
  "definition_of_done": string[],
  "communication_plan": [
    { "audience": string, "cadence": string, "channel": string, "notes": string }
  ],
  "repo_refs": [
    { "path": string, "insight": string, "confidence": "high" | "medium" | "low" }
  ]
}
- Each array must contain at least one item; if unknown, insert "TBD".
- Mark any assumption that is not directly grounded in repo files or the stated goal.
- Incorporate explicit metrics, timeline ranges, and team sizing when possible.`),
        new messages_1.HumanMessage(`Initial Goal: ${goal}

Workspace root: ${workspace.uri.fsPath}

Repo Context:
${context}`),
    ];
    const pmResult = await chat.invoke(pmMessages);
    const pmContent = parseJson(pmResult.content);
    const uxMessages = [
        new messages_1.SystemMessage(`You are ux_designer_agent. Create a detailed UX implementation brief grounded in the product spec and repo context.
Return strict JSON:
{
  "experience_overview": string,
  "user_flows": [
    { "name": string, "steps": string[] }
  ],
  "ui_notes": string[],
  "empty_states": string[],
  "edge_cases": string[],
  "states_and_errors": string[],
  "acceptance_criteria": string[],
  "open_questions": string[]
}
Use "TBD" placeholders only when no grounded answer exists.`),
        new messages_1.HumanMessage(`Goal: ${goal}

Product Brief:
${JSON.stringify(pmContent, null, 2)}

Repo Context:
${context}`),
    ];
    const uxResult = await chat.invoke(uxMessages);
    const uxContent = parseJson(uxResult.content);
    return renderTicket(goal, pmContent, uxContent, topChunks);
}
function renderTicket(goal, pmData, uxData, chunks) {
    const refs = (pmData?.repo_refs ?? []);
    const uniquePaths = new Set();
    chunks.forEach((chunk) => uniquePaths.add(chunk.relativePath));
    const snippetMap = summarizeChunksByPath(chunks);
    const repoSection = refs.length > 0
        ? refs
            .map((ref) => {
            const confidence = ref.confidence
                ? ` _(confidence: ${ref.confidence})_`
                : "";
            const snippets = snippetMap.get(ref.path) ?? [];
            const snippetText = snippets.length > 0
                ? `\n${snippets
                    .map((snippet) => `  - Context: ${snippet}`)
                    .join("\n")}`
                : "";
            return `- \`${ref.path}\`: ${ref.insight}${confidence}${snippetText}`;
        })
            .join("\n")
        : buildFallbackRepoSection(uniquePaths, snippetMap);
    const objectives = Array.isArray(pmData?.objectives)
        ? pmData.objectives.map((objective) => {
            if (typeof objective === "string") {
                return `- ${objective}`;
            }
            const priority = objective?.priority ?? "P?";
            const statement = objective?.statement ?? "TBD";
            return `- ${priority}: ${statement}`;
        })
        : ["- TBD"];
    const functionalRequirements = Array.isArray(pmData?.functional_requirements)
        ? pmData.functional_requirements.map((req) => {
            const title = req.title ?? "TBD Requirement";
            const priority = req?.priority
                ? ` (${req.priority})`
                : "";
            const description = req.description ?? "TBD description.";
            const acceptance = formatList(req.acceptance_criteria);
            return `- **${title}**${priority}\n  - Summary: ${description}\n  - Acceptance:\n${indentList(acceptance)}`;
        })
        : ["- TBD"];
    const nonFunctionalRequirements = Array.isArray(pmData?.non_functional_requirements)
        ? pmData.non_functional_requirements.map((item) => {
            const category = item?.category ?? "General";
            const entries = formatList(item?.items);
            return `- **${category}**\n${indentList(entries)}`;
        })
        : ["- TBD"];
    const migrationStrategy = pmData?.migration_strategy ?? {};
    const migrationApproach = migrationStrategy?.approach ?? "TBD";
    const migrationPhases = Array.isArray(migrationStrategy?.phased_plan)
        ? migrationStrategy.phased_plan.map((phase) => {
            const name = phase?.phase ?? "Phase TBD";
            const goals = formatList(phase?.goals);
            const parallel = typeof phase?.parallel_streamlit === "boolean"
                ? phase.parallel_streamlit
                    ? "Yes"
                    : "No"
                : "TBD";
            return `- **${name}** (Parallel Streamlit: ${parallel})\n${indentList(goals)}`;
        })
        : ["- TBD"];
    const migrationRollback = formatList(migrationStrategy?.rollback_plan);
    const migrationData = formatList(migrationStrategy?.data_migration);
    const technicalArchitecture = pmData?.technical_architecture ?? {};
    const techArchitectureSection = [
        "- **Frontend Stack**",
        indentList(formatList(technicalArchitecture?.frontend)),
        "- **Backend Stack**",
        indentList(formatList(technicalArchitecture?.backend)),
        "- **State Management**",
        indentList(formatList(technicalArchitecture?.state_management
            ? [technicalArchitecture.state_management]
            : [])),
        "- **Component Library**",
        indentList(formatList(technicalArchitecture?.component_library
            ? [technicalArchitecture.component_library]
            : [])),
        "- **Build Tooling**",
        indentList(formatList(technicalArchitecture?.build_tooling)),
        "- **Testing Strategy**",
        indentList(formatList(technicalArchitecture?.testing_strategy)),
        "- **Deployment**",
        indentList(formatList(technicalArchitecture?.deployment)),
    ];
    const apiContracts = Array.isArray(pmData?.api_contracts)
        ? pmData.api_contracts.map((api) => {
            const method = api?.method ?? "METHOD";
            const path = api?.path ?? "/path";
            const description = api?.description ?? "TBD";
            const notes = api?.notes ? `\n  - Notes: ${api.notes}` : "";
            return `- \`${method} ${path}\`\n  - ${description}${notes}`;
        })
        : ["- TBD"];
    const performanceMetrics = pmData?.performance_metrics ?? {};
    const performanceSection = [
        "- **Current Baseline**",
        indentList(formatList(performanceMetrics?.current)),
        "- **Targets**",
        indentList(formatList(performanceMetrics?.targets)),
        "- **Monitoring & Telemetry**",
        indentList(formatList(performanceMetrics?.monitoring)),
    ];
    const costBenefit = pmData?.cost_benefit ?? {};
    const costBenefitSection = [
        `- Development Effort: ${costBenefit?.development_effort ?? "TBD"}`,
        `- Maintenance: ${costBenefit?.maintenance ?? "TBD"}`,
        `- Infrastructure: ${costBenefit?.infrastructure ?? "TBD"}`,
        `- ROI Timeline: ${costBenefit?.roi_timeline ?? "TBD"}`,
    ];
    const deliveryPlan = Array.isArray(pmData?.delivery_plan)
        ? pmData.delivery_plan.map((phase) => {
            const name = phase.phase ?? "Phase TBD";
            const owner = phase.owner ? ` (Owner: ${phase.owner})` : "";
            const duration = phase?.duration ?? "Duration TBD";
            const team = phase?.team
                ? ` (Team: ${phase.team})`
                : "";
            const tasks = formatList(phase.tasks);
            return `- **${name}**${owner}${team}\n  - Duration: ${duration}\n${indentList(tasks)}`;
        })
        : ["- TBD"];
    const userFlows = Array.isArray(uxData?.user_flows)
        ? uxData.user_flows.map((flow) => {
            const name = flow.name ?? "Unnamed flow";
            const steps = Array.isArray(flow.steps) && flow.steps.length > 0
                ? flow.steps.map((step) => `  1. ${step}`).join("\n")
                : "  1. TBD";
            return `- **${name}**\n${steps}`;
        })
        : ["- TBD"];
    const risks = Array.isArray(pmData?.risks)
        ? pmData.risks.map((risk) => {
            if (typeof risk === "string") {
                return `- ${risk}`;
            }
            const summary = risk?.risk ?? "Risk TBD";
            const impact = risk?.impact ? `\n  - Impact: ${risk.impact}` : "";
            const mitigation = risk?.mitigation
                ? `\n  - Mitigation: ${risk.mitigation}`
                : "";
            return `- **${summary}**${impact}${mitigation}`;
        })
        : ["- TBD"];
    const communicationPlan = Array.isArray(pmData?.communication_plan)
        ? pmData.communication_plan.map((entry) => {
            const audience = entry?.audience ?? "Audience";
            const cadence = entry?.cadence ?? "Cadence TBD";
            const channel = entry?.channel ?? "Channel TBD";
            const notes = entry?.notes ? `\n  - Notes: ${entry.notes}` : "";
            return `- **${audience}**\n  - Cadence: ${cadence}\n  - Channel: ${channel}${notes}`;
        })
        : ["- TBD"];
    const decisionLog = Array.isArray(pmData?.decision_log)
        ? pmData.decision_log.map((item) => {
            const topic = item?.topic ?? "Topic TBD";
            const decision = item?.decision ?? "Decision TBD";
            const rationale = item?.rationale
                ? `\n  - Rationale: ${item.rationale}`
                : "";
            const status = item?.status ? `\n  - Status: ${item.status}` : "";
            return `- **${topic}**\n  - Decision: ${decision}${rationale}${status}`;
        })
        : ["- TBD"];
    const markdown = [
        `# Ticket: ${goal}`,
        "",
        "## Summary",
        pmData?.summary ?? "TBD",
        "",
        "## Background",
        pmData?.background ?? "TBD",
        "",
        "## Current State",
        pmData?.current_state ?? "TBD",
        "",
        "## Objectives & Priorities",
        ...objectives,
        "",
        "## User Stories",
        formatList(pmData?.user_stories),
        "",
        "## Functional Requirements",
        ...functionalRequirements,
        "",
        "## Non-Functional Requirements",
        ...nonFunctionalRequirements,
        "",
        "## Migration Strategy & Rollback",
        "### Approach",
        migrationApproach,
        "",
        "### Phased vs. Big Bang",
        ...migrationPhases,
        "",
        "### Rollback Plan",
        migrationRollback,
        "",
        "### Data Migration",
        migrationData,
        "",
        "## Technical Architecture",
        ...techArchitectureSection,
        "",
        "## Telemetry & Analytics",
        formatList([
            ...(Array.isArray(pmData?.telemetry) ? pmData.telemetry : []),
            ...(Array.isArray(pmData?.analytics) ? pmData.analytics : []),
        ]),
        "",
        "## API Specification",
        ...apiContracts,
        "",
        "## Performance Targets",
        ...performanceSection,
        "",
        "## Success Criteria",
        formatList(pmData?.success_criteria),
        "",
        "## Dependencies",
        formatList(pmData?.dependencies),
        "",
        "## Blockers",
        formatList(pmData?.blockers),
        "",
        "## Cost-Benefit Analysis",
        ...costBenefitSection,
        "",
        "## Data Dependencies",
        formatList(pmData?.data_dependencies),
        "",
        "## Delivery & Rollout Plan",
        ...deliveryPlan,
        "",
        "## QA / Validation Plan",
        formatList(pmData?.qa_plan),
        "",
        "## Risks / Assumptions",
        ...risks,
        "",
        "## Open Product Questions",
        formatList(pmData?.open_questions),
        "",
        "## Decision Log",
        ...decisionLog,
        "",
        "## Definition of Done",
        formatList(pmData?.definition_of_done),
        "",
        "## Stakeholder Communication Plan",
        ...communicationPlan,
        "",
        "## UX Plan",
        "### Experience Overview",
        typeof uxData?.experience_overview === "string"
            ? uxData.experience_overview
            : "TBD",
        "",
        "### User Flows",
        ...userFlows,
        "",
        "### UI Notes",
        formatList(uxData?.ui_notes),
        "",
        "### Empty & Error States",
        formatList([
            ...(Array.isArray(uxData?.empty_states) ? uxData.empty_states : []),
            ...(Array.isArray(uxData?.states_and_errors)
                ? uxData.states_and_errors
                : []),
        ]),
        "",
        "### UX Edge Cases",
        formatList(uxData?.edge_cases),
        "",
        "### UX Acceptance Criteria",
        formatList(uxData?.acceptance_criteria),
        "",
        "### Open UX Questions",
        formatList(uxData?.open_questions),
        "",
        "## Repo References",
        repoSection || "- TBD",
    ];
    return markdown.join("\n");
}
function formatList(value) {
    if (Array.isArray(value) && value.length > 0) {
        return value
            .map((item) => {
            if (typeof item === "string") {
                return `- ${item}`;
            }
            return `- ${JSON.stringify(item)}`;
        })
            .join("\n");
    }
    if (typeof value === "string" && value.trim().length > 0) {
        return `- ${value.trim()}`;
    }
    return "- TBD";
}
function indentList(value) {
    if (!value) {
        return "  - TBD";
    }
    return value
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
}
function buildFallbackRepoSection(paths, snippetMap) {
    if (paths.size === 0) {
        return "- TBD";
    }
    return Array.from(paths)
        .map((file) => {
        const snippets = snippetMap.get(file) ?? [];
        const snippetText = snippets.length > 0
            ? `\n${snippets
                .map((snippet) => `  - Context: ${snippet}`)
                .join("\n")}`
            : "";
        return `- \`${file}\`${snippetText}`;
    })
        .join("\n");
}
function summarizeChunksByPath(chunks) {
    const map = new Map();
    chunks.forEach((chunk) => {
        if (!chunk.relativePath) {
            return;
        }
        const summary = summarizeChunk(chunk);
        if (!summary) {
            return;
        }
        const list = map.get(chunk.relativePath) ?? [];
        if (!list.includes(summary)) {
            list.push(summary);
            if (list.length > 3) {
                list.pop();
            }
        }
        map.set(chunk.relativePath, list);
    });
    return map;
}
function summarizeChunk(chunk) {
    if (!chunk.content) {
        return undefined;
    }
    const lines = chunk.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) {
        return undefined;
    }
    const candidate = lines.find((line) => !isCommentLine(line)) ?? lines[0] ?? undefined;
    if (!candidate) {
        return undefined;
    }
    const normalized = candidate.replace(/\s+/g, " ");
    if (normalized.length <= 160) {
        return normalized;
    }
    return `${normalized.slice(0, 157)}…`;
}
function isCommentLine(line) {
    const lower = line.toLowerCase();
    return (lower.startsWith("//") ||
        lower.startsWith("#") ||
        lower.startsWith("/*") ||
        lower.startsWith("*") ||
        lower.startsWith("--") ||
        lower.startsWith("<!") ||
        lower === "*/");
}
function parseJson(value) {
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        }
        catch (error) {
            console.warn("Failed to parse JSON content", error, value);
            return {};
        }
    }
    if (Array.isArray(value)) {
        const merged = value
            .map((part) => (typeof part === "string" ? part : part.toString()))
            .join("");
        try {
            return JSON.parse(merged);
        }
        catch (error) {
            console.warn("Failed to parse merged JSON content", error, merged);
            return {};
        }
    }
    return value ?? {};
}
//# sourceMappingURL=pipeline.js.map