import { z } from "zod";

import { loadWorkspaceEnv } from "@agent-ide/db";
import type { AgentGraphState } from "@agent-ide/runtime";
import type {
  LangGraphEditFixCandidate,
  LangGraphEditorCandidate,
  LangGraphExecuteResult,
  LangGraphGoalDraft,
  LangGraphHooks,
  LangGraphInvokeInput,
  LangGraphLocatorResult,
} from "@agent-ide/runtime";

const claudeEnvSchema = z.object({
  CLAUDE_API_KEY: z.string().min(1),
  CLAUDE_BASE_URL: z.string().url().default("https://api.anthropic.com"),
  CLAUDE_MODEL: z.string().min(1).default("claude-opus-4-1"),
  CLAUDE_TEMPERATURE: z.coerce.number().gte(0).lte(1).default(0.2),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  CLAUDE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1600),
  CLAUDE_THINKING_BUDGET: z.coerce.number().int().min(0).default(0),
});

const planStatusValues = ["draft", "ready", "in_progress", "completed", "failed"] as const;
const taskStatusValues = ["todo", "in_progress", "blocked", "done", "canceled"] as const;
const agentModeValues = ["build", "plan", "explore", "review", "general"] as const;
const modelToolNameValues = ["list", "view", "grep", "write", "edit", "bash"] as const;
const memoryScopeValues = ["session", "workspace", "user"] as const;
const memorySourceValues = ["user", "assistant", "system", "tool", "review"] as const;

const planStatusAliases: Record<string, (typeof planStatusValues)[number]> = {
  draft: "draft",
  drafting: "draft",
  sketch: "draft",
  草稿: "draft",
  ready: "ready",
  planned: "ready",
  prepared: "ready",
  已就绪: "ready",
  就绪: "ready",
  in_progress: "in_progress",
  inprogress: "in_progress",
  doing: "in_progress",
  working: "in_progress",
  ongoing: "in_progress",
  active: "in_progress",
  进行中: "in_progress",
  执行中: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
  完成: "completed",
  已完成: "completed",
  failed: "failed",
  error: "failed",
  错误: "failed",
  失败: "failed",
};

const taskStatusAliases: Record<string, (typeof taskStatusValues)[number]> = {
  todo: "todo",
  to_do: "todo",
  pending: "todo",
  planned: "todo",
  queued: "todo",
  backlog: "todo",
  未开始: "todo",
  待办: "todo",
  待处理: "todo",
  待开始: "todo",
  in_progress: "in_progress",
  inprogress: "in_progress",
  doing: "in_progress",
  working: "in_progress",
  ongoing: "in_progress",
  active: "in_progress",
  进行中: "in_progress",
  执行中: "in_progress",
  处理中: "in_progress",
  blocked: "blocked",
  waiting: "blocked",
  on_hold: "blocked",
  paused: "blocked",
  stuck: "blocked",
  阻塞: "blocked",
  卡住: "blocked",
  等待中: "blocked",
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  resolved: "done",
  已完成: "done",
  完成: "done",
  canceled: "canceled",
  cancelled: "canceled",
  aborted: "canceled",
  skipped: "canceled",
  已取消: "canceled",
  取消: "canceled",
  跳过: "canceled",
};

const agentModeAliases: Record<string, (typeof agentModeValues)[number]> = {
  build: "build",
  builder: "build",
  coding: "build",
  execute: "build",
  implementation: "build",
  执行: "build",
  构建: "build",
  plan: "plan",
  planner: "plan",
  planning: "plan",
  规划: "plan",
  explore: "explore",
  explorer: "explore",
  research: "explore",
  analysis: "explore",
  调研: "explore",
  探索: "explore",
  review: "review",
  reviewer: "review",
  critique: "review",
  audit: "review",
  评审: "review",
  审查: "review",
  general: "general",
  default: "general",
  fallback: "general",
  通用: "general",
};

const memoryScopeAliases: Record<string, (typeof memoryScopeValues)[number]> = {
  session: "session",
  会话: "session",
  workspace: "workspace",
  project: "workspace",
  repo: "workspace",
  仓库: "workspace",
  项目: "workspace",
  user: "user",
  用户: "user",
};

const memorySourceAliases: Record<string, (typeof memorySourceValues)[number]> = {
  user: "user",
  用户: "user",
  assistant: "assistant",
  model: "assistant",
  ai: "assistant",
  助手: "assistant",
  system: "system",
  系统: "system",
  tool: "tool",
  工具: "tool",
  review: "review",
  reviewer: "review",
  评审: "review",
};

function normalizeEnumInput<T extends string>(
  value: unknown,
  aliases: Record<string, T>,
): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalizedKey = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return aliases[normalizedKey] ?? aliases[trimmed] ?? trimmed;
}

function normalizeBooleanInput(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return value;
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalizedKey = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "是", "需要", "true_value"].includes(normalizedKey)) {
    return true;
  }
  if (["false", "no", "n", "0", "否", "不需要", "false_value"].includes(normalizedKey)) {
    return false;
  }

  return value;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeStringValue(
  value: unknown,
  maxLength: number,
  fallback?: string,
): string | undefined {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  return truncate(trimmed, maxLength);
}

function toStringListCandidate(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }

      if (isRecord(item) && typeof item.text === "string") {
        return [item.text];
      }

      return [];
    });
  }

  if (typeof value === "string") {
    return value
      .split(/\n|[;；]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function sanitizeStringList(
  value: unknown,
  options: {
    maxItems: number;
    maxLength: number;
    fallback?: string[];
  },
): string[] | undefined {
  const items = toStringListCandidate(value)
    .map((item) => sanitizeStringValue(item, options.maxLength))
    .filter((item): item is string => Boolean(item));

  if (items.length === 0) {
    return options.fallback;
  }

  return items.slice(0, options.maxItems);
}

function clampConfidence(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, numeric));
}

function sanitizeGoalDraftCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    title: sanitizeStringValue(value.title, 120),
    description: sanitizeStringValue(value.description, 1200),
    successCriteria: sanitizeStringList(value.successCriteria, {
      maxItems: 6,
      maxLength: 240,
    }),
  };
}

function sanitizePlannerCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const steps = Array.isArray(value.steps)
    ? value.steps
        .filter(isRecord)
        .map((step) => ({
          id: sanitizeStringValue(step.id, 120),
          title: sanitizeStringValue(step.title, 160),
          description: sanitizeStringValue(step.description, 500),
          status: normalizeEnumInput(step.status, taskStatusAliases),
          evidence: sanitizeStringValue(step.evidence, 500),
        }))
        .slice(0, 8)
    : undefined;

  return {
    summary: sanitizeStringValue(value.summary, 600),
    status: normalizeEnumInput(value.status, planStatusAliases),
    steps,
  };
}

function sanitizeDelegateCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    shouldDelegate: normalizeBooleanInput(value.shouldDelegate),
    agentMode: normalizeEnumInput(value.agentMode, agentModeAliases),
    title: sanitizeStringValue(value.title, 160),
    reason: sanitizeStringValue(value.reason, 400),
    inputSummary: sanitizeStringValue(value.inputSummary, 600),
    inheritActiveGoal: normalizeBooleanInput(value.inheritActiveGoal),
  };
}

function sanitizeLocatorCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const rawPaths = Array.isArray(value.targetPaths)
    ? value.targetPaths
    : Array.isArray(value.paths)
      ? value.paths
      : Array.isArray(value.files)
        ? value.files
        : undefined;

  return {
    targetPaths: Array.isArray(rawPaths)
      ? rawPaths
          .map((item) => sanitizeStringValue(item, 240))
          .filter((item): item is string => Boolean(item))
          .slice(0, 4)
      : undefined,
    reasoning: sanitizeStringValue(value.reasoning ?? value.reason, 400),
  };
}

function sanitizeEditorCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    path: sanitizeStringValue(value.path ?? value.filePath ?? value.file_path, 240),
    search: sanitizeStringValue(
      value.search ?? value.search_replace ?? value.searchReplace ?? value.old_string ?? value.oldString ?? value.oldText,
      8_000,
    ),
    replace: sanitizeStringValue(
      value.replace ?? value.new_content ?? value.newContent ?? value.new_string ?? value.newString ?? value.newText,
      8_000,
    ),
    taskId: sanitizeStringValue(value.taskId, 120),
    reasoning: sanitizeStringValue(value.reasoning ?? value.reason, 400),
  };
}

function sanitizeEditFixerCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    search: sanitizeStringValue(
      value.search ?? value.search_replace ?? value.searchReplace ?? value.old_string ?? value.oldString ?? value.oldText,
      8_000,
    ),
    replace: sanitizeStringValue(
      value.replace ?? value.new_content ?? value.newContent ?? value.new_string ?? value.newString ?? value.newText,
      8_000,
    ),
    noChangesRequired: normalizeBooleanInput(
      value.noChangesRequired ?? value.no_changes_required ?? value.alreadyApplied,
    ),
    reasoning: sanitizeStringValue(value.reasoning ?? value.reason ?? value.explanation, 400),
  };
}

function deriveTaskTitleFromSummary(summary: string): string {
  return truncate(summary.replace(/\s+/g, " ").trim(), 160);
}

function resolveTaskFallback(
  state: AgentGraphState | undefined,
  taskId: string | undefined,
): { title?: string; inputSummary?: string } {
  if (!state || !taskId) {
    return {};
  }

  const existingTask = state.tasks.find((task) => task.id === taskId);
  if (existingTask) {
    return {
      title: existingTask.title,
      inputSummary: existingTask.inputSummary,
    };
  }

  const existingPlanStep = state.currentPlan?.steps.find((step) => step.id === taskId);
  if (existingPlanStep) {
    return {
      title: existingPlanStep.title,
      inputSummary: existingPlanStep.description,
    };
  }

  return {};
}

function sanitizeExecutorTaskCandidate(
  value: unknown,
  state?: AgentGraphState,
): {
  id?: string;
  ownerAgent?: unknown;
  title: string;
  status?: unknown;
  inputSummary: string;
  outputSummary?: string;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = sanitizeStringValue(value.id, 120);
  const fallback = resolveTaskFallback(state, id);
  const rawInputSummary = sanitizeStringValue(value.inputSummary, 600, fallback.inputSummary);
  const rawTitle =
    sanitizeStringValue(value.title, 160, fallback.title) ??
    (rawInputSummary ? deriveTaskTitleFromSummary(rawInputSummary) : undefined);

  if (!rawTitle || !rawInputSummary) {
    return null;
  }

  return {
    id,
    ownerAgent: normalizeEnumInput(value.ownerAgent, agentModeAliases),
    title: rawTitle,
    status: normalizeEnumInput(value.status, taskStatusAliases),
    inputSummary: rawInputSummary,
    outputSummary: sanitizeStringValue(value.outputSummary, 1200),
  };
}

function sanitizeExecutorMemoryCandidate(
  value: unknown,
): {
  scope: unknown;
  key: string;
  value: string;
  source: unknown;
  confidence?: number;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = sanitizeStringValue(value.key, 120);
  const recordValue = sanitizeStringValue(value.value, 500);
  if (!key || !recordValue) {
    return null;
  }

  return {
    scope: normalizeEnumInput(value.scope, memoryScopeAliases),
    key,
    value: recordValue,
    source: normalizeEnumInput(value.source, memorySourceAliases),
    confidence: clampConfidence(value.confidence),
  };
}

function sanitizeExecutorCandidate(value: unknown, state?: AgentGraphState): unknown {
  if (!isRecord(value)) {
    return value;
  }

  // executor sanitizer 是这层适配器里最关键的一步。
  // 模型返回的 JSON 就算“看起来像对”，也可能有几个常见问题：
  // - task 只有 id/status，没有 title/inputSummary
  // - memory key 有了，但 value 是空的
  // - toolCalls 里 name 合法，但 input 不是 object
  //
  // 这里的策略不是盲信模型，而是：
  // 1. 能从现有 state 补全的字段尽量补全
  // 2. 补不齐的脏项直接丢弃
  // 3. 最后再交给 Zod schema 做强校验
  //
  // 这样做的效果是：结构化输出链不会因为一两个半残字段就整体崩掉。
  const tasks = Array.isArray(value.tasks)
    ? value.tasks
        .map((task) => sanitizeExecutorTaskCandidate(task, state))
        .filter((task): task is NonNullable<typeof task> => Boolean(task))
        .slice(0, 6)
    : undefined;

  const memory = Array.isArray(value.memory)
    ? value.memory
        .map((record) => sanitizeExecutorMemoryCandidate(record))
        .filter((record): record is NonNullable<typeof record> => Boolean(record))
        .slice(0, 6)
    : undefined;

  const toolCalls = Array.isArray(value.toolCalls)
    ? value.toolCalls
        .filter(isRecord)
        .map((toolCall) => {
          const name = sanitizeStringValue(toolCall.name, 32);
          if (!name || !modelToolNameValues.includes(name as (typeof modelToolNameValues)[number])) {
            return null;
          }

          return {
            name,
            taskId: sanitizeStringValue(toolCall.taskId, 120),
            reasoning: sanitizeStringValue(toolCall.reasoning, 400),
            input: isRecord(toolCall.input) ? toolCall.input : {},
          };
        })
        .filter((toolCall): toolCall is NonNullable<typeof toolCall> => Boolean(toolCall))
        .slice(0, 4)
    : undefined;

  return {
    executionPhase: normalizeEnumInput(
      value.executionPhase,
      {
        explain: "explain",
        explain_phase: "explain",
        analysis: "explain",
        analyze: "explain",
        read: "explain",
        inspect: "explain",
        modify: "modify",
        edit: "modify",
        write: "modify",
        patch: "modify",
        finalize: "finalize",
        final: "finalize",
        summarize: "finalize",
        summary: "finalize",
      },
    ),
    assistantMessage: sanitizeStringValue(value.assistantMessage, 2000),
    tasks,
    memory,
    toolCalls,
  };
}

function sanitizeReviewerCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    satisfied: normalizeBooleanInput(value.satisfied),
    reasons: sanitizeStringList(value.reasons, {
      maxItems: 6,
      maxLength: 400,
    }),
    remainingRisks: sanitizeStringList(value.remainingRisks, {
      maxItems: 6,
      maxLength: 400,
    }),
    recommendedNextStep: sanitizeStringValue(value.recommendedNextStep, 400),
  };
}

function sanitizeSummarizerCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    shortSummary: sanitizeStringValue(value.shortSummary, 300),
    openLoops: sanitizeStringList(value.openLoops, {
      maxItems: 6,
      maxLength: 240,
    }),
    nextActions: sanitizeStringList(value.nextActions, {
      maxItems: 6,
      maxLength: 240,
    }),
    importantFacts: sanitizeStringList(value.importantFacts, {
      maxItems: 6,
      maxLength: 240,
    }),
  };
}

const goalDraftSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1200),
  successCriteria: z.array(z.string().min(1).max(240)).min(1).max(6),
});

