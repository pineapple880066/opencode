import { z } from "zod";

import { loadWorkspaceEnv } from "@agent-ide/db";
import type { AgentGraphState } from "@agent-ide/runtime";
import type {
  LangGraphExecuteResult,
  LangGraphGoalDraft,
  LangGraphHooks,
  LangGraphInvokeInput,
} from "@agent-ide/runtime";

const minimaxEnvSchema = z.object({
  MINIMAX_API_KEY: z.string().min(1),
  MINIMAX_BASE_URL: z.string().url().default("https://api.minimax.io/v1"),
  MINIMAX_MODEL: z.string().min(1).default("MiniMax-M2.7"),
  MINIMAX_TEMPERATURE: z.coerce.number().gt(0).lte(1).default(0.2),
  MINIMAX_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
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

interface MiniMaxChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface MiniMaxChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
      reasoning_details?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export interface MiniMaxHooksOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

interface MiniMaxJsonCallOptions {
  sanitizer?: (value: unknown) => unknown;
  repairHint?: string;
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

  throw new Error(`MiniMax did not return a JSON object: ${cleaned.slice(0, 200)}`);
}

function extractMessageContent(response: MiniMaxChatCompletionResponse): string {
  const message = response.choices?.[0]?.message;
  if (!message?.content) {
    throw new Error(response.error?.message ?? "MiniMax response did not include message content");
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
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

function isRetryableMiniMaxFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  if (/MiniMax request failed:\s*(408|409|425|429|500|502|503|504)\b/.test(error.message)) {
    return true;
  }

  return /fetch failed|network error|socket hang up|ECONNRESET|ETIMEDOUT/i.test(error.message);
}

async function requestMiniMaxContent(
  config: MiniMaxConfig,
  fetchImpl: FetchLike,
  messages: MiniMaxChatMessage[],
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, config.timeoutMs);

    try {
      const response = await fetchImpl(`${trimTrailingSlash(config.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: config.temperature,
          reasoning_split: true,
        }),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`MiniMax request failed: ${response.status} ${rawText}`);
      }

      const payload = JSON.parse(rawText) as MiniMaxChatCompletionResponse;
      return extractMessageContent(payload);
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isRetryableMiniMaxFailure(error)) {
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

  throw lastError instanceof Error ? lastError : new Error("MiniMax request failed");
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

async function callMiniMaxJson<T>(
  config: MiniMaxConfig,
  fetchImpl: FetchLike,
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  options?: MiniMaxJsonCallOptions,
): Promise<T> {
  // callMiniMaxJson 是 provider 适配层最核心的“防脏数据入口”。
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
  const content = await requestMiniMaxContent(config, fetchImpl, [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ]);
  const json = extractJsonObject(content);
  let rawCandidate: unknown;

  try {
    rawCandidate = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError) || !options?.repairHint) {
      throw error;
    }

    const repairedContent = await requestMiniMaxContent(config, fetchImpl, [
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

    try {
      rawCandidate = JSON.parse(repairedJson);
    } catch (repairError) {
      throw new Error(
        `MiniMax JSON syntax repair failed: ${repairError instanceof Error ? repairError.message : "unknown parse error"}\nRaw JSON: ${truncate(
          repairedJson,
          1200,
        )}`,
      );
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
        `MiniMax JSON validation failed: ${formatZodIssues(error)}\nRaw JSON: ${truncate(json, 1200)}`,
      );
    }

    const repairedContent = await requestMiniMaxContent(config, fetchImpl, [
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
          `MiniMax JSON validation failed after repair: ${formatZodIssues(repairError)}\nRaw JSON: ${truncate(
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

export function hasMiniMaxConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const sourceEnv = env === process.env ? loadWorkspaceEnv() : env;
  return Boolean(sourceEnv.MINIMAX_API_KEY);
}

export function readMiniMaxConfig(env: NodeJS.ProcessEnv = process.env): MiniMaxConfig {
  const sourceEnv = env === process.env ? loadWorkspaceEnv() : env;
  const parsed = minimaxEnvSchema.parse(sourceEnv);

  return {
    apiKey: parsed.MINIMAX_API_KEY,
    baseUrl: trimTrailingSlash(parsed.MINIMAX_BASE_URL),
    model: parsed.MINIMAX_MODEL,
    temperature: parsed.MINIMAX_TEMPERATURE,
    timeoutMs: parsed.MINIMAX_TIMEOUT_MS,
  };
}

export function createMiniMaxHooks(options?: MiniMaxHooksOptions): LangGraphHooks {
  const config = readMiniMaxConfig(options?.env);
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;

  if (!fetchImpl) {
    throw new Error("fetch is not available in the current runtime");
  }

  // 这里把 MiniMax provider 适配成 LangGraphHooks。
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

      return callMiniMaxJson(
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
      callMiniMaxJson(
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
      const result = await callMiniMaxJson(
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
    executor: async (state, input): Promise<LangGraphExecuteResult | null> =>
      // executor hook 是 MiniMax 与 runtime execute control loop 的接缝。
      // 读这里时要重点看三件事：
      // 1. prompt 里如何约束 executionPhase / toolCalls / reread policy
      // 2. sanitizer 如何把“脏但可修”的 JSON 收口
      // 3. 为什么它只输出结构化结果，而不直接动文件
      //
      // 真正的文件修改仍然发生在 runtime 的 toolExecutor 里，
      // 这里的职责只是：基于当前 state，提出下一步执行草案。
      callMiniMaxJson(
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
        },
      ),
    reviewer: async (state, input) =>
      callMiniMaxJson(
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
      callMiniMaxJson(
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