const plannerSchema = z.object({
  summary: z.string().min(1).max(600),
  status: z.preprocess(
    (value) => normalizeEnumInput(value, planStatusAliases),
    z.enum(planStatusValues),
  ).default("ready"),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        title: z.string().min(1).max(160),
        description: z.string().min(1).max(500),
        status: z.preprocess(
          (value) => normalizeEnumInput(value, taskStatusAliases),
          z.enum(taskStatusValues),
        ).default("todo"),
        evidence: z.string().min(1).max(500).optional(),
      }),
    )
    .min(1)
    .max(8),
});

const delegateSchema = z.object({
  shouldDelegate: z.preprocess((value) => normalizeBooleanInput(value), z.boolean()),
  agentMode: z.preprocess(
    (value) => normalizeEnumInput(value, agentModeAliases),
    z.enum(agentModeValues),
  ).optional(),
  title: z.string().min(1).max(160).optional(),
  reason: z.string().min(1).max(400).optional(),
  inputSummary: z.string().min(1).max(600).optional(),
  inheritActiveGoal: z.preprocess((value) => normalizeBooleanInput(value), z.boolean()).optional(),
});

const locatorSchema = z.object({
  targetPaths: z.array(z.string().min(1).max(240)).min(1).max(4),
  reasoning: z.string().min(1).max(400).optional(),
});

const editorSchema = z.object({
  path: z.string().min(1).max(240),
  search: z.string().min(1).max(8000),
  replace: z.string().max(8000),
  taskId: z.string().min(1).max(120).optional(),
  reasoning: z.string().min(1).max(400).optional(),
});

const editFixerSchema = z.object({
  search: z.string().min(1).max(8000).optional(),
  replace: z.string().max(8000).optional(),
  noChangesRequired: z.preprocess((value) => normalizeBooleanInput(value), z.boolean()).optional(),
  reasoning: z.string().min(1).max(400).optional(),
});

const executorSchema = z.object({
  executionPhase: z.preprocess(
    (value) =>
      normalizeEnumInput(value, {
        explain: "explain",
        explain_phase: "explain",
        analysis: "explain",
        analyze: "explain",
        read: "explain",
        inspect: "explain",
        modify: "modify",
        edit: "modify",
        write: "modify",
        patch: "modify",
        verify: "verify",
        verification: "verify",
        validate: "verify",
        validation: "verify",
        test: "verify",
        checking: "verify",
        finalize: "finalize",
        final: "finalize",
        summarize: "finalize",
        summary: "finalize",
      }),
    z.enum(["explain", "modify", "verify", "finalize"]),
  ).optional(),
  assistantMessage: z.string().min(1).max(2000).optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        ownerAgent: z.preprocess(
          (value) => normalizeEnumInput(value, agentModeAliases),
          z.enum(agentModeValues),
        ).optional(),
        title: z.string().min(1).max(160),
        status: z.preprocess(
          (value) => normalizeEnumInput(value, taskStatusAliases),
          z.enum(taskStatusValues),
        ).default("in_progress"),
        inputSummary: z.string().min(1).max(600),
        outputSummary: z.string().min(1).max(1200).optional(),
      }),
    )
    .max(6)
    .optional(),
  memory: z
    .array(
      z.object({
        scope: z.preprocess(
          (value) => normalizeEnumInput(value, memoryScopeAliases),
          z.enum(memoryScopeValues),
        ),
        key: z.string().min(1).max(120),
        value: z.string().min(1).max(500),
        source: z.preprocess(
          (value) => normalizeEnumInput(value, memorySourceAliases),
          z.enum(memorySourceValues),
        ).default("assistant"),
        confidence: z.coerce.number().min(0).max(1).optional(),
      }),
    )
    .max(6)
    .optional(),
  toolCalls: z
    .array(
      z.object({
        name: z.enum(modelToolNameValues),
        taskId: z.string().min(1).max(120).optional(),
        reasoning: z.string().min(1).max(400).optional(),
        input: z.record(z.string(), z.unknown()),
      }),
    )
    .max(4)
    .optional(),
});

const reviewerSchema = z.object({
  satisfied: z.preprocess((value) => normalizeBooleanInput(value), z.boolean()),
  reasons: z.array(z.string().min(1).max(400)).min(1).max(6),
  remainingRisks: z.array(z.string().min(1).max(400)).max(6).optional(),
  recommendedNextStep: z.string().min(1).max(400).optional(),
});

const summarizerSchema = z.object({
  shortSummary: z.string().min(1).max(300),
  openLoops: z.array(z.string().min(1).max(240)).max(6).optional(),
  nextActions: z.array(z.string().min(1).max(240)).max(6).optional(),
  importantFacts: z.array(z.string().min(1).max(240)).max(6).optional(),
});

type FetchLike = typeof fetch;

interface ClaudeChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ClaudeMessagesResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
}

export interface ClaudeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: number;
}

export interface ClaudeHooksOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

interface ClaudeJsonCallOptions {
  sanitizer?: (value: unknown) => unknown;
  repairHint?: string;
  rawFallbackParser?: (raw: string) => unknown | undefined;
  rawTextRepairPromptBuilder?: (
    raw: string,
  ) => {
    systemPrompt: string;
    userPrompt: string;
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function stripThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function extractJsonObject(raw: string): string {
  const cleaned = stripThinkBlocks(raw)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    return cleaned;
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }

  throw new Error(`Claude did not return a JSON object: ${cleaned.slice(0, 200)}`);
}

function decodeXmlTextContent(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function coerceXmlParameterValue(raw: string): unknown {
  const decoded = decodeXmlTextContent(raw).trim();
  if (!decoded) {
    return "";
  }

  if (/^(?:true|false)$/i.test(decoded)) {
    return decoded.toLowerCase() === "true";
  }

  if (/^-?\d+(?:\.\d+)?$/.test(decoded)) {
    const parsed = Number(decoded);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (
    (decoded.startsWith("{") && decoded.endsWith("}"))
    || (decoded.startsWith("[") && decoded.endsWith("]"))
  ) {
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  }

  return decoded;
}

function parseExecutorXmlToolCallFallback(raw: string): LangGraphExecuteResult | undefined {
  const cleaned = stripThinkBlocks(raw).trim();
  const invokeMatches = [...cleaned.matchAll(/<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g)];
  if (invokeMatches.length === 0) {
    return undefined;
  }

  const toolCalls = invokeMatches.flatMap((match) => {
    const toolName = match[1]?.trim();
    if (!toolName || !modelToolNameValues.includes(toolName as (typeof modelToolNameValues)[number])) {
      return [];
    }

    const body = match[2] ?? "";
    const input: Record<string, unknown> = {};
    for (const parameterMatch of body.matchAll(/<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g)) {
      const parameterName = parameterMatch[1]?.trim();
      if (!parameterName) {
        continue;
      }

      input[parameterName] = coerceXmlParameterValue(parameterMatch[2] ?? "");
    }

    if (Object.keys(input).length === 0) {
      for (const fieldMatch of body.matchAll(/<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g)) {
        const fieldName = fieldMatch[1]?.trim();
        if (!fieldName || fieldName === "invoke" || fieldName === "parameter") {
          continue;
        }

        input[fieldName] = coerceXmlParameterValue(fieldMatch[2] ?? "");
      }
    }

    return [{
      name: toolName as LangGraphExecuteResult["toolCalls"] extends Array<infer T>
        ? T extends { name: infer N }
          ? N
          : never
        : never,
      input,
    }];
  });

  if (toolCalls.length === 0) {
    return undefined;
  }

  const leadingText = cleaned
    .slice(0, invokeMatches[0]?.index ?? 0)
    .replace(/<\/?minimax:tool_call>/g, "")
    .trim();

  return {
    assistantMessage: leadingText.length > 0 ? truncate(leadingText, 400) : undefined,
    toolCalls,
  };
}

function parseLocatorPathFallback(raw: string): LangGraphLocatorResult | undefined {
  const cleaned = stripThinkBlocks(raw).trim();
  const targetPaths = Array.from(
    new Set(
      [
        ...cleaned.matchAll(/"path"\s*:\s*"([^"]+)"/g),
        ...cleaned.matchAll(/"file_path"\s*:\s*"([^"]+)"/g),
        ...cleaned.matchAll(/"filePath"\s*:\s*"([^"]+)"/g),
      ]
        .map((match) => match[1]?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ).slice(0, 4);

  if (targetPaths.length === 0) {
    return undefined;
  }

  return {
    targetPaths,
    reasoning: "Recovered locator target paths from non-JSON Claude output.",
  };
}

function parseEditorCandidateFallback(raw: string): LangGraphEditorCandidate | undefined {
  const cleaned = stripThinkBlocks(raw).trim();
  const path =
    cleaned.match(/"path"\s*:\s*"([^"]+)"/)?.[1]?.trim()
    ?? cleaned.match(/"file_path"\s*:\s*"([^"]+)"/)?.[1]?.trim()
    ?? cleaned.match(/"filePath"\s*:\s*"([^"]+)"/)?.[1]?.trim();
  const search =
    cleaned.match(/"search"\s*:\s*"([\s\S]*?)"/)?.[1]
    ?? cleaned.match(/"search_replace"\s*:\s*"([\s\S]*?)"/)?.[1]
    ?? cleaned.match(/"old_string"\s*:\s*"([\s\S]*?)"/)?.[1];
  const replace =
    cleaned.match(/"replace"\s*:\s*"([\s\S]*?)"/)?.[1]
    ?? cleaned.match(/"new_content"\s*:\s*"([\s\S]*?)"/)?.[1]
    ?? cleaned.match(/"new_string"\s*:\s*"([\s\S]*?)"/)?.[1];

  if (!path || search === undefined || replace === undefined) {
    return undefined;
  }

  return {
    path: decodeXmlTextContent(path),
    search: decodeXmlTextContent(search),
    replace: decodeXmlTextContent(replace),
    reasoning: "Recovered edit candidate from non-JSON Claude output.",
};
}

function extractMessageContent(response: ClaudeMessagesResponse): string {
  const content = response.content;
  if (!content?.length) {
    throw new Error(response.error?.message ?? "Claude response did not include message content");
  }

  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function isStructuredOutputValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Claude JSON validation failed")
    || error.message.includes("Claude JSON validation failed after repair")
  );
}

function previewJsonString(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return truncate(JSON.stringify(JSON.parse(value)), maxLength);
  } catch {
    return truncate(value, maxLength);
  }
}

// 这两个 preview 函数是修这次结构性 bug 的关键。
//
// 问题背景：
// executor 的下一轮判断，不是直接读取真实文件系统，而是基于 runtimeState digest。
// 这个 digest 里会带上 recentMessages / recentToolInvocations，喂给模型做“上一轮发生了什么”的摘要。
//
// 原来的问题是：
// - tool=view 的输出太长，所以被截得很短
// - 下一轮模型其实看不到完整文件内容
// - 它就会继续发新的 view，想“再读一点”
//
// 所以这里故意对 view 提高摘要预算：
// - 普通 message 仍然保持较短
// - 但 tool=view 的 message / output 会保留更长片段
//
// 这不是为了把上下文无限堆大，而是为了让模型至少拿到“已经足够继续 edit”的信息，
// 不至于因为摘要太短而把所有工具轮次都浪费在重复读取上。
function previewMessageForDigest(
  message: Pick<AgentGraphState["messages"][number], "role" | "content">,
): string {
  if (message.role !== "tool") {
    return truncate(message.content, 320);
  }

  if (message.content.includes("tool=view")) {
    return truncate(message.content, 2800);
  }

  return truncate(message.content, 800);
}

function previewToolInvocationOutputForDigest(
  log: AgentGraphState["toolInvocations"][number],
): string | undefined {
  if (log.toolName === "view") {
    return previewJsonString(log.outputJson, 2600);
  }

  return previewJsonString(log.outputJson, 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableClaudeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  if (/Claude request failed:\s*(408|409|425|429|500|502|503|504)\b/.test(error.message)) {
    return true;
  }

  return /fetch failed|network error|socket hang up|ECONNRESET|ETIMEDOUT/i.test(error.message);
}

function resolveClaudeMessagesUrl(baseUrl: string): string {
  const normalized = trimTrailingSlash(baseUrl);
  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }
  if (normalized.endsWith("/messages")) {
    return normalized;
  }
  return `${normalized}/v1/messages`;
}

async function requestClaudeContent(
  config: ClaudeConfig,
  fetchImpl: FetchLike,
  messages: ClaudeChatMessage[],
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, config.timeoutMs);

    try {
      const systemPrompt = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content.trim())
        .filter(Boolean)
        .join("\n\n");
      const anthropicMessages = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
        }));

      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        temperature: config.temperature,
        messages:
          anthropicMessages.length > 0
            ? anthropicMessages
            : [{ role: "user", content: "" }],
      };

      if (systemPrompt) {
        body.system = systemPrompt;
      }

      if (config.thinkingBudget > 0) {
        body.thinking = {
          type: "enabled",
          budget_tokens: config.thinkingBudget,
        };
      }

      const response = await fetchImpl(resolveClaudeMessagesUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`Claude request failed: ${response.status} ${rawText}`);
      }

      const payload = JSON.parse(rawText) as ClaudeMessagesResponse;
      return extractMessageContent(payload);
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isRetryableClaudeFailure(error)) {
        throw error;
      }

      // benchmark/headless 批处理里，一次瞬时 500 就直接打断整条实例代价太高。
      // 这里把 provider 级重试限制在少量瞬时错误，避免把 schema 脏数据之类的
      // 确定性问题也一起吞掉。
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Claude request failed");
}

function buildStateDigest(state: AgentGraphState): string {
  const digest = {
    session: {
      id: state.session.id,
      title: state.session.title,
      mode: state.session.activeAgentMode,
      summary: state.session.summary,
    },
    activeGoal: {
      id: state.activeGoal.id,
      title: state.activeGoal.title,
      description: state.activeGoal.description,
      status: state.activeGoal.status,
      successCriteria: state.activeGoal.successCriteria,
    },
    currentPlan: state.currentPlan
      ? {
          id: state.currentPlan.id,
          status: state.currentPlan.status,
          summary: state.currentPlan.summary,
          steps: state.currentPlan.steps.map((step) => ({
            id: step.id,
            title: step.title,
            status: step.status,
            evidence: step.evidence,
          })),
        }
      : null,
    tasks: state.tasks.slice(-6).map((task) => ({
      id: task.id,
      title: task.title,
      ownerAgent: task.ownerAgent,
      status: task.status,
      inputSummary: truncate(task.inputSummary, 220),
      outputSummary: task.outputSummary ? truncate(task.outputSummary, 220) : undefined,
    })),
    recentMessages: state.messages.slice(-6).map((message) => ({
      role: message.role,
      // recentMessages 是 executor 最依赖的“上一轮证据”之一。
      // 这里不能无脑统一截短，否则模型虽然看见了“有个 tool=view”，
      // 却看不见关键源码片段，下一轮就更容易继续 view。
      content: previewMessageForDigest(message),
      createdAt: message.createdAt,
    })),
    memory: state.memory.slice(-6).map((record) => ({
      scope: record.scope,
      key: record.key,
      value: truncate(record.value, 180),
      source: record.source,
      confidence: record.confidence,
    })),
    recentToolInvocations: state.toolInvocations.slice(-6).map((log) => ({
      toolName: log.toolName,
      taskId: log.taskId,
      status: log.status,
      input: previewJsonString(log.inputJson, 260),
      // tool invocation 的 output 和 message 都会喂给模型。
      // 这里单独放宽 view 的输出长度，是为了 mixed explain + edit 任务里，
      // 模型能直接基于最近读取结果进入 edit，而不是再起一轮 view。
      output: previewToolInvocationOutputForDigest(log),
      updatedAt: log.updatedAt,
    })),
    subagentRuns: state.subagentRuns.slice(-4).map((run) => ({
      id: run.id,
      mode: run.agentMode,
      status: run.status,
      reason: run.reason,
      resultSummary: run.resultSummary,
    })),
  };

  return JSON.stringify(digest, null, 2);
}

function readUserIntent(input: LangGraphInvokeInput): string {
  return input.userMessage?.trim() || "用户暂时没有补充额外输入";
}

async function callClaudeJson<T>(
  config: ClaudeConfig,
  fetchImpl: FetchLike,
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  options?: ClaudeJsonCallOptions,
): Promise<T> {
  // callClaudeJson 是 provider 适配层最核心的“防脏数据入口”。
  // 它负责把一次模型输出收成三层处理：
  // 1. 先做 JSON 提取与 parse
  // 2. parse 都过不了时，先走一次 syntax repair
  // 3. parse 过了但 schema 不合法时，再走 sanitizer + Zod + schema repair
  //
  // 这层不能只靠 prompt，因为真实模型输出经常会出现：
  // - 语法级 JSON 损坏
  // - 枚举值漂移
  // - 数组超长
  // - 必填字段缺失
  //
  // 这里的设计目标不是“让模型绝不犯错”，而是把 provider 不稳定性尽量消化在适配层。
  const content = await requestClaudeContent(config, fetchImpl, [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ]);
  let rawCandidate: unknown;
  let rawJsonPreview: string | undefined;

  try {
    const json = extractJsonObject(content);
    rawJsonPreview = json;
    rawCandidate = JSON.parse(json);
  } catch (error) {
    const fallbackCandidate = options?.rawFallbackParser?.(content);
    if (fallbackCandidate !== undefined) {
      rawCandidate = fallbackCandidate;
    } else {
      if (options?.rawTextRepairPromptBuilder) {
        const repairPrompt = options.rawTextRepairPromptBuilder(content);
        const repairedContent = await requestClaudeContent(config, fetchImpl, [
          {
            role: "system",
            content: repairPrompt.systemPrompt,
          },
          {
            role: "user",
            content: repairPrompt.userPrompt,
          },
        ]);

        const repairedFallbackCandidate = options.rawFallbackParser?.(repairedContent);
        if (repairedFallbackCandidate !== undefined) {
          rawCandidate = repairedFallbackCandidate;
        } else {
          let repairedJson: string;
          try {
            repairedJson = extractJsonObject(repairedContent);
            rawJsonPreview = repairedJson;
            rawCandidate = JSON.parse(repairedJson);
          } catch (repairError) {
            throw new Error(
              `Claude plain-text repair failed: ${
                repairError instanceof Error ? repairError.message : "unknown parse error"
              }\nRaw output: ${truncate(repairedContent, 1200)}`,
            );
          }
        }
      } else {
      if (!(error instanceof SyntaxError) || !options?.repairHint) {
        throw error;
      }

      const json = extractJsonObject(content);
      rawJsonPreview = json;
      const repairedContent = await requestClaudeContent(config, fetchImpl, [
        {
          role: "system",
          content: [
            buildBaseSystemPrompt("json-repair"),
            "你负责修复一个语法损坏的 JSON object。",
            "你只能输出修复后的 JSON object。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "下面这段 JSON 在语法层面就无法被解析，请修复它。",
            `syntaxError: ${error.message}`,
            `repairHint: ${options.repairHint}`,
            `rawJson: ${truncate(json, 5000)}`,
          ].join("\n"),
        },
      ]);
      const repairedJson = extractJsonObject(repairedContent);
      rawJsonPreview = repairedJson;

      try {
        rawCandidate = JSON.parse(repairedJson);
      } catch (repairError) {
        throw new Error(
          `Claude JSON syntax repair failed: ${repairError instanceof Error ? repairError.message : "unknown parse error"}\nRaw JSON: ${truncate(
            repairedJson,
            1200,
          )}`,
        );
      }
      }
    }
  }

  const candidate = options?.sanitizer ? options.sanitizer(rawCandidate) : rawCandidate;

  try {
    return schema.parse(candidate);
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      throw error;
    }

    if (!options?.repairHint) {
      throw new Error(
        `Claude JSON validation failed: ${formatZodIssues(error)}\nRaw JSON: ${truncate(rawJsonPreview ?? content, 1200)}`,
      );
    }

    const repairedContent = await requestClaudeContent(config, fetchImpl, [
      {
        role: "system",
        content: [
          buildBaseSystemPrompt("json-repair"),
          "你负责修复一个已经接近正确、但还不满足约束的 JSON 对象。",
          "你只能输出修复后的 JSON object。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "请根据下面的校验错误，修复 JSON。",
          `validationErrors: ${formatZodIssues(error)}`,
          `repairHint: ${options.repairHint}`,
          `rawJson: ${truncate(JSON.stringify(candidate), 5000)}`,
        ].join("\n"),
      },
    ]);
    const repairedJson = extractJsonObject(repairedContent);
    const repairedCandidate = JSON.parse(repairedJson);
    const sanitizedRepairedCandidate = options.sanitizer
      ? options.sanitizer(repairedCandidate)
      : repairedCandidate;

    try {
      return schema.parse(sanitizedRepairedCandidate);
    } catch (repairError) {
      if (repairError instanceof z.ZodError) {
        throw new Error(
          `Claude JSON validation failed after repair: ${formatZodIssues(repairError)}\nRaw JSON: ${truncate(
            repairedJson,
            1200,
          )}`,
        );
      }

      throw repairError;
    }
  }
}

function buildBaseSystemPrompt(role: string): string {
  return [
    `你是 agent IDE 里的 ${role} 节点。`,
    "你的工作不是直接修改文件，而是为 runtime 输出结构化 JSON。",
    "绝不能输出 Markdown、解释文字、代码块、前后缀说明。",
    "如果证据不足，必须保守，不要虚构已经完成的代码修改或任务。",
    "输出必须是一个 JSON object。",
  ].join("\n");
}

export function hasClaudeConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const sourceEnv = env === process.env ? loadWorkspaceEnv() : env;
  return Boolean(sourceEnv.CLAUDE_API_KEY);
}

export function readClaudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeConfig {
  const sourceEnv = env === process.env ? loadWorkspaceEnv() : env;
  const parsed = claudeEnvSchema.parse(sourceEnv);

  return {
    apiKey: parsed.CLAUDE_API_KEY,
    baseUrl: trimTrailingSlash(parsed.CLAUDE_BASE_URL),
    model: parsed.CLAUDE_MODEL,
    temperature: parsed.CLAUDE_TEMPERATURE,
    timeoutMs: parsed.CLAUDE_TIMEOUT_MS,
    maxOutputTokens: parsed.CLAUDE_MAX_OUTPUT_TOKENS,
    thinkingBudget: parsed.CLAUDE_THINKING_BUDGET,
  };
}

export function createClaudeHooks(options?: ClaudeHooksOptions): LangGraphHooks {
  const config = readClaudeConfig(options?.env);
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;

  if (!fetchImpl) {
    throw new Error("fetch is not available in the current runtime");
  }

  // 这里把 Claude provider 适配成 LangGraphHooks。
  // 一个关键理解是：模型层并不知道 LangGraph graph、RuntimeStore 或文件系统。
  // 它只知道“当前节点要返回什么结构化 JSON”。
  //
  // 真正的落地动作仍然是后面的 graph/service/toolExecutor 在做：
  // - graph 负责编排顺序
  // - service 负责业务持久化
  // - toolExecutor 负责真实工具循环
  return {
    goalFactory: async (input): Promise<LangGraphGoalDraft | null> => {
      if (!input.userMessage?.trim()) {
        return null;
      }

      return callClaudeJson(
        config,
        fetchImpl,
        buildBaseSystemPrompt("goalFactory"),
        [
          "请根据用户输入，为 coding agent 生成一个可执行 goal。",
          "输出字段：title、description、successCriteria。",
          "title 要短，description 要说明目标，successCriteria 要可验证。",
          "successCriteria 最多 6 条。",
          `sessionId: ${input.sessionId}`,
          `userMessage: ${readUserIntent(input)}`,
        ].join("\n"),
        goalDraftSchema,
        {
          sanitizer: sanitizeGoalDraftCandidate,
          repairHint: "title/description 必须是字符串；successCriteria 必须是长度 1-6 的字符串数组。",
        },
      );
    },
    planner: async (state, input) =>
      callClaudeJson(
        config,
        fetchImpl,
        buildBaseSystemPrompt("planner"),
        [
          "请为当前 active goal 生成一份 plan。",
          "输出字段：summary、status、steps。",
          "plan.status 只能是：draft、ready、in_progress、completed、failed。",
          "step.status 只能是：todo、in_progress、blocked、done、canceled。",
          "steps 中每一项必须包含 title、description、status，可选 evidence。",
          "不要把没有证据的步骤标成 done。",
          `latestUserMessage: ${readUserIntent(input)}`,
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        plannerSchema,
        {
          sanitizer: sanitizePlannerCandidate,
          repairHint:
            "summary 必须是字符串；plan.status 只能是 draft/ready/in_progress/completed/failed；steps 必须是长度 1-8 的数组；step.status 只能是 todo/in_progress/blocked/done/canceled。",
        },
      ),
    delegate: async (state, input) => {
      const result = await callClaudeJson(
        config,
        fetchImpl,
        buildBaseSystemPrompt("delegate"),
        [
          "请判断当前阶段是否值得派生一个 subagent。",
          "如果不需要委托，返回 shouldDelegate=false。",
          "如果需要委托，返回 shouldDelegate=true，并提供 agentMode、title、reason、inputSummary、inheritActiveGoal。",
          "agentMode 只能是 build/plan/explore/review/general。",
          "shouldDelegate 和 inheritActiveGoal 必须是 JSON boolean，不要输出字符串。",
          "如果当前更适合主 agent 继续做，请不要委托。",
          `latestUserMessage: ${readUserIntent(input)}`,
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        delegateSchema,
        {
          sanitizer: sanitizeDelegateCandidate,
          repairHint:
            "shouldDelegate 和 inheritActiveGoal 必须是 JSON boolean；agentMode 只能是 build/plan/explore/review/general；reason 和 inputSummary 必须是字符串。",
        },
      );

      if (!result.shouldDelegate || !result.agentMode || !result.reason || !result.inputSummary) {
        return null;
      }

      return {
        agentMode: result.agentMode,
        title: result.title,
        reason: result.reason,
        inputSummary: result.inputSummary,
        inheritActiveGoal: result.inheritActiveGoal ?? true,
      };
    },
    locator: async (state, input, context): Promise<LangGraphLocatorResult | null> =>
      callClaudeJson(
        config,
        fetchImpl,
        buildBaseSystemPrompt("locator"),
        [
          "你现在不是自由调用工具的 executor，而是 scheduler-owned mutation phase 里的 locator。",
          "你的唯一职责是：根据当前 runtimeState 和最近的验证反馈，给出 1-4 个最值得修改的相对代码文件路径。",
          "优先返回代码文件，不要返回测试文件、文档文件或目录。",
          "如果 verificationRequirement.targetCodePaths 已经很明确，优先复用这些路径，不要发散。",
          "如果最近失败反馈里已经出现 traceback 命中的代码路径，优先把这些路径排在最前面。",
          "输出字段：targetPaths、reasoning。",
          `latestUserMessage: ${readUserIntent(input)}`,
          "verificationRequirement:",
          JSON.stringify(context.verificationRequirement, null, 2),
          context.latestVerificationFailure
            ? `latestVerificationFailure:\n${JSON.stringify(context.latestVerificationFailure, null, 2)}`
            : "latestVerificationFailure: null",
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        locatorSchema,
        {
          sanitizer: sanitizeLocatorCandidate,
          repairHint: "targetPaths 必须是 1-4 个相对代码文件路径字符串，不要返回目录、测试文件或文档文件。",
          rawFallbackParser: parseLocatorPathFallback,
        },
      ),
    editor: async (state, input, context): Promise<LangGraphEditorCandidate | null> => {
      try {
        return await callClaudeJson(
          config,
          fetchImpl,
          buildBaseSystemPrompt("editor"),
          [
          "你现在不是自由 executor，而是 scheduler-owned mutation phase 里的 editor。",
          "你的唯一职责是：针对给定文件内容，输出一个最小 edit candidate(old_string/new_string)。",
          "输出字段：path、old_string、new_string、taskId、reasoning。",
          "要求：",
          "- path 必须等于当前 targetPath。",
          "- old_string 必须是当前文件里真实存在、可定位的原文片段。",
          "- new_string 必须是最小修改，不要复制整段主流程。",
          "- 如果提供了 focusedTargetExcerpt，优先只围绕这个局部片段生成 old_string/new_string；不要跳出这个局部片段发散。",
          "- 行为修复必须优先命中真实函数体、条件分支、异常映射或返回值处理，不要只补 import/comment。",
          "- 如果这是 repair 阶段，必须优先围绕最近失败反馈里的 failing tests / targetCodePaths / behavior anchors 修正。",
          "- 共享热路径(adapters/sessions/models 等)优先做局部增量 edit，不要包一层宽泛 try/except。",
          `latestUserMessage: ${readUserIntent(input)}`,
          `executionPhase: ${context.executionPhase}`,
          `targetPath: ${context.targetPath}`,
          context.checkpointFile ? `checkpointFile: ${context.checkpointFile}` : "checkpointFile: null",
          `rejectedAttemptCount: ${context.rejectedAttemptCount ?? 0}`,
          context.lastRejectedReason ? `lastRejectedReason:\n${context.lastRejectedReason}` : "lastRejectedReason: null",
          context.lastRejectedCandidate
            ? `lastRejectedCandidate:\n${JSON.stringify(context.lastRejectedCandidate, null, 2)}`
            : "lastRejectedCandidate: null",
          context.focusedTargetContent
            ? [
                "focusedTargetExcerpt:",
                `matchedBehaviorAnchors: ${(context.matchedBehaviorAnchors ?? []).join(", ") || "none"}`,
                `lineRange: ${context.focusedStartLine ?? "?"}-${context.focusedEndLine ?? "?"}`,
                context.focusedTargetContent,
              ].join("\n")
            : "focusedTargetExcerpt: null",
          context.fullTargetContent ? `fullTargetContentLength: ${context.fullTargetContent.length}` : "fullTargetContentLength: 0",
          "verificationRequirement:",
          JSON.stringify(context.verificationRequirement, null, 2),
          context.latestVerificationFailure
            ? `latestVerificationFailure:\n${JSON.stringify(context.latestVerificationFailure, null, 2)}`
            : "latestVerificationFailure: null",
          "targetContent:",
          context.targetContent,
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        editorSchema,
        {
          sanitizer: sanitizeEditorCandidate,
          repairHint: "path 必须等于 targetPath；old_string/search 必须是当前文件中的真实片段；new_string/replace 必须是字符串；输出最小 edit，不要整体重写文件。",
          rawFallbackParser: parseEditorCandidateFallback,
          rawTextRepairPromptBuilder: (raw) => ({
            systemPrompt: [
              buildBaseSystemPrompt("edit-plan-repair"),
              "你是 utility-model edit planner normalizer。",
              "你收到的是一段自然语言修改计划，而不是合法 JSON。",
              "你的职责是把这段计划收口成一个最小 edit candidate JSON object。",
              "你只能输出 JSON object，字段只能是：path、old_string、new_string、taskId、reasoning。",
              "path 必须等于 targetPath。",
              "old_string 必须是当前文件或 focusedTargetExcerpt 里真实存在的原文片段。",
              "new_string 必须是最小修改，不要整体重写文件。",
              "优先使用 focusedTargetExcerpt 里的局部片段；只有在它不够用时，才参考完整 targetContent。",
              "如果原始计划只是口头描述，也要根据 targetContent 推出可落盘的 old_string/new_string。",
            ].join("\n"),
            userPrompt: [
              `targetPath: ${context.targetPath}`,
              `executionPhase: ${context.executionPhase}`,
              context.focusedTargetContent
                ? [
                    "focusedTargetExcerpt:",
                    `matchedBehaviorAnchors: ${(context.matchedBehaviorAnchors ?? []).join(", ") || "none"}`,
                    `lineRange: ${context.focusedStartLine ?? "?"}-${context.focusedEndLine ?? "?"}`,
                    context.focusedTargetContent,
                  ].join("\n")
                : "focusedTargetExcerpt: null",
              "targetContent:",
              context.targetContent,
              "rawModelOutput:",
              raw,
            ].join("\n"),
          }),
          },
        );
      } catch (error) {
        if (isStructuredOutputValidationError(error)) {
          return null;
        }

        throw error;
      }
    },
    editFixer: async (state, input, context): Promise<LangGraphEditFixCandidate | null> => {
      let result: z.infer<typeof editFixerSchema>;
      try {
        result = await callClaudeJson(
          config,
          fetchImpl,
          buildBaseSystemPrompt("edit-fixer"),
          [
          "你是 utility-model edit fixer。你的唯一职责是修正失败的 old_string/new_string 参数，让 edit 能命中当前文件。",
          "不要重新思考整道题，不要改变修改目标，只修正 edit 参数。",
          "输出字段：old_string、new_string、noChangesRequired、reasoning。",
          "如果失败的 edit 其实已经应用在文件里，可以返回 noChangesRequired=true。",
          "如果当前文件内容和失败的 old_string 只是在缩进、换行或少量上下文上不匹配，请输出更精确的新 old_string/new_string。",
          `latestUserMessage: ${readUserIntent(input)}`,
          `targetPath: ${context.targetPath}`,
          `editError: ${context.error}`,
          "failedCandidate:",
          JSON.stringify(context.failedCandidate, null, 2),
          "如果 focusedTargetExcerpt 存在，优先只修正这段附近的 old_string/new_string，不要跨函数漂移。",
          context.focusedTargetContent
            ? [
                "focusedTargetExcerpt:",
                `matchedBehaviorAnchors: ${(context.matchedBehaviorAnchors ?? []).join(", ") || "none"}`,
                `lineRange: ${context.focusedStartLine ?? "?"}-${context.focusedEndLine ?? "?"}`,
                context.focusedTargetContent,
              ].join("\n")
            : "focusedTargetExcerpt: null",
          context.fullTargetContent ? `fullTargetContentLength: ${context.fullTargetContent.length}` : "fullTargetContentLength: 0",
          "verificationRequirement:",
          JSON.stringify(context.verificationRequirement, null, 2),
          context.latestVerificationFailure
            ? `latestVerificationFailure:\n${JSON.stringify(context.latestVerificationFailure, null, 2)}`
            : "latestVerificationFailure: null",
          "targetContent:",
          context.targetContent,
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        editFixerSchema,
        {
          sanitizer: sanitizeEditFixerCandidate,
          repairHint: "除非已经应用，否则必须输出新的 old_string/new_string（或 search/replace 别名）；不要改变修改意图，只修正 edit 参数。",
          rawTextRepairPromptBuilder: (raw) => ({
            systemPrompt: [
              buildBaseSystemPrompt("edit-fixer-repair"),
              "你是 utility-model edit fixer normalizer。",
              "你收到的是一段自然语言修复说明，而不是合法 JSON。",
              "你的职责是把这段说明收口成 edit fixer JSON object。",
              "你只能输出 JSON object，字段只能是：old_string、new_string、noChangesRequired、reasoning。",
              "不要改变修改目标，只修正失败的 old_string/new_string。",
              "如果失败的 edit 已经应用在当前文件里，才允许 noChangesRequired=true。",
            ].join("\n"),
            userPrompt: [
              `targetPath: ${context.targetPath}`,
              `editError: ${context.error}`,
              "failedCandidate:",
              JSON.stringify(context.failedCandidate, null, 2),
              context.focusedTargetContent
                ? [
                    "focusedTargetExcerpt:",
                    `matchedBehaviorAnchors: ${(context.matchedBehaviorAnchors ?? []).join(", ") || "none"}`,
                    `lineRange: ${context.focusedStartLine ?? "?"}-${context.focusedEndLine ?? "?"}`,
                    context.focusedTargetContent,
                  ].join("\n")
                : "focusedTargetExcerpt: null",
              "targetContent:",
              context.targetContent,
              "rawModelOutput:",
              raw,
            ].join("\n"),
          }),
          },
        );
      } catch (error) {
        if (isStructuredOutputValidationError(error)) {
          return null;
        }

        throw error;
      }

      if (result.noChangesRequired) {
        return {
          search: context.failedCandidate.search,
          replace: context.failedCandidate.replace,
          noChangesRequired: true,
          reasoning: result.reasoning,
        };
      }

      if (!result.search || typeof result.replace !== "string") {
        return null;
      }

      return {
        search: result.search,
        replace: result.replace,
        noChangesRequired: false,
        reasoning: result.reasoning,
      };
    },
    executor: async (state, input): Promise<LangGraphExecuteResult | null> =>
      // executor hook 是 Claude 与 runtime execute control loop 的接缝。
      // 读这里时要重点看三件事：
      // 1. prompt 里如何约束 executionPhase / toolCalls / reread policy
      // 2. sanitizer 如何把“脏但可修”的 JSON 收口
      // 3. 为什么它只输出结构化结果，而不直接动文件
      //
      // 真正的文件修改仍然发生在 runtime 的 toolExecutor 里，
      // 这里的职责只是：基于当前 state，提出下一步执行草案。
      callClaudeJson(
        config,
        fetchImpl,
        buildBaseSystemPrompt("executor"),
        [
          "请基于当前 runtimeState 输出执行结果草案。",
          "输出字段：executionPhase、assistantMessage、tasks、memory、toolCalls。",
          "executionPhase 只能是：explain、modify、verify、finalize。",
          "tasks 用于同步 runtime task 账本；如果在更新已有 task，尽量复用现有 task id。",
          "task.status 只能是：todo、in_progress、blocked、done、canceled。",
          "memory.scope 只能是：session、workspace、user。",
          "memory.source 只能是：user、assistant、system、tool、review。",
          "如果需要真实读写工作区文件，必须通过 toolCalls 请求工具，不要谎称已经改好了代码。",
          "toolCalls.name 只能是：list、view、grep、write、edit、bash。",
          "toolCalls.input 里只写相对工作区的 path；如果是 bash，使用 cwd + command；不要写绝对路径，也不要自己传 root。",
          "phase 规划规则：读懂/解释文件时用 explain；开始落改动时用 modify；修改后跑最小验证时用 verify；给最终自然语言答复时用 finalize。",
          "view 默认会返回整个文件；如果你只需要局部片段，优先传 startLine/endLine，也兼容 offset/limit 或 lineRange: \"1-80\"。",
          "读取文件前优先用 view；小改动优先用 edit；只有在你已经看过文件并且确定要整体覆盖时才用 write。",
          "如果需要运行最小验证命令、测试、typecheck、lint、build 或 git diff --check，优先在 verify phase 请求 bash。",
          "如果当前修改属于行为性改动，而且 runtimeState 里已经出现相关测试文件、测试目标或回归线索，verify phase 必须优先跑这些目标对应的局部测试/局部回归；不要只跑 py_compile、typecheck、lint、git diff --check 这类结构性检查就 finalize。",
          "如果任务是修 bug 或行为修复，只有 import/comment/表层整理还不算完成；你必须命中真实行为路径，比如函数体、条件分支、异常映射、返回值或参数处理。",
          "如果你改到了 adapters、sessions、models、api、client、transport、router、middleware、utils 这类共享热路径，优先做最小增量 edit，不要复制整段主流程或包一层过宽的 try/except。",
          "高风险共享路径上的行为修复，在 verify phase 里除了主目标测试，还要补同文件/同模块的一组相邻回归；不要只跑单个 case 就 finalize。",
          "如果当前修改看起来不涉及行为变化，比如只做重排、重命名或结构性整理，那么最小结构性验证通常就够了，例如 git diff --check、语法检查、类型检查、lint 或最小 build。",
          "如果 runtimeState.recentToolInvocations 里已经有刚刚完成的相同工具调用，不要重复同一个 name/path；你必须基于已有结果继续下一步。",
          "如果最近消息里出现 LOOP_GUARD，说明你已经在重复同一个工具调用了；下一轮必须改用 edit/write，或者直接输出最终 assistantMessage。",
          "如果最近消息里出现 VERIFICATION_FEEDBACK，说明 runtime 已经把失败测试、目标代码路径、行为锚点和断言线索结构化出来了；下一轮必须优先围绕这些信号继续 modify/verify，不要回头读无关文件。",
          "当最近消息里已经有 tool=... 的工具结果时，你要基于这些结果决定下一轮 toolCalls，或者给出最终 assistantMessage。",
          "如果你已经能明确说出“要改哪个文件、哪段函数、哪行附近”或者已经拿到了可替换锚点，下一轮就必须进入 modify phase 并发起 edit/write；不要继续纯 explain。",
          "如果你已经 view 过同一个文件，还继续对同一路径发纯只读 toolCalls，会被 runtime 视为拖延修改；请直接 edit/write。",
          "reread policy：完整 view 之后，最多只允许 1 次 focused reread；而且这次 reread 必须带新的范围，并且仍处于 explain phase。",
          "一旦进入 modify phase，不要再回头 reread 同一个文件；你应该直接 edit/write，或者结束。",
          "像“先解释这个测试文件在测什么，再加两行注释”这种混合请求，推荐 phase 顺序是 explain -> modify -> finalize。",
          "像“修 bug / 调默认值 / 改参数 / 修测试 / 生成 patch”这种行为性改动，推荐 phase 顺序是 explain -> modify -> verify -> finalize。",
          "如果任务目标是修 bug、改默认值、调整参数、修测试或生成 patch，那么没有任何 edit/write 成功前不要 finalize；有真实改动后、在没有做过最小验证前也不要 finalize。",
          "如果你正在请求 toolCalls，assistantMessage 一般应省略；不要反复输出“正在读取文件”“准备修改文件”这类中间态废话。",
          "如果复用已有 task id，title 和 inputSummary 仍然必须保留非空字符串；补不齐的 task 项就不要输出。",
          "memory.value 必须是非空字符串；补不齐的 memory 项就不要输出。",
          "memory 只记录稳定、可复用的事实；不要把短期闲聊写成 memory。",
          "如果当前没有可靠执行成果，也可以返回空 tasks、空 memory 或空 toolCalls。",
          `latestUserMessage: ${readUserIntent(input)}`,
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        executorSchema,
        {
          sanitizer: (value) => sanitizeExecutorCandidate(value, state),
          repairHint:
            "executionPhase 只能是 explain/modify/verify/finalize。tasks 最多 6 项；每个 task 都必须有非空 title 和 inputSummary；如果只想更新已有 task，也必须保留这两个字段；补不齐的 task 项不要输出。memory 最多 6 项；每个 memory 都必须有非空 key 和 value；memory.scope 只能是 session/workspace/user，memory.source 只能是 user/assistant/system/tool/review。toolCalls 最多 4 项；toolCalls.name 只能是 list/view/grep/write/edit/bash；toolCalls.input 必须是 JSON object。",
          rawFallbackParser: parseExecutorXmlToolCallFallback,
        },
      ),
    reviewer: async (state, input) =>
      callClaudeJson(
        config,
        fetchImpl,
        buildBaseSystemPrompt("reviewer"),
        [
          "请根据当前 goal、plan、task、message、memory、subagent 情况判断目标是否满足。",
          "输出字段：satisfied、reasons、remainingRisks、recommendedNextStep。",
          "satisfied 必须是 JSON boolean，不要输出字符串。",
          "只有在 successCriteria 真正被满足时，satisfied 才能是 true。",
          `latestUserMessage: ${readUserIntent(input)}`,
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        reviewerSchema,
        {
          sanitizer: sanitizeReviewerCandidate,
          repairHint:
            "satisfied 必须是 JSON boolean；reasons 必须是长度 1-6 的字符串数组；remainingRisks 必须是长度不超过 6 的字符串数组。",
        },
      ),
    summarizer: async (state, input) =>
      callClaudeJson(
        config,
        fetchImpl,
        buildBaseSystemPrompt("summarizer"),
        [
          "请为当前 session 生成 summary。",
          "输出字段：shortSummary、openLoops、nextActions、importantFacts。",
          "shortSummary 要短，openLoops 写未关闭事项，nextActions 写下一步，importantFacts 写真正重要的事实。",
          `latestUserMessage: ${readUserIntent(input)}`,
          "runtimeState:",
          buildStateDigest(state),
        ].join("\n"),
        summarizerSchema,
        {
          sanitizer: sanitizeSummarizerCandidate,
          repairHint:
            "shortSummary 必须是字符串；openLoops/nextActions/importantFacts 都必须是不超过 6 项的字符串数组。",
        },
      ),
  };
}
