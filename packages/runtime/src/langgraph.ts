import path from "node:path";

import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  START,
  StateGraph,
  type CompiledStateGraph,
  type StateSnapshot,
} from "@langchain/langgraph";
import type { ReviewReport } from "@agent-ide/core";
import type { ToolName, ToolResult } from "@agent-ide/tools";

import type { AgentGraphState, WorkflowNode } from "./graph.js";
import type {
  RecordMemoryInput,
  ReviewGoalInput,
  SavePlanInput,
  SyncTasksInput,
  UpdateSessionSummaryInput,
} from "./service.js";
import { GoalDrivenRuntimeService } from "./service.js";
import type { RuntimeToolExecutor } from "./tooling.js";

// 这一组 interface/type 是“项目自己的 LangGraph 适配层合同”。
// 它们不是 LangGraph 官方 API，而是我们为了把“模型节点输出”接进 runtime，
// 专门定义的一层稳定边界。
//
// 看这个文件时最好先把概念分开：
// 1. LangGraph 官方概念：Annotation / StateGraph / START / END / BaseCheckpointSaver
// 2. 项目自定义概念：LangGraphHooks / LangGraphExecuteResult / AgentLangGraphRuntime
//
// 这样面试时不容易把“框架能力”和“项目自己的工程设计”混为一谈。
export interface LangGraphInvokeInput {
  sessionId: string;
  userMessage?: string;
}

export interface LangGraphGoalDraft {
  title: string;
  description: string;
  successCriteria: string[];
}

export interface LangGraphExecuteResult {
  executionPhase?: LangGraphExecutionPhase;
  assistantMessage?: string;
  tasks?: SyncTasksInput["tasks"];
  memory?: Array<Omit<RecordMemoryInput, "sessionId" | "workspaceId">>;
  toolCalls?: LangGraphToolCall[];
}

export type LangGraphExecutionPhase = "explain" | "modify" | "verify" | "finalize";

export interface LangGraphToolCall {
  name: Extract<ToolName, "list" | "view" | "grep" | "write" | "edit" | "bash">;
  input: Record<string, unknown>;
  taskId?: string;
  reasoning?: string;
}

// benchmark / headless runner 这类场景没有交互式“批准”按钮，
// 但又确实可能需要让 agent 执行 bash（例如跑单测、查 git status）。
// 所以这里把“是否给某个工具调用批准”抽成一个可注入决策点。
// 默认行为仍然是：不批准任何需要 approval 的工具。
export interface LangGraphToolApprovalDecision {
  sessionId: string;
  userMessage?: string;
  toolCall: LangGraphToolCall;
  runtimeState: AgentGraphState;
  executionPhase: LangGraphExecutionPhase;
  round: number;
}

// LangGraphHooks 是 provider 和 graph 之间最重要的接缝。
// 它把“某个模型供应商应该为每个节点产出什么结构化结果”这件事收成统一合同。
//
// 这些 hook 都只返回 JSON 草案，不直接操作数据库或文件系统：
// - 真正写 goal/plan/task/memory 的是 GoalDrivenRuntimeService
// - 真正调用文件工具的是 RuntimeToolExecutor
//
// 这层抽象的价值是：换模型时尽量只改 hooks，不改 graph 主体。

/**
 * LangGraphHooks - Model Provider 和 Graph 的接缝
 * 
 * 每个 hook 对应一个业务节点。Hooks 只负责\"说明想做什么\"，
 * 真实的执行委托给 GoalDrivenRuntimeService（持久化）和 RuntimeToolExecutor（工具调用）。
 * 
 * 换 provider 时只改这 6 个 hook，不改 graph 逻辑——这是\"provider pattern\"的核心价值。
 */
export interface LangGraphHooks {
  goalFactory?: (input: LangGraphInvokeInput) => Promise<LangGraphGoalDraft | null> | LangGraphGoalDraft | null;
  planner?: (
    state: AgentGraphState,
    input: LangGraphInvokeInput,
  ) => Promise<Omit<SavePlanInput, "sessionId"> | null> | Omit<SavePlanInput, "sessionId"> | null;
  delegate?: (
    state: AgentGraphState,
    input: LangGraphInvokeInput,
  ) => Promise<{
    parentTaskId?: string;
    agentMode: "build" | "plan" | "explore" | "review" | "general";
    title?: string;
    reason: string;
    inputSummary: string;
    inheritActiveGoal?: boolean;
  } | null> | {
    parentTaskId?: string;
    agentMode: "build" | "plan" | "explore" | "review" | "general";
    title?: string;
    reason: string;
    inputSummary: string;
    inheritActiveGoal?: boolean;
  } | null;
  executor?: (
    state: AgentGraphState,
    input: LangGraphInvokeInput,
  ) => Promise<LangGraphExecuteResult | null> | LangGraphExecuteResult | null;
  reviewer?: (
    state: AgentGraphState,
    input: LangGraphInvokeInput,
  ) => Promise<Omit<ReviewGoalInput, "sessionId"> | null> | Omit<ReviewGoalInput, "sessionId"> | null;
  summarizer?: (
    state: AgentGraphState,
    input: LangGraphInvokeInput,
  ) =>
    | Promise<Omit<UpdateSessionSummaryInput, "sessionId"> | null>
    | Omit<UpdateSessionSummaryInput, "sessionId">
    | null;
}

export interface LangGraphRuntimeOptions {
  hooks?: LangGraphHooks;
  checkpointer: BaseCheckpointSaver;
  toolExecutor?: RuntimeToolExecutor;
  toolApprovalDecider?: (decision: LangGraphToolApprovalDecision) => boolean;
  maxToolRounds?: number;
  maxToolCallsPerRound?: number;
}

// AgentLangGraphAnnotation 就是“这张 LangGraph 图的状态 schema”。
// Annotation.Root(...) 的作用，是显式声明：
// - 每个节点之间会传哪些字段
// - 这些字段怎么 merge/reduce
//
// 这里最典型的是 executionLog：
// 每个节点都只返回本轮新增日志，再由 reducer 统一追加到整条执行历史里。
export const AgentLangGraphAnnotation = Annotation.Root({
  sessionId: Annotation<string>,
  userMessage: Annotation<string | undefined>,
  runtimeState: Annotation<AgentGraphState | null>,
  latestReview: Annotation<ReviewReport | undefined>,
  latestPlanId: Annotation<string | undefined>,
  latestSubagentRunId: Annotation<string | undefined>,
  executionLog: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

export type AgentLangGraphState = typeof AgentLangGraphAnnotation.State;
export type AgentLangGraphUpdate = typeof AgentLangGraphAnnotation.Update;
type AgentLangGraphCompiled = CompiledStateGraph<AgentLangGraphState, AgentLangGraphUpdate, string>;

/**
 * 格式化单行执行日志供 Annotation 收集。
 * - 保持为 string[]，与 Annotation.reducer 的追加语义对接。
 * @param node - 当前 workflow 节点名
 * @param message - 人类可读的消息内容
 * @returns 单元素字符串数组
 */
function logLine(node: WorkflowNode, message: string): string[] {
  return [`${node}: ${message}`];
}

/**
 * 类型守卫：判断值是否为普通对象（非数组、非 null）。
 * 用于在 runtime 中对任意 JSON-like 输入做安全判断。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 截断字符串以避免把过长内容写入日志或消息中。
 * 保持尾部为省略号，方便人眼快速识别被裁切的情况。
 */
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

/**
 * 稳定化序列化对象为 JSON 字符串。
 * - 数组和对象的顺序是可预测的（对象键按字母排序）
 * - 相同的输入总是产生相同的输出字符串
 * - 用于在 loop guard 中计算工具调用的 checksum
 */
/**
 * 对任意 JSON-like 值做稳定序列化：
 * - 对象键按字母顺序排序，数组按顺序序列化
 * - 相同语义输入总是产出相同字符串
 * 主要用于计算工具调用的 checksum/去重 key
 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * 从一个工具调用草案生成稳定的 key，用于重复检测。
 * 将 name/taskId/input 的语义组合并稳定化序列化。
 */
function buildToolCallKey(toolCall: LangGraphToolCall): string {
  return stableSerialize({
    name: toolCall.name,
    taskId: toolCall.taskId ?? null,
    input: toolCall.input,
  });
}

// 这个辅助函数是这次“反复 view 同一个文件”问题里的一个关键点。
// 之前 runtime 只按“整条 toolCall 是否完全相同”来判重。
// 但模型会把同一路径的 view 稍微改一下参数，比如：
// - 第一次 path=browser.test.ts
// - 第二次 path=browser.test.ts + lineRange=1-70
// 这样 buildToolCallKey 就变了，旧的 loop guard 也就拦不住。
// 所以这里额外抽出“这次工具调用到底是在操作哪个路径”，
// 后面 execute 阶段可以做更强的、按路径维度的防打转判断。
/**
 * 从工具调用输入中尝试解析出“路径”字段（兼容多个别名）。
 * 返回 undefined 表示该调用不针对单一路径（例如 list/generic call）。
 */
function readToolCallPath(toolCall: LangGraphToolCall): string | undefined {
  if (!isRecord(toolCall.input)) {
    return undefined;
  }

  const directPath = toolCall.input.path;
  if (typeof directPath === "string" && directPath.trim().length > 0) {
    return directPath.trim();
  }

  const aliasedPath = toolCall.input.file_path ?? toolCall.input.filePath;
  if (typeof aliasedPath === "string" && aliasedPath.trim().length > 0) {
    return aliasedPath.trim();
  }

  return undefined;
}

// 这次 bug 还有一个细节：不是所有 view 都应该一律视作重复。
// 如果模型明确给了 startLine/endLine 或 lineRange，说明它想做“局部读取”。
// 所以我们先识别“这次 view 是否显式声明了范围”，
// 后面只在“已经完整读取过同一路径，且现在又来一轮新的 view”时才强拦。
// 这样可以避免把合理的局部阅读也一刀切掉。

/**
 * 判断 view 调用是否有明确的范围限制。设计背景：
 * - 模型可能会对同一文件做多次读取，但每次都换不同的范围
 * - 第一次完整读，第二次精读某片段，这是合理的
 * - 但完整读了之后还来第三次完整读，就是打转了
 */
/**
 * 判断 view/grep 等读取调用是否显式包含行范围或分页信息。
 * 该判断用于允许“合理的局部 reread”，而非把所有重复 view 一律拦截。
 */
function hasExplicitViewRange(toolCall: LangGraphToolCall): boolean {
  if (!isRecord(toolCall.input)) {
    return false;
  }

  if (typeof toolCall.input.startLine === "number" || typeof toolCall.input.endLine === "number") {
    return true;
  }
  if (typeof toolCall.input.start_line === "number" || typeof toolCall.input.end_line === "number") {
    return true;
  }

  if (typeof toolCall.input.offset === "number" || typeof toolCall.input.limit === "number") {
    return true;
  }
  if (typeof toolCall.input.offset === "string" && toolCall.input.offset.trim().length > 0) {
    return true;
  }
  if (typeof toolCall.input.limit === "string" && toolCall.input.limit.trim().length > 0) {
    return true;
  }

  const lineRange = toolCall.input.lineRange ?? toolCall.input.line_range;
  return typeof lineRange === "string" && lineRange.trim().length > 0;
}

/**
 * 从 view 调用中抽取统一的 range key：
 * - 优先返回 startLine-endLine
 * - 或返回 lineRange 字符串
 * - 或返回 offset/limit 组合
 * 这个 key 用于判断两次 focused reread 是否针对相同片段。
 */
function readExplicitViewRangeKey(toolCall: LangGraphToolCall): string | undefined {
  if (!isRecord(toolCall.input)) {
    return undefined;
  }

  const directStart =
    typeof toolCall.input.startLine === "number"
      ? toolCall.input.startLine
      : typeof toolCall.input.start_line === "number"
        ? toolCall.input.start_line
        : undefined;
  const directEnd =
    typeof toolCall.input.endLine === "number"
      ? toolCall.input.endLine
      : typeof toolCall.input.end_line === "number"
        ? toolCall.input.end_line
        : undefined;

  if (directStart !== undefined || directEnd !== undefined) {
    return `${directStart ?? "?"}-${directEnd ?? "?"}`;
  }

  const lineRange = toolCall.input.lineRange ?? toolCall.input.line_range;
  if (typeof lineRange === "string" && lineRange.trim().length > 0) {
    return lineRange.trim();
  }

  const offset =
    typeof toolCall.input.offset === "number"
      ? toolCall.input.offset
      : typeof toolCall.input.offset === "string"
        ? Number(toolCall.input.offset)
        : undefined;
  const limit =
    typeof toolCall.input.limit === "number"
      ? toolCall.input.limit
      : typeof toolCall.input.limit === "string"
        ? Number(toolCall.input.limit)
        : undefined;

  if (Number.isFinite(offset) || Number.isFinite(limit)) {
    return `offset=${Number.isFinite(offset) ? offset : "?"};limit=${Number.isFinite(limit) ? limit : "?"}`;
  }

  return undefined;
}

interface ViewReadBudgetState {
  hasFullRead: boolean;
  focusedRereads: number;
  anchorRereads: number;
  seenFocusedRanges: Set<string>;
  seenAnchorRanges: Set<string>;
  knownAnchorLines: Set<number>;
}

/**
 * 初始化单一路径的 reread 预算状态。
 * - hasFullRead: 是否已经有一次完整读取
 * - focusedRereads: 已使用的 focused reread 次数
 * - seenFocusedRanges: 已见过的局部范围 key
 */
function createViewReadBudgetState(): ViewReadBudgetState {
  return {
    hasFullRead: false,
    focusedRereads: 0,
    anchorRereads: 0,
    seenFocusedRanges: new Set<string>(),
    seenAnchorRanges: new Set<string>(),
    knownAnchorLines: new Set<number>(),
  };
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

interface ExplicitViewLineSpan {
  startLine: number;
  endLine: number;
}

function readExplicitViewLineSpan(toolCall: LangGraphToolCall): ExplicitViewLineSpan | undefined {
  if (!isRecord(toolCall.input)) {
    return undefined;
  }

  const directStart = readNumber(toolCall.input.startLine ?? toolCall.input.start_line);
  const directEnd = readNumber(toolCall.input.endLine ?? toolCall.input.end_line);

  if (directStart !== undefined || directEnd !== undefined) {
    const startLine = Math.max(1, directStart ?? directEnd ?? 1);
    const endLine = Math.max(startLine, directEnd ?? startLine);
    return { startLine, endLine };
  }

  const lineRange = toolCall.input.lineRange ?? toolCall.input.line_range;
  if (typeof lineRange === "string" && lineRange.trim().length > 0) {
    const matched = lineRange.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (matched) {
      const startLine = Math.max(1, Number(matched[1]));
      const endLine = Math.max(startLine, Number(matched[2]));
      return { startLine, endLine };
    }
  }

  const offset = readNumber(toolCall.input.offset);
  const limit = readNumber(toolCall.input.limit);
  if (offset !== undefined || limit !== undefined) {
    const startLine = Math.max(1, (offset ?? 0) + 1);
    const endLine = Math.max(startLine, startLine + Math.max(0, (limit ?? 1) - 1));
    return { startLine, endLine };
  }

  return undefined;
}

function isAnchorFocusedReread(
  viewBudget: ViewReadBudgetState,
  toolCall: LangGraphToolCall,
): boolean {
  const span = readExplicitViewLineSpan(toolCall);
  if (!span) {
    return false;
  }

  for (const line of viewBudget.knownAnchorLines) {
    if (line >= span.startLine && line <= span.endLine) {
      return true;
    }
  }

  return false;
}

function recordAnchorLinesFromGrepOutput(
  viewReadBudgets: Map<string, ViewReadBudgetState>,
  output: unknown,
): void {
  if (!isRecord(output) || !Array.isArray(output.matches)) {
    return;
  }

  for (const match of output.matches) {
    if (!isRecord(match)) {
      continue;
    }

    const matchPath = typeof match.path === "string" && match.path.trim().length > 0 ? match.path.trim() : undefined;
    const line = readNumber(match.line);
    if (!matchPath || line === undefined) {
      continue;
    }

    const budget = viewReadBudgets.get(matchPath) ?? createViewReadBudgetState();
    budget.knownAnchorLines.add(line);
    viewReadBudgets.set(matchPath, budget);
  }
}

/**
 * 根据 executor 返回内容推断当前执行阶段：
 * - modify: 包含 edit/write
 * - explain: 包含 view/grep/list
 * - finalize: 否则
 * Hooks 也可以通过 execution.executionPhase 显式指定阶段。
 */
function inferExecutionPhase(execution: LangGraphExecuteResult): LangGraphExecutionPhase {
  if (execution.executionPhase) {
    return execution.executionPhase;
  }

  const toolCalls = execution.toolCalls ?? [];
  const toolNames = new Set(toolCalls.map((toolCall) => toolCall.name));
  if (toolNames.has("edit") || toolNames.has("write")) {
    return "modify";
  }
  if (
    toolCalls.some(
      (toolCall) =>
        toolCall.name === "bash" && commandLooksLikeVerification(readBashCommand(toolCall.input)),
    )
  ) {
    return "verify";
  }
  if (toolNames.has("bash")) {
    return "modify";
  }
  if (toolNames.has("view") || toolNames.has("grep") || toolNames.has("list")) {
    return "explain";
  }

  return "finalize";
}

/**
 * 生成系统级的 loop-guard 提示，说明某次 view 请求被拦截的原因和下一步建议。
 */
function createViewBudgetGuardMessage(
  toolCall: LangGraphToolCall,
  path: string,
  reason: string,
): string {
  return [
    "LOOP_GUARD: 当前 view 请求不满足 reread policy。",
    `tool=${toolCall.name}`,
    `path=${path}`,
    `input=${truncate(stableSerialize(toolCall.input), 1200)}`,
    reason,
    "请基于已有读取结果继续 edit/write，或者直接输出最终 assistantMessage。",
  ].join("\n");
}

function createVerificationPolicyMessage(message: string): string {
  return [
    "VERIFICATION_POLICY: 当前 invoke 已经进入真实修改阶段。",
    message,
  ].join("\n");
}

function createModificationPolicyMessage(message: string): string {
  return [
    "MODIFICATION_POLICY: 当前 invoke 已经进入行为修改阶段。",
    message,
  ].join("\n");
}

type VerificationLevel = "none" | "structural" | "behavioral";

interface VerificationRequirement {
  requiredLevel: VerificationLevel;
  requireTargetedBehavioral: boolean;
  requireAdjacentRegression: boolean;
  recommendedCommandKinds: string[];
  targetHints: string[];
  adjacentHints: string[];
  targetedCommands: string[];
  adjacentCommands: string[];
  rationale: string;
}

interface VerificationCommandAnalysis {
  level: Exclude<VerificationLevel, "none">;
  targeted: boolean;
  adjacentRegression: boolean;
}

interface VerificationProgress {
  attempted: boolean;
  latestAttemptFailed: boolean;
  strongestSuccessfulLevel: VerificationLevel;
  hasTargetedBehavioralSuccess: boolean;
  hasAdjacentRegressionSuccess: boolean;
}

interface WriteLikeModificationAnalysis {
  path?: string;
  documentationOnly: boolean;
  importOnly: boolean;
  substantialCodeChange: boolean;
  changedLineCount: number;
  meaningfulCodeLineCount: number;
  broadFlowRewrite: boolean;
  highRisk: boolean;
  highRiskReason?: string;
}

interface ModificationBudget {
  enforceMinimalDelta: boolean;
  maxChangedLines: number;
  maxMeaningfulCodeLines: number;
  disallowBroadFlowRewrite: boolean;
  targetHints: string[];
  suggestedCommands: string[];
  rationale: string;
}

/**
 * 基于用户消息的关键词简单启发式判断，是否存在“想让 agent 修改代码/文件”的意图。
 */
function looksLikeModificationRequest(userMessage: string | undefined): boolean {
  if (!userMessage) {
    return false;
  }

  return textSuggestsModification(userMessage);
}

// 这层启发式不是在“理解代码语义”，而是在尽量稳定地区分：
// - 只是解释/查看
// - 明确需要真实修改文件
//
// 之前这里过度依赖 modify/edit 这样的直白词汇，
// 结果像 “Add a text parameter” / “Raise error when ...” 这类真实 benchmark 需求
// 会被误判成“没有待修改工作”，从而提前收尾。
function textSuggestsModification(value: string): boolean {
  return (
    /(修改|编辑|改动|加注释|注释|写入|替换|重构|补上|添加|加入|支持|实现|修复|调整|新增|报错|校验|参数)/i.test(
      value,
    )
    || /\b(comment|edit|write|patch|modify|change|update|add|implement|support|fix|rename|refactor|validate|parameter|error)\b/i.test(
      value,
    )
  );
}

function textSuggestsDocumentationOnly(value: string): boolean {
  return /(注释|文档|说明|readme|comment|comments|documentation|docstring)/i.test(value);
}

function textSuggestsBehavioralChange(value: string): boolean {
  return (
    /(修复|报错|错误|异常|校验|逻辑|默认值|参数|功能|行为|兼容|超时|请求|响应|配置|验证|回归|实现|支持|新增|重构|失败测试)/i.test(
      value,
    )
    || /\b(fix|bug|error|exception|validate|validation|logic|default|parameter|feature|behavior|regression|support|implement|timeout|request|response|config|compatibility|failing test|test failure)\b/i.test(
      value,
    )
  );
}

function textSuggestsNoBehaviorChange(value: string): boolean {
  return (
    /(不影响|不涉及|不会改动|不修改|不改|只做|仅做|纯).{0,8}(行为|逻辑|功能|默认值|参数|校验|验证)/i.test(value)
    || /(只加注释|仅加注释|纯注释|documentation-only|comment-only)/i.test(value)
  );
}

function pathLooksLikeDocumentationFile(filePath: string): boolean {
  return /(^docs\/|\/docs\/|readme|changelog|license|copying|notice|\.md$|\.mdx$|\.rst$|\.txt$)/i.test(filePath);
}

function pathLooksLikeTestFile(filePath: string): boolean {
  return /(^tests?\/|\/tests?\/|__tests__|\.test\.[^/]+$|\.spec\.[^/]+$|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.go$)/i.test(
    filePath,
  );
}

function pathLooksLikeCodeFile(filePath: string): boolean {
  return /\.(py|js|jsx|ts|tsx|go|rs|rb|java|c|cc|cpp|h|hpp|sh)$/i.test(filePath);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function extractPathHintsFromText(text: string): string[] {
  const matches = text.match(/[\w./-]+\.(?:py|js|jsx|ts|tsx|go|rs|rb|java|c|cc|cpp|h|hpp|sh|md|mdx|rst|txt)/gi) ?? [];
  return uniqueStrings(matches.map((value) => value.trim()));
}

function extractTestSelectorHintsFromText(text: string): string[] {
  const pytestSelectors = text.match(/[\w./-]+\.py::[\w.:-]+(?:::[\w.:-]+)*/g) ?? [];
  const dottedUnittestTargets = text.match(/\b(?:[\w]+\.tests?|tests?)\.[\w.]+\b/g) ?? [];

  return uniqueStrings(
    [...pytestSelectors, ...dottedUnittestTargets].filter((value) => /test/i.test(value)),
  );
}

function pickStringAliasFromUnknown(
  value: unknown,
  aliases: string[],
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const alias of aliases) {
    const candidate = value[alias];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function stripSharedLineContext(
  before: string,
  after: string,
): { beforeChanged: string; afterChanged: string } {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let start = 0;
  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;

  while (
    start <= beforeEnd
    && start <= afterEnd
    && beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }

  while (
    beforeEnd >= start
    && afterEnd >= start
    && beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    beforeChanged: beforeLines.slice(start, beforeEnd + 1).join("\n"),
    afterChanged: afterLines.slice(start, afterEnd + 1).join("\n"),
  };
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function isCommentLikeLine(line: string): boolean {
  return /^\s*(#|\/\/|\/\*|\*|<!--|"""|''')/.test(line);
}

function isImportLikeLine(line: string): boolean {
  return /^\s*(import\s+|from\s+\S+\s+import\s+|package\s+|use\s+\S+|#include\s+|require\(|export\s+\{)/.test(line);
}

function isDocstringBoundaryLine(line: string): boolean {
  return /^\s*("""|''')/.test(line);
}

function isMeaningfulCodeLine(line: string): boolean {
  return !isBlankLine(line)
    && !isCommentLikeLine(line)
    && !isImportLikeLine(line)
    && !isDocstringBoundaryLine(line);
}

function countMeaningfulCodeLines(text: string): number {
  return text
    .split(/\r?\n/)
    .filter((line) => isMeaningfulCodeLine(line))
    .length;
}

function pathLooksLikeHighRiskSharedCode(filePath: string): boolean {
  if (!pathLooksLikeCodeFile(filePath) || pathLooksLikeTestFile(filePath) || pathLooksLikeDocumentationFile(filePath)) {
    return false;
  }

  return /(^|\/)(adapters?|sessions?|models?|api|client|transport|router|middleware|requests?|responses?|utils?)\.[^/]+$/i.test(
    filePath,
  ) || /(^|\/)(adapter|session|model|api|client|transport|router|middleware|request|response|core|utils?)(\/|$)/i.test(
    filePath,
  );
}

function changeTextLooksHighRisk(text: string): boolean {
  const nonBlankLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const exceptCount = (text.match(/\bexcept\b/g) ?? []).length + (text.match(/\bcatch\b/g) ?? []).length;
  const tryCount = (text.match(/\btry\b/g) ?? []).length;
  const broadRequestFlowTouch =
    /\b(conn\.urlopen|HTTPResponse\.from_httplib|_get_conn|putrequest|timeout\s*=|retries\s*=|raise\s+\w+Error)\b/.test(
      text,
    );

  return nonBlankLines >= 12 || exceptCount >= 2 || (tryCount >= 1 && exceptCount >= 1) || broadRequestFlowTouch;
}

function readWriteLikeChangeSegments(input: unknown): { before?: string; after?: string } {
  const search = pickStringAliasFromUnknown(input, [
    "search",
    "search_replace",
    "searchReplace",
    "old_string",
    "oldString",
    "old_text",
    "oldText",
  ]);
  const replace = pickStringAliasFromUnknown(input, [
    "replace",
    "new_content",
    "newContent",
    "new_string",
    "newString",
    "new_text",
    "newText",
  ]);
  if (typeof search === "string" && typeof replace === "string") {
    return {
      before: search,
      after: replace,
    };
  }

  const content = pickStringAliasFromUnknown(input, [
    "content",
    "contents",
    "new_content",
    "newContent",
    "new_string",
    "newString",
    "new_text",
    "newText",
  ]);
  if (typeof content === "string") {
    return {
      after: content,
    };
  }

  return {};
}

function analyzeWriteLikeModification(toolCall: LangGraphToolCall): WriteLikeModificationAnalysis | null {
  if (toolCall.name !== "edit" && toolCall.name !== "write") {
    return null;
  }

  const path = readToolCallPath(toolCall);
  if (!path) {
    return null;
  }

  const { before, after } = readWriteLikeChangeSegments(toolCall.input);
  const isolated = typeof before === "string" && typeof after === "string"
    ? stripSharedLineContext(before, after)
    : { beforeChanged: "", afterChanged: after ?? "" };
  const changedText = [isolated.beforeChanged, isolated.afterChanged]
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n");
  const changedLines = changedText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const meaningfulCodeLineCount = countMeaningfulCodeLines(changedText);
  const broadFlowRewrite = changeTextLooksHighRisk(changedText);
  const documentationOnly = changedLines.length > 0 && changedLines.every((line) => !isMeaningfulCodeLine(line) && !isImportLikeLine(line));
  const importOnly = changedLines.length > 0 && meaningfulCodeLineCount === 0 && changedLines.some((line) => isImportLikeLine(line));
  const substantialCodeChange =
    pathLooksLikeCodeFile(path)
    && !pathLooksLikeDocumentationFile(path)
    && meaningfulCodeLineCount > 0;
  const highRisk = substantialCodeChange && pathLooksLikeHighRiskSharedCode(path);

  return {
    path,
    documentationOnly,
    importOnly,
    substantialCodeChange,
    changedLineCount: changedLines.length,
    meaningfulCodeLineCount,
    broadFlowRewrite,
    highRisk,
    highRiskReason: highRisk
      ? `路径 ${path} 属于共享热路径，需要最小增量 edit 和更严格的相邻回归验证。`
      : undefined,
  };
}

function buildModificationBudget(
  state: AgentGraphState,
  userMessage: string | undefined,
  analysis: WriteLikeModificationAnalysis,
): ModificationBudget {
  // 最小改动预算只在“高风险共享路径 + 行为修复”开启。
  // 目的不是限制所有 edit，而是拦住在 adapters/sessions/models 这类公共热路径上
  // 直接复制大段流程、包宽泛异常处理、一次改太多语义分支的 patch。
  const corpus = collectVerificationIntentText(state, userMessage);
  const behavioralChange = textSuggestsBehavioralChange(corpus) && !textSuggestsNoBehaviorChange(corpus);
  const targetHints = collectVerificationTargetHints(
    state,
    userMessage,
    analysis.path ? [analysis.path] : [],
  );
  const suggestedCommands = buildTargetedBehavioralCommands(targetHints);

  if (!behavioralChange || !analysis.highRisk) {
    return {
      enforceMinimalDelta: false,
      maxChangedLines: 0,
      maxMeaningfulCodeLines: 0,
      disallowBroadFlowRewrite: false,
      targetHints,
      suggestedCommands,
      rationale: "当前修改不属于高风险共享路径上的行为修复，不启用最小改动预算。",
    };
  }

  return {
    enforceMinimalDelta: true,
    maxChangedLines: 24,
    maxMeaningfulCodeLines: 14,
    disallowBroadFlowRewrite: true,
    targetHints,
    suggestedCommands,
    rationale:
      "共享热路径上的行为修复优先最小增量 edit，避免复制整段主流程、包一层过宽 try/except，或一次改动过多语义分支。",
  };
}

function explainModificationBudgetViolation(
  budget: ModificationBudget,
  analysis: WriteLikeModificationAnalysis,
): string | undefined {
  if (!budget.enforceMinimalDelta) {
    return undefined;
  }

  const reasons: string[] = [];

  if (budget.disallowBroadFlowRewrite && analysis.broadFlowRewrite) {
    reasons.push("这次 edit 像宽范围控制流/异常映射重写，不是最小增量补丁。");
  }

  if (analysis.changedLineCount > budget.maxChangedLines) {
    reasons.push(`这次 edit 触及 ${analysis.changedLineCount} 个非空行，超过当前预算 ${budget.maxChangedLines}。`);
  }

  if (analysis.meaningfulCodeLineCount > budget.maxMeaningfulCodeLines) {
    reasons.push(
      `这次 edit 含 ${analysis.meaningfulCodeLineCount} 个有效代码行，超过当前预算 ${budget.maxMeaningfulCodeLines}。`,
    );
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return [
    budget.rationale,
    analysis.path ? `目标路径：${analysis.path}` : undefined,
    ...reasons,
    budget.targetHints.length > 0 ? `优先围绕这些测试目标做小改动：${budget.targetHints.join("、")}` : undefined,
    budget.suggestedCommands.length > 0 ? `修改后优先验证：${budget.suggestedCommands.join("；")}` : undefined,
    "请改成更小范围的 edit：优先命中现有异常边界、条件分支或返回值分支，而不是复制整段共享路径。",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function collectVerificationIntentText(state: AgentGraphState, userMessage: string | undefined): string {
  return [
    userMessage ?? "",
    state.activeGoal.title,
    state.activeGoal.description,
    ...state.activeGoal.successCriteria,
    state.currentPlan?.summary ?? "",
    ...(state.currentPlan?.steps.map((step) => `${step.title} ${step.description} ${step.evidence ?? ""}`) ?? []),
    ...state.tasks.map((task) => `${task.title} ${task.inputSummary} ${task.outputSummary ?? ""}`),
  ]
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n");
}

function collectRecentTouchedPaths(state: AgentGraphState): string[] {
  const paths: string[] = [];

  for (const log of state.toolInvocations) {
    const parsedInput = parseToolLogInput(log.inputJson);
    const path = readPathFromUnknownInput(parsedInput);
    if (path) {
      paths.push(path);
    }
  }

  return uniqueStrings(paths);
}

function collectVerificationTargetHints(
  state: AgentGraphState,
  userMessage: string | undefined,
  modifiedPaths: string[],
): string[] {
  const corpus = collectVerificationIntentText(state, userMessage);
  const testSelectorHints = extractTestSelectorHintsFromText(corpus);
  const textPathHints = extractPathHintsFromText(corpus).filter((path) => pathLooksLikeTestFile(path));
  const recentTestPaths = collectRecentTouchedPaths(state).filter((path) => pathLooksLikeTestFile(path));
  const modifiedTestPaths = modifiedPaths.filter((path) => pathLooksLikeTestFile(path));

  return uniqueStrings([
    ...testSelectorHints,
    ...textPathHints,
    ...recentTestPaths,
    ...modifiedTestPaths,
  ]).slice(0, 3);
}

function collectAdjacentRegressionHints(
  targetHints: string[],
  highRiskPaths: string[],
): string[] {
  if (targetHints.length === 0 && highRiskPaths.length === 0) {
    return [];
  }

  return uniqueStrings([
    ...targetHints,
    ...highRiskPaths.map((filePath) => path.basename(filePath)),
  ]).slice(0, 3);
}

function buildPytestTargetCommand(targetHint: string): string | undefined {
  if (!targetHint.includes(".py::")) {
    return undefined;
  }

  return `python3 -m pytest ${targetHint}`;
}

function findUnittestModuleTarget(targetHint: string): string | undefined {
  if (!/^\w[\w.]*$/.test(targetHint) || !/test/i.test(targetHint)) {
    return undefined;
  }

  const parts = targetHint.split(".");
  let lastModuleIndex = -1;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (/^[a-z0-9_]+$/.test(part) && /test/i.test(part)) {
      lastModuleIndex = index;
    }
  }

  if (lastModuleIndex === -1) {
    return undefined;
  }

  return parts.slice(0, lastModuleIndex + 1).join(".");
}

function buildTargetedBehavioralCommands(targetHints: string[]): string[] {
  // 这里不自动执行命令，只负责把“当前最小目标验证命令”显式算出来，
  // 再写进 policy message，逼 executor 在 verify phase 用更贴近修改点的命令。
  const commands: string[] = [];

  for (const targetHint of targetHints) {
    const pytestCommand = buildPytestTargetCommand(targetHint);
    if (pytestCommand) {
      commands.push(pytestCommand);
      continue;
    }

    if (pathLooksLikeTestFile(targetHint)) {
      commands.push(`python3 -m pytest ${targetHint}`);
      continue;
    }

    if (findUnittestModuleTarget(targetHint)) {
      commands.push(`python3 -m unittest ${targetHint}`);
    }
  }

  return uniqueStrings(commands).slice(0, 2);
}

function buildAdjacentRegressionCommands(
  targetHints: string[],
  adjacentHints: string[],
): string[] {
  // 相邻回归命令选择器会尽量从单 case 退回到同文件/同模块，
  // 避免只跑一个 target 就收尾。
  const commands: string[] = [];

  for (const targetHint of targetHints) {
    if (targetHint.includes(".py::")) {
      commands.push(`python3 -m pytest ${targetHint.split("::")[0]}`);
      continue;
    }

    const unittestModule = findUnittestModuleTarget(targetHint);
    if (unittestModule) {
      commands.push(`python3 -m unittest ${unittestModule}`);
    }
  }

  for (const adjacentHint of adjacentHints) {
    if (pathLooksLikeTestFile(adjacentHint)) {
      commands.push(`python3 -m pytest ${adjacentHint}`);
      continue;
    }

    const unittestModule = findUnittestModuleTarget(adjacentHint);
    if (unittestModule) {
      commands.push(`python3 -m unittest ${unittestModule}`);
    }
  }

  return uniqueStrings(commands).slice(0, 2);
}

// buildVerificationRequirement 是当前 verification policy 的核心。
// 它不再只回答一个布尔问题“要不要验证”，而是显式返回：
// - 当前需要的是结构性验证，还是行为验证
// - 如果已经有明确测试目标，是否必须做到“目标化行为验证”
// - 对下一轮 executor 最有价值的验证建议是什么
//
// 这样 executeNode 的放行条件就能从“看到一次 bash 就算验证过了”
// 推进到“这次 bash 的类型和粒度，到底够不够支持 finalize”。
function buildVerificationRequirement(
  state: AgentGraphState,
  userMessage: string | undefined,
  modifiedPaths: string[],
  highRiskPaths: string[],
): VerificationRequirement {
  const userIntent = userMessage ?? "";
  if (textSuggestsDocumentationOnly(userIntent) && !textSuggestsBehavioralChange(userIntent)) {
    return {
      requiredLevel: "none",
      requireTargetedBehavioral: false,
      requireAdjacentRegression: false,
      recommendedCommandKinds: [],
      targetHints: [],
      adjacentHints: [],
      targetedCommands: [],
      adjacentCommands: [],
      rationale: "当前请求本身更像纯说明/注释任务，不需要额外验证。",
    };
  }

  const corpus = collectVerificationIntentText(state, userMessage);
  if (corpus.trim().length === 0) {
    return {
      requiredLevel: "none",
      requireTargetedBehavioral: false,
      requireAdjacentRegression: false,
      recommendedCommandKinds: [],
      targetHints: [],
      adjacentHints: [],
      targetedCommands: [],
      adjacentCommands: [],
      rationale: "当前没有足够上下文判断验证需求。",
    };
  }

  if (
    textSuggestsDocumentationOnly(corpus)
    && !textSuggestsBehavioralChange(corpus)
  ) {
    return {
      requiredLevel: "none",
      requireTargetedBehavioral: false,
      requireAdjacentRegression: false,
      recommendedCommandKinds: [],
      targetHints: [],
      adjacentHints: [],
      targetedCommands: [],
      adjacentCommands: [],
      rationale: "当前 goal / plan / task 都更像文档型修改，不需要额外验证。",
    };
  }

  if (
    textSuggestsDocumentationOnly(corpus)
    && textSuggestsNoBehaviorChange(corpus)
    && !textSuggestsBehavioralChange(userIntent)
  ) {
    return {
      requiredLevel: "none",
      requireTargetedBehavioral: false,
      requireAdjacentRegression: false,
      recommendedCommandKinds: [],
      targetHints: [],
      adjacentHints: [],
      targetedCommands: [],
      adjacentCommands: [],
      rationale: "当前上下文明确声明这次修改不涉及行为变化。",
    };
  }

  const targetHints = collectVerificationTargetHints(state, userMessage, modifiedPaths);
  const adjacentHints = collectAdjacentRegressionHints(targetHints, highRiskPaths);
  const targetedCommands = buildTargetedBehavioralCommands(targetHints);
  const adjacentCommands = buildAdjacentRegressionCommands(targetHints, adjacentHints);
  const modifiedCodePaths = modifiedPaths.filter((path) => pathLooksLikeCodeFile(path));
  const explicitNoBehaviorChange = textSuggestsNoBehaviorChange(corpus) || textSuggestsNoBehaviorChange(userIntent);
  const behavioralChange = !explicitNoBehaviorChange && textSuggestsBehavioralChange(corpus);

  if (behavioralChange) {
    const requireAdjacentRegression = highRiskPaths.length > 0 && targetHints.length > 0;
    const recommendedCommandKinds = requireAdjacentRegression
      ? [
          `当前修改命中了高风险共享路径：${highRiskPaths.join("、")}`,
          `先跑主目标，再补同文件/同模块的相邻回归：${adjacentHints.join("、")}`,
          "不要只跑单个 case 就 finalize，至少做整文件/整模块级行为验证",
        ]
      : targetHints.length > 0
        ? [
            `优先跑与这些目标直接相关的局部测试/局部回归：${targetHints.join("、")}`,
            "不要只跑结构性检查（如 py_compile、typecheck、lint、git diff --check）就收尾",
          ]
        : [
            "优先跑最小行为验证：单测、局部回归、单文件测试或单用例测试",
            "只有结构性检查通过还不够，至少要有一次真正的行为级验证",
          ];

    return {
      requiredLevel: "behavioral",
      requireTargetedBehavioral: targetHints.length > 0,
      requireAdjacentRegression,
      recommendedCommandKinds,
      targetHints,
      adjacentHints,
      targetedCommands,
      adjacentCommands,
      rationale:
        requireAdjacentRegression
          ? "当前请求属于行为性修改，而且已经触达高风险共享路径；如果只验证主目标而不补相邻回归，很容易引入旧语义回归。"
          : targetHints.length > 0
            ? "当前请求属于行为性修改，而且上下文里已经出现了具体测试/回归目标。"
            : "当前请求属于行为性修改，结构性验证不足以证明补丁正确。",
    };
  }

  if (looksLikeModificationRequest(userMessage) || hasPendingModificationWork(state) || modifiedCodePaths.length > 0) {
    return {
      requiredLevel: "structural",
      requireTargetedBehavioral: false,
      requireAdjacentRegression: false,
      recommendedCommandKinds: [
        modifiedCodePaths.length > 0
          ? `优先围绕已修改文件做最小结构性验证：${modifiedCodePaths.slice(0, 3).join("、")}`
          : "优先围绕已修改文件做最小结构性验证",
        "可选形式包括 git diff --check、语法检查、类型检查、lint 或最小 build",
      ],
      targetHints: [],
      adjacentHints: [],
      targetedCommands: [],
      adjacentCommands: [],
      rationale: "当前修改看起来不直接改变业务行为，但仍然需要至少一轮结构性验证再收尾。",
    };
  }

  return {
    requiredLevel: "none",
    requireTargetedBehavioral: false,
    requireAdjacentRegression: false,
    recommendedCommandKinds: [],
    targetHints: [],
    adjacentHints: [],
    targetedCommands: [],
    adjacentCommands: [],
    rationale: "当前没有识别到需要额外验证的修改风险。",
  };
}

function formatVerificationRequirement(requirement: VerificationRequirement): string {
  if (requirement.requiredLevel === "none") {
    return "当前无需额外验证。";
  }

  const levelLabel =
    requirement.requiredLevel === "behavioral"
      ? requirement.requireAdjacentRegression
        ? "目标化行为验证 + 相邻回归验证"
        : requirement.requireTargetedBehavioral
          ? "目标化行为验证"
          : "行为验证"
      : "结构性验证";

  const lines = [
    `当前验证门槛：${levelLabel}。`,
    `原因：${requirement.rationale}`,
  ];

  if (requirement.targetHints.length > 0) {
    lines.push(`优先目标：${requirement.targetHints.join("、")}`);
  }

  if (requirement.adjacentHints.length > 0) {
    lines.push(`相邻回归：${requirement.adjacentHints.join("、")}`);
  }

  if (requirement.targetedCommands.length > 0) {
    lines.push(`目标验证命令：${requirement.targetedCommands.join("；")}`);
  }

  if (requirement.adjacentCommands.length > 0) {
    lines.push(`相邻回归命令：${requirement.adjacentCommands.join("；")}`);
  }

  if (requirement.recommendedCommandKinds.length > 0) {
    lines.push(`建议验证：${requirement.recommendedCommandKinds.join("；")}`);
  }

  return lines.join("\n");
}

function commandLooksLikeBehavioralVerification(command: string | undefined): boolean {
  if (!command) {
    return false;
  }

  return /\b(pytest|unittest|vitest|jest|mocha|ava|tox|nox|phpunit|rspec)\b/i.test(command)
    || /\b(go test|cargo test|mvn test|gradle test|make test)\b/i.test(command)
    || /\b(pnpm test|npm test|npm run test|yarn test)\b/i.test(command);
}

function commandLooksLikeStructuralVerification(command: string | undefined): boolean {
  if (!command) {
    return false;
  }

  return /\b(go vet|cargo check|go build|tsc\b|eslint\b|ruff check|mypy\b|py_compile|git diff --check|typecheck|lint|build|compile|check|node --check)\b/i.test(
    command,
  );
}

function commandLooksTargeted(command: string | undefined): boolean {
  if (!command) {
    return false;
  }

  return /(::| -k | -m | --grep | --filter | -run )/.test(command)
    || /(?:^|\s)[\w./-]+\.(?:py|js|jsx|ts|tsx|go|rs|rb|java|c|cc|cpp|h|hpp|sh)(?:\s|$)/i.test(command)
    || /\btests?\.[\w.]+\b/i.test(command)
    || /\btests?\/[\w./-]+\b/i.test(command);
}

function commandLooksLikeAdjacentRegression(command: string | undefined): boolean {
  if (!command) {
    return false;
  }

  const explicitSelectors = command.match(/[\w./-]+\.py::[\w.:-]+(?:::[\w.:-]+)?/g) ?? [];
  const dottedUnittestTargets = command.match(/\btests?\.[\w.]+\b/g) ?? [];
  const hasWholeModuleTarget = dottedUnittestTargets.some((target) => (target.match(/\./g) ?? []).length <= 2);
  const runsWholeTestFileOrModule =
    explicitSelectors.length === 0
    && (
      /(?:^|\s)[\w./-]*test[\w./-]*\.py(?:\s|$)/i.test(command)
      || /(?:^|\s)tests?\/[\w./-]+(?:\s|$)/i.test(command)
      || hasWholeModuleTarget
    );

  return runsWholeTestFileOrModule || explicitSelectors.length > 1;
}

function analyzeVerificationCommand(command: string | undefined): VerificationCommandAnalysis | null {
  if (!command) {
    return null;
  }

  if (commandLooksLikeBehavioralVerification(command)) {
    return {
      level: "behavioral",
      targeted: commandLooksTargeted(command),
      adjacentRegression: commandLooksLikeAdjacentRegression(command),
    };
  }

  if (commandLooksLikeStructuralVerification(command)) {
    return {
      level: "structural",
      targeted: false,
      adjacentRegression: false,
    };
  }

  return null;
}

function commandLooksLikeVerification(command: string | undefined): boolean {
  return analyzeVerificationCommand(command) !== null;
}

function satisfiesVerificationRequirement(
  requirement: VerificationRequirement,
  progress: VerificationProgress,
): boolean {
  if (requirement.requiredLevel === "none") {
    return true;
  }

  if (!progress.attempted || progress.latestAttemptFailed) {
    return false;
  }

  if (requirement.requiredLevel === "structural") {
    return progress.strongestSuccessfulLevel === "structural" || progress.strongestSuccessfulLevel === "behavioral";
  }

  if (requirement.requireAdjacentRegression) {
    return progress.hasAdjacentRegressionSuccess;
  }

  if (requirement.requireTargetedBehavioral) {
    return progress.hasTargetedBehavioralSuccess;
  }

  return progress.strongestSuccessfulLevel === "behavioral";
}

function describeVerificationGap(
  requirement: VerificationRequirement,
  progress: VerificationProgress,
): string {
  if (requirement.requiredLevel === "none") {
    return "当前没有额外验证缺口。";
  }

  if (!progress.attempted) {
    return "最新改动之后还没有任何验证尝试。";
  }

  if (progress.latestAttemptFailed) {
    return "最近一次验证明确失败了。";
  }

  if (requirement.requiredLevel === "behavioral") {
    if (requirement.requireAdjacentRegression && !progress.hasAdjacentRegressionSuccess) {
      return "已经有成功验证，但当前仍缺少一次相邻回归验证。";
    }

    if (requirement.requireTargetedBehavioral && !progress.hasTargetedBehavioralSuccess) {
      return "已经有成功验证，但粒度还不够；当前仍缺少一次目标化行为验证。";
    }

    if (progress.strongestSuccessfulLevel !== "behavioral") {
      return "已经有成功验证，但仍然只有结构性验证，缺少行为级验证。";
    }
  }

  return "当前验证尚未满足运行时门槛。";
}

function pickStrongerVerificationLevel(
  current: VerificationLevel,
  candidate: VerificationLevel,
): VerificationLevel {
  if (current === "behavioral" || candidate === "none") {
    return current;
  }

  if (candidate === "behavioral") {
    return "behavioral";
  }

  if (current === "structural" || candidate === "structural") {
    return "structural";
  }

  return current;
}

/**
 * 判断 runtimeState 中是否存在明显的、尚未完成的修改类任务或计划步骤。
 * 该函数用于在 explain -> modify 的过渡策略中决定是否要强制进入 modify。
 */
function hasPendingModificationWork(state: AgentGraphState): boolean {
  const taskSuggestsModify = state.tasks.some(
    (task) =>
      (task.status === "todo" || task.status === "in_progress" || task.status === "blocked")
      && textSuggestsModification(
        `${task.title} ${task.inputSummary} ${task.outputSummary ?? ""}`,
      ),
  );

  if (taskSuggestsModify) {
    return true;
  }

  return Boolean(
    state.currentPlan?.steps.some(
      (step) =>
        (step.status === "todo" || step.status === "in_progress" || step.status === "blocked")
        && textSuggestsModification(
          `${step.title} ${step.description} ${step.evidence ?? ""}`,
        ),
    ),
  );
}

function parseToolLogInput(inputJson: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readPathFromUnknownInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const pathValue = input.path ?? input.file_path ?? input.filePath;
  return typeof pathValue === "string" && pathValue.trim().length > 0 ? pathValue.trim() : undefined;
}

function collectPreviouslyViewedPaths(state: AgentGraphState): Set<string> {
  const viewedPaths = new Set<string>();

  for (const log of state.toolInvocations) {
    if (log.status !== "completed" || log.toolName !== "view") {
      continue;
    }

    const parsedInput = parseToolLogInput(log.inputJson);
    const path = readPathFromUnknownInput(parsedInput);
    if (path) {
      viewedPaths.add(path);
    }
  }

  return viewedPaths;
}

function hasLocatedModificationAnchor(state: AgentGraphState): boolean {
  return collectPreviouslyViewedPaths(state).size > 0;
}

function isReadOnlyToolCall(toolCall: LangGraphToolCall): boolean {
  return toolCall.name === "view" || toolCall.name === "grep" || toolCall.name === "list";
}

function readOnlyToolCallsTargetKnownPath(
  state: AgentGraphState,
  toolCalls: LangGraphToolCall[],
): boolean {
  const viewedPaths = collectPreviouslyViewedPaths(state);
  if (viewedPaths.size === 0) {
    return false;
  }

  let sawKnownReadOnlyPath = false;

  for (const toolCall of toolCalls) {
    if (!isReadOnlyToolCall(toolCall)) {
      return false;
    }

    const path = readPathFromUnknownInput(toolCall.input);
    if (!path) {
      continue;
    }

    if (viewedPaths.has(path)) {
      sawKnownReadOnlyPath = true;
      continue;
    }

    return false;
  }

  return sawKnownReadOnlyPath;
}

function readBashCommand(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const command = input.command ?? input.cmd ?? input.script;
  return typeof command === "string" && command.trim().length > 0 ? command.trim() : undefined;
}

function readBashExitCode(output: unknown): number | undefined {
  if (!isRecord(output)) {
    return undefined;
  }

  return typeof output.exitCode === "number" && Number.isFinite(output.exitCode) ? output.exitCode : undefined;
}

/**
 * 构造传给 RuntimeToolExecutor 的最终输入：
 * - 复制原始 toolCall.input
 * - 注入 workspace 根路径（root）以便工具定位文件
 */
function prepareToolInput(
  workspacePath: string,
  toolCall: LangGraphToolCall,
): Record<string, unknown> {
  const baseInput = isRecord(toolCall.input) ? { ...toolCall.input } : {};

  return {
    ...baseInput,
    root: workspacePath,
  };
}

/**
 * 把工具调用结果格式化成可写入 message ledger 的字符串：
 * - 对 view 专门提取 path / lineRange / content（做截断）
 * - 对其它工具安全序列化 output
 */
function summarizeToolResult(
  toolCall: LangGraphToolCall,
  result: ToolResult<unknown>,
): string {
  const lines = [
    `tool=${toolCall.name}`,
    toolCall.taskId ? `taskId=${toolCall.taskId}` : undefined,
    toolCall.reasoning ? `reasoning=${toolCall.reasoning}` : undefined,
    `input=${truncate(stableSerialize(toolCall.input), 1200)}`,
  ].filter((line): line is string => Boolean(line));

  if (!result.ok) {
    lines.push(`error=${result.error ?? "unknown tool error"}`);
    return lines.join("\n");
  }

  if (toolCall.name === "view" && isRecord(result.output)) {
    const path = typeof result.output.path === "string" ? result.output.path : undefined;
    const startLine = typeof result.output.startLine === "number" ? result.output.startLine : undefined;
    const endLine = typeof result.output.endLine === "number" ? result.output.endLine : undefined;
    const content = typeof result.output.content === "string" ? result.output.content : undefined;

    if (path) {
      lines.push(`path=${path}`);
    }
    if (startLine !== undefined && endLine !== undefined) {
      lines.push(`lineRange=${startLine}-${endLine}`);
    }
    if (content) {
      lines.push("content:");
      lines.push(truncate(content, 3200));
    }

    return lines.join("\n");
  }

  lines.push(`output=${truncate(stableSerialize(result.output ?? null), 1600)}`);
  return lines.join("\n");
}

/**
 * 当检测到完全重复的工具调用刚刚已经成功执行时，生成的系统提示。
 * 该提示旨在提醒模型不要原样重复同一操作。
 */
function createDuplicateToolLoopGuardMessage(toolCall: LangGraphToolCall): string {
  const guidance =
    toolCall.name === "view"
      ? "同一个 view 已经成功返回过内容。不要再次读取同一个文件；请基于现有内容继续 edit/write，或者直接给出最终结果。"
      : "同一个工具调用刚刚已经执行过。不要原样重复；请基于已有结果推进下一步，或者直接给出最终结果。";

  return [
    "LOOP_GUARD: 检测到连续重复的工具调用。",
    `tool=${toolCall.name}`,
    `input=${truncate(stableSerialize(toolCall.input), 1200)}`,
    guidance,
  ].join("\n");
}

/**
 * 从 runtimeState 提取一个精简的 JSON 字符串，用作 checkpoint 的 stateJson 字段。
 * 目的是保存必要的元信息以便快速恢复会话上下文，而不是把整个实体 dump 出去。
 */
function summarizeStateForCheckpoint(runtimeState: AgentGraphState | null): string {
  return JSON.stringify({
    workspaceId: runtimeState?.workspaceId ?? null,
    sessionId: runtimeState?.session.id ?? null,
    activeGoalId: runtimeState?.activeGoal.id ?? null,
    activeGoalStatus: runtimeState?.activeGoal.status ?? null,
    currentPlanId: runtimeState?.currentPlan?.id ?? null,
    taskCount: runtimeState?.tasks.length ?? 0,
    subagentRunCount: runtimeState?.subagentRuns.length ?? 0,
    activeAgent: runtimeState?.activeAgent ?? null,
  });
}

/**
 * 将当前工作流节点的轻量快照写入持久化 checkpointer（通过 service 封装）。
 * 仅保存 summarizeStateForCheckpoint 返回的精简状态，避免过度冗余。
 */
async function persistWorkflowCheckpoint(
  service: GoalDrivenRuntimeService,
  sessionId: string,
  node: WorkflowNode,
  runtimeState: AgentGraphState | null,
  summary: string,
): Promise<void> {
  await service.createCheckpoint({
    sessionId,
    node,
    stateJson: summarizeStateForCheckpoint(runtimeState),
    summary,
  });
}

/**
 * 从服务层重新读取当前 session 的 runtime state（实时一致读取）。
 * 这个封装便于后续在全局范围内统一替换为带缓存/观察器的实现。
 */
async function refreshRuntimeState(
  service: GoalDrivenRuntimeService,
  sessionId: string,
): Promise<AgentGraphState | null> {
  return service.buildGraphState(sessionId);
}

/**
 * 在没有注入 summarizer hook 时，生成一个覆盖常见字段的默认 session summary。
 * 该函数只负责把 runtimeState 压缩为 UI/IDE 需要的一小段概要文本。
 */
function createDefaultSummary(state: AgentGraphState): Omit<UpdateSessionSummaryInput, "sessionId"> {
  return {
    shortSummary: `当前 goal：${state.activeGoal.title}`,
    openLoops: state.subagentRuns
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => `${run.agentMode} 子代理仍在处理中：${run.reason}`),
    nextActions: state.currentPlan?.steps
      .filter((step) => step.status === "todo" || step.status === "in_progress")
      .map((step) => step.title) ?? [],
    importantFacts: state.memory.slice(0, 3).map((record) => `${record.key}: ${record.value}`),
  };
}

// 面试点：LangGraph 在这里负责“编排顺序”和 thread_id 恢复，
// 但真正的业务动作仍然走 GoalDrivenRuntimeService。
// 这样我们既拿到了 graph orchestration，又没有把业务逻辑绑死在框架 API 上。

/**
 * 创建 Goal-Driven Runtime 的 LangGraph 实例。
 * 这是整个 runtime 的编排中心，定义 8 个节点并串联成执行流程。
 * 
 * 设计关键：
 * - 节点实现与 LangGraphHooks 解耦（hook 返回草案，service 执行业务动作）
 * - 工具调用与 graph 分离（executor 只给清单，真正执行在 toolExecutor）
 * - 完整的 loop guard 防止打转
 * - 每节点保存 checkpoint，支持会话恢复
 */
export function createAgentLangGraph(
  service: GoalDrivenRuntimeService,
  options: LangGraphRuntimeOptions,
): AgentLangGraphRuntime {
  const hooks = options.hooks ?? {};
  const checkpointer = options.checkpointer;
  const toolExecutor = options.toolExecutor;
  const toolApprovalDecider = options.toolApprovalDecider;
  const maxToolRounds = options.maxToolRounds ?? 5;
  const maxToolCallsPerRound = options.maxToolCallsPerRound ?? 4;

  const intakeNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    // intake 是 graph 的入口。职责：
    // 1. 记录用户消息到 ledger
    // 2. 如果没有 active goal，调 goalFactory 生成第一个目标
    // 之后的 plan/execute 阶段才能真正开始
    if (state.userMessage) {
      await service.appendMessage({
        sessionId: state.sessionId,
        role: "user",
        content: state.userMessage,
      });
    }

    let runtimeState = await refreshRuntimeState(service, state.sessionId);
    let intakeSummary = state.userMessage ? "已记录用户输入" : "无新增用户输入";

    if (!runtimeState && hooks.goalFactory) {
      const goal = await hooks.goalFactory({
        sessionId: state.sessionId,
        userMessage: state.userMessage,
      });

      if (goal) {
        await service.createGoal({
          sessionId: state.sessionId,
          title: goal.title,
          description: goal.description,
          successCriteria: goal.successCriteria,
        });
        runtimeState = await refreshRuntimeState(service, state.sessionId);
        intakeSummary = `已创建 goal：${goal.title}`;
      }
    }

    await persistWorkflowCheckpoint(service, state.sessionId, "intake", runtimeState, intakeSummary);
    return {
      runtimeState,
      executionLog: logLine("intake", intakeSummary),
    };
  };

  const clarifyNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    const summary = "当前最小 LangGraph 接入未启用 clarify hook";
    await persistWorkflowCheckpoint(service, state.sessionId, "clarify", state.runtimeState, summary);
    return {
      executionLog: logLine("clarify", summary),
    };
  };

  const planNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    // planNode 的职责很单纯：把 planner hook 的结构化输出，变成真正持久化的 Plan。
    // 这里不自己“猜计划怎么生成”，而是把业务动作下沉给 service.savePlan。
    // 这样 graph 只管编排顺序，plan 的真正生命周期则统一走应用服务层。
    if (!state.runtimeState) {
      return {
        executionLog: logLine("plan", "当前 session 没有 active goal，跳过 plan"),
      };
    }

    if (!hooks.planner) {
      return {
        executionLog: logLine("plan", "未注入 planner hook，跳过 plan"),
      };
    }

    const planDraft = await hooks.planner(state.runtimeState, {
      sessionId: state.sessionId,
      userMessage: state.userMessage,
    });
    if (!planDraft) {
      return {
        executionLog: logLine("plan", "planner hook 返回空结果，跳过 plan"),
      };
    }

    const plan = await service.savePlan({
      sessionId: state.sessionId,
      ...planDraft,
    });
    const runtimeState = await refreshRuntimeState(service, state.sessionId);
    const summary = `已保存 plan：${plan.summary}`;
    await persistWorkflowCheckpoint(service, state.sessionId, "plan", runtimeState, summary);

    return {
      runtimeState,
      latestPlanId: plan.id,
      executionLog: logLine("plan", summary),
    };
  };

  const delegateNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    // delegateNode 是 parent session 决定“要不要派生 child session”的地方。
    // 这里的关键点不是让模型说一句“需要子代理”，而是把这个判断落实成：
    // - child session
    // - subagent run
    // - latestSubagentRunId
    // - checkpoint / executionLog
    if (!state.runtimeState) {
      return {
        executionLog: logLine("delegate", "当前 session 没有 active goal，跳过 delegation"),
      };
    }

    if (!hooks.delegate) {
      return {
        executionLog: logLine("delegate", "未注入 delegate hook，跳过 delegation"),
      };
    }

    const delegation = await hooks.delegate(state.runtimeState, {
      sessionId: state.sessionId,
      userMessage: state.userMessage,
    });
    if (!delegation) {
      return {
        executionLog: logLine("delegate", "delegate hook 返回空结果，跳过 delegation"),
      };
    }

    const result = await service.delegateToSubagent({
      parentSessionId: state.sessionId,
      ...delegation,
    });
    const runtimeState = await refreshRuntimeState(service, state.sessionId);
    const summary = `已委托给 ${result.run.agentMode} 子代理：${result.run.reason}`;
    await persistWorkflowCheckpoint(service, state.sessionId, "delegate", runtimeState, summary);

    return {
      runtimeState,
      latestSubagentRunId: result.run.id,
      executionLog: logLine("delegate", summary),
    };
  };

  const executeNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    // executeNode 是整个 runtime 最复杂的一段。
    // 可以把它理解成一个受约束的 tool-use control loop：
    // 1. 调 executor hook，让模型给出结构化执行草案
    // 2. 同步 tasks / memory
    // 3. 如果有 toolCalls，就真实调用工具
    // 4. 把工具结果写回消息和 invocation ledger
    // 5. 再把新的 runtimeState 喂给下一轮 executor
    //
    // 这段代码的核心价值，不是“让模型多跑几轮”，而是把“什么时候该继续读、什么时候该改、什么时候该收尾”
    // 从纯 prompt 约束，推进成执行层的真实纪律。
    if (!state.runtimeState) {
      return {
        executionLog: logLine("execute", "当前 session 没有 active goal，跳过 execute"),
      };
    }

    if (!hooks.executor) {
      return {
        executionLog: logLine("execute", "未注入 executor hook，跳过 execute"),
      };
    }

    let runtimeState: AgentGraphState = state.runtimeState;
    let executedToolCalls = 0;
    let duplicateToolCalls = 0;
    let executedWriteLikeTool = false;
    let hasSubstantiveBehavioralEdit = false;
    let lastSuccessfulToolCallKey: string | undefined;
    const viewReadBudgets = new Map<string, ViewReadBudgetState>();
    const modifiedPathsSinceLatestWrite = new Set<string>();
    const superficialBehaviorPaths = new Set<string>();
    const highRiskModifiedPaths = new Set<string>();
    let verificationProgress: VerificationProgress = {
      attempted: false,
      latestAttemptFailed: false,
      strongestSuccessfulLevel: "none",
      hasTargetedBehavioralSuccess: false,
      hasAdjacentRegressionSuccess: false,
    };

    for (let round = 0; round < maxToolRounds; round += 1) {
      const execution = await hooks.executor(runtimeState, {
        sessionId: state.sessionId,
        userMessage: state.userMessage,
      });
      if (!execution) {
        if (round === 0) {
          return {
            executionLog: logLine("execute", "executor hook 返回空结果，跳过 execute"),
          };
        }
        break;
      }

      const toolCalls = (execution.toolCalls ?? []).slice(0, maxToolCallsPerRound);
      const executionPhase = inferExecutionPhase(execution);
      const hasModificationAnchor = hasLocatedModificationAnchor(runtimeState);
      const verificationRequirement = buildVerificationRequirement(
        runtimeState,
        state.userMessage,
        [...modifiedPathsSinceLatestWrite],
        [...highRiskModifiedPaths],
      );
      const hasSatisfiedVerificationSinceLatestWrite = satisfiesVerificationRequirement(
        verificationRequirement,
        verificationProgress,
      );
      const shouldForceModifyAfterKnownRead =
        toolCalls.length > 0
        && executionPhase !== "finalize"
        && executionPhase !== "verify"
        && executedToolCalls > 0
        && !executedWriteLikeTool
        && looksLikeModificationRequest(state.userMessage)
        && hasPendingModificationWork(runtimeState)
        && hasModificationAnchor
        && readOnlyToolCallsTargetKnownPath(runtimeState, toolCalls)
        && !toolCalls.every((toolCall) => buildToolCallKey(toolCall) === lastSuccessfulToolCallKey)
        && !toolCalls.some((toolCall) => toolCall.name === "view" && hasExplicitViewRange(toolCall))
        && round < maxToolRounds - 1;
      const shouldForceModifyContinuation =
        toolCalls.length === 0
        && executedToolCalls > 0
        && !executedWriteLikeTool
        && looksLikeModificationRequest(state.userMessage)
        && hasPendingModificationWork(runtimeState)
        && hasModificationAnchor
        && round < maxToolRounds - 1;
      const shouldForceVerificationBeforeFinalize =
        verificationRequirement.requiredLevel !== "none"
        && modifiedPathsSinceLatestWrite.size > 0
        && !verificationProgress.attempted
        && (toolCalls.length === 0 || executionPhase === "finalize")
        && round < maxToolRounds - 1;
      const shouldForceSubstantiveBehaviorEdit =
        verificationRequirement.requiredLevel === "behavioral"
        && modifiedPathsSinceLatestWrite.size > 0
        && executedWriteLikeTool
        && !hasSubstantiveBehavioralEdit
        && (toolCalls.length === 0 || executionPhase === "finalize" || executionPhase === "verify")
        && round < maxToolRounds - 1;
      const shouldForceRetryAfterFailedVerification =
        verificationRequirement.requiredLevel !== "none"
        && modifiedPathsSinceLatestWrite.size > 0
        && verificationProgress.attempted
        && verificationProgress.latestAttemptFailed
        && (toolCalls.length === 0 || executionPhase === "finalize")
        && round < maxToolRounds - 1;
      // 这里处理的是“verify 虽然成功了，但等级不够”的情况。
      // 典型例子：
      // - 行为性修改只跑了 py_compile / typecheck
      // - 已经出现明确测试目标，但只跑了一个宽泛的 smoke check
      //
      // 这类情况如果直接 finalize，用户会看到“验证成功”的假象，
      // 但 runtime 其实还没有拿到足够贴近修改点的证据。
      const shouldForceStrongerVerification =
        verificationRequirement.requiredLevel !== "none"
        && modifiedPathsSinceLatestWrite.size > 0
        && verificationProgress.attempted
        && !verificationProgress.latestAttemptFailed
        && !hasSatisfiedVerificationSinceLatestWrite
        && (toolCalls.length === 0 || executionPhase === "finalize")
        && round < maxToolRounds - 1;

      // mixed explain + edit 请求里，如果模型先完成了解释、但还没真正落修改，
      // 这里不要直接把 execute 收尾。
      // 否则用户会看到一段解释文字，却发现文件根本没改，体验上就像“agent 看懂了，但不继续动手”。
      //
      // 当前策略是：
      // - 用户请求里带修改意图
      // - 本轮 phase 仍是 explain
      // - 当前 invoke 已经用过工具，但还没有任何 edit/write 成功
      // - plan/task 里还存在待做的修改工作
      //
      // 那就把解释消息先落库，再追加一条 system nudge，强制下一轮进入 modify phase。
      if (execution.assistantMessage && toolCalls.length === 0) {
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "assistant",
          content: execution.assistantMessage,
        });
      }

      if (shouldForceModifyContinuation || shouldForceModifyAfterKnownRead) {
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "system",
          content: [
            "EXECUTION_POLICY: 用户请求同时包含解释和修改。",
            "当前已经定位到可修改文件或改动锚点，但文件还没有真实改动。",
            shouldForceModifyAfterKnownRead
              ? "不要继续对同一路径发起纯只读 toolCalls；下一轮必须切到 modify phase，直接发起 edit/write。"
              : "下一轮必须切到 modify phase，直接发起 edit/write，不能在 explain/finalize 阶段收尾。",
          ].join("\n"),
        });
        runtimeState = (await refreshRuntimeState(service, state.sessionId)) ?? runtimeState;
        continue;
      }

      if (shouldForceSubstantiveBehaviorEdit) {
        const superficialPaths = [...superficialBehaviorPaths];
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "system",
          content: createModificationPolicyMessage(
            [
              "当前任务属于行为性修改，但最新补丁还没有命中真实行为路径。",
              superficialPaths.length > 0
                ? `目前检测到的改动仍偏表层：${superficialPaths.join("、")}（只改了 import/comment/轻量整理）。`
                : "目前检测到的改动仍偏表层，没有看到真实函数体/条件分支/异常映射上的改动。",
              "下一轮必须继续 modify，在函数体、条件分支、异常映射、返回值或参数处理等真实行为路径上发起 edit/write。",
            ].join("\n"),
          ),
        });
        runtimeState = (await refreshRuntimeState(service, state.sessionId)) ?? runtimeState;
        continue;
      }

      if (shouldForceVerificationBeforeFinalize) {
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "system",
          content: createVerificationPolicyMessage(
            [
              "当前 invoke 已经真实修改过文件，但在最新改动之后还没有任何验证尝试。下一轮必须切到 verify phase，不要直接 finalize。",
              formatVerificationRequirement(verificationRequirement),
            ].join("\n"),
          ),
        });
        runtimeState = (await refreshRuntimeState(service, state.sessionId)) ?? runtimeState;
        continue;
      }

      if (shouldForceRetryAfterFailedVerification) {
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "system",
          content: createVerificationPolicyMessage(
            [
              "最近一次 verify phase 在最新改动之后失败了。下一轮不要 finalize；你必须基于失败输出继续 modify，或者再次请求更小范围的 verify。",
              formatVerificationRequirement(verificationRequirement),
            ].join("\n"),
          ),
        });
        runtimeState = (await refreshRuntimeState(service, state.sessionId)) ?? runtimeState;
        continue;
      }

      if (shouldForceStrongerVerification) {
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "system",
          content: createVerificationPolicyMessage(
            [
              describeVerificationGap(verificationRequirement, verificationProgress),
              "不要把这次 verify 当成最终收尾依据；下一轮必须继续补足更强或更贴近修改点的验证。",
              formatVerificationRequirement(verificationRequirement),
            ].join("\n"),
          ),
        });
        runtimeState = (await refreshRuntimeState(service, state.sessionId)) ?? runtimeState;
        continue;
      }

      if (execution.tasks?.length) {
        await service.syncTasks({
          sessionId: state.sessionId,
          tasks: execution.tasks,
        });
      }

      if (execution.memory?.length) {
        for (const memory of execution.memory) {
          await service.recordMemory({
            sessionId: state.sessionId,
            ...memory,
          });
        }
      }

      if (toolCalls.length === 0) {
        runtimeState = (await refreshRuntimeState(service, state.sessionId)) ?? runtimeState;
        break;
      }

      if (!toolExecutor) {
        throw new Error("executor 请求了工具调用，但当前 LangGraph runtime 未注入 toolExecutor");
      }

      const workspace = await service.getWorkspaceForSession(state.sessionId);
      let executedThisRound = 0;

      for (const toolCall of toolCalls) {
        const toolCallKey = buildToolCallKey(toolCall);
        const toolPath = readToolCallPath(toolCall);
        const explicitViewRangeKey = toolCall.name === "view" ? readExplicitViewRangeKey(toolCall) : undefined;
        const viewBudget =
          toolCall.name === "view" && toolPath
            ? (viewReadBudgets.get(toolPath) ?? createViewReadBudgetState())
            : undefined;
        const anchorFocusedReread =
          toolCall.name === "view" && viewBudget ? isAnchorFocusedReread(viewBudget, toolCall) : false;

        // 第一层 loop guard：完全相同的工具调用刚刚已经成功执行过。
        // 这个规则能拦住最直接的“同一个 tool + 同一个 input 原样重放”。
        if (toolCallKey === lastSuccessfulToolCallKey) {
          duplicateToolCalls += 1;
          await service.appendMessage({
            sessionId: state.sessionId,
            role: "system",
            content: createDuplicateToolLoopGuardMessage(toolCall),
          });
          continue;
        }

        // 第二层 loop guard：显式 reread budget。
        //
        // 旧版本的问题是：
        // - “完整读取过一次同一路径”之后，任何新的 view 都被硬拦
        // - 这样虽然能止血，但会误伤合理的二次精读
        //
        // 现在的策略改成：
        // - 第一次完整读取允许
        // - 完整读取之后，允许 1 次普通 focused reread
        // - 如果 grep 之后发现了新的锚点行号，再额外允许 1 次 anchor reread
        // - reread 必须带新的范围，并且当前 phase 仍是 explain
        // - 进入 modify/finalize 后，不再允许回头 reread
        // - 普通 reread 和 anchor reread 的预算都用尽后，再继续读取才拦截
        //
        // 这层更像“tool-use control loop”而不是简单去重。
        if (toolCall.name === "view" && toolPath && viewBudget) {
          if (viewBudget.hasFullRead) {
            let budgetViolationReason: string | undefined;

            if (!explicitViewRangeKey) {
              budgetViolationReason =
                "当前文件已经完整读取过一次。full reread 不再允许；如果证据已经足够，请直接 edit/write 或总结。";
            } else if (anchorFocusedReread) {
              if (viewBudget.seenAnchorRanges.has(explicitViewRangeKey)) {
                budgetViolationReason =
                  "当前 anchor reread 没有带来新的锚点范围信息；重复精读同一锚点片段不会增加信息增益。";
              } else if (viewBudget.anchorRereads >= 1) {
                budgetViolationReason =
                  "当前文件已经用掉 1 次 anchor reread 预算。请基于已有锚点上下文直接 edit/write。";
              }
            } else if (viewBudget.focusedRereads >= 1) {
              budgetViolationReason =
                "当前文件已经用掉 1 次 focused reread 预算。第 3 次再读同一路径会被拦截。";
            } else if (viewBudget.seenFocusedRanges.has(explicitViewRangeKey)) {
              budgetViolationReason =
                "当前 focused reread 没有带来新的范围信息；重复精读同一片段不会增加信息增益。";
            } else if (executionPhase !== "explain") {
              budgetViolationReason =
                `当前 executor phase=${executionPhase}。focused reread 只允许发生在 explain phase，modify/finalize 阶段应直接推进 edit/write 或总结。`;
            }

            if (budgetViolationReason) {
              duplicateToolCalls += 1;
              await service.appendMessage({
                sessionId: state.sessionId,
                role: "system",
                content: createViewBudgetGuardMessage(toolCall, toolPath, budgetViolationReason),
              });
              continue;
            }
          }
        }

        if (toolCall.name === "edit" || toolCall.name === "write") {
          const modificationAnalysis = analyzeWriteLikeModification(toolCall);
          if (modificationAnalysis) {
            const modificationBudget = buildModificationBudget(
              runtimeState,
              state.userMessage,
              modificationAnalysis,
            );
            const budgetViolation = explainModificationBudgetViolation(
              modificationBudget,
              modificationAnalysis,
            );

            if (budgetViolation) {
              await service.appendMessage({
                sessionId: state.sessionId,
                role: "system",
                content: createModificationPolicyMessage(
                  [
                    "当前 edit 会在高风险共享路径上引入过宽改动，runtime 已在执行前拦截。",
                    budgetViolation,
                  ].join("\n"),
                ),
              });
              continue;
            }
          }
        }

        const result = await toolExecutor.execute({
          sessionId: state.sessionId,
          name: toolCall.name,
          input: prepareToolInput(workspace.path, toolCall),
          taskId: toolCall.taskId,
          approvalGranted:
            toolApprovalDecider?.({
              sessionId: state.sessionId,
              userMessage: state.userMessage,
              toolCall,
              runtimeState,
              executionPhase,
              round: round + 1,
            }) ?? false,
        });
        executedToolCalls += 1;
        executedThisRound += 1;
        if (result.ok) {
          lastSuccessfulToolCallKey = toolCallKey;
          if (toolCall.name === "edit" || toolCall.name === "write") {
            executedWriteLikeTool = true;
            if (toolPath) {
              modifiedPathsSinceLatestWrite.add(toolPath);
            }
            const modificationAnalysis = analyzeWriteLikeModification(toolCall);
            if (modificationAnalysis?.substantialCodeChange) {
              hasSubstantiveBehavioralEdit = true;
              if (modificationAnalysis.path) {
                superficialBehaviorPaths.delete(modificationAnalysis.path);
              }
            } else if ((modificationAnalysis?.documentationOnly || modificationAnalysis?.importOnly) && modificationAnalysis.path) {
              superficialBehaviorPaths.add(modificationAnalysis.path);
            }
            if (modificationAnalysis?.highRisk && modificationAnalysis.path) {
              highRiskModifiedPaths.add(modificationAnalysis.path);
            }
            verificationProgress = {
              attempted: false,
              latestAttemptFailed: false,
              strongestSuccessfulLevel: "none",
              hasTargetedBehavioralSuccess: false,
              hasAdjacentRegressionSuccess: false,
            };
          }

          if (toolCall.name === "grep") {
            recordAnchorLinesFromGrepOutput(viewReadBudgets, result.output);
          }

          if (toolCall.name === "bash") {
            const verificationAnalysis = analyzeVerificationCommand(readBashCommand(toolCall.input));
            if (verificationAnalysis) {
              const exitCode = readBashExitCode(result.output);
              if ((exitCode ?? 1) === 0) {
                verificationProgress = {
                  attempted: true,
                  latestAttemptFailed: false,
                  strongestSuccessfulLevel: pickStrongerVerificationLevel(
                    verificationProgress.strongestSuccessfulLevel,
                    verificationAnalysis.level,
                  ),
                  hasTargetedBehavioralSuccess:
                    verificationProgress.hasTargetedBehavioralSuccess
                    || (verificationAnalysis.level === "behavioral" && verificationAnalysis.targeted),
                  hasAdjacentRegressionSuccess:
                    verificationProgress.hasAdjacentRegressionSuccess
                    || (verificationAnalysis.level === "behavioral" && verificationAnalysis.adjacentRegression),
                };
              } else {
                verificationProgress = {
                  ...verificationProgress,
                  attempted: true,
                  latestAttemptFailed: true,
                };
              }
            }
          }

          if (toolCall.name === "view" && toolPath && viewBudget) {
            if (hasExplicitViewRange(toolCall) && explicitViewRangeKey) {
              if (viewBudget.hasFullRead) {
                if (anchorFocusedReread) {
                  viewBudget.seenAnchorRanges.add(explicitViewRangeKey);
                  viewBudget.anchorRereads += 1;
                } else {
                  viewBudget.seenFocusedRanges.add(explicitViewRangeKey);
                  viewBudget.focusedRereads += 1;
                }
              }
            } else {
              viewBudget.hasFullRead = true;
            }

            viewReadBudgets.set(toolPath, viewBudget);
          }
        }

        await service.appendMessage({
          sessionId: state.sessionId,
          role: "tool",
          content: summarizeToolResult(toolCall, result),
        });
      }

      runtimeState = (await refreshRuntimeState(service, state.sessionId)) ?? runtimeState;
      if (executedThisRound === 0) {
        continue;
      }
    }

    const summary =
      executedToolCalls > 0
        ? `已执行 ${executedToolCalls} 次工具调用，并把 executor 结果吸收到 runtime store${duplicateToolCalls > 0 ? `；拦截了 ${duplicateToolCalls} 次重复工具调用` : ""
        }`
        : `已把 executor 结果吸收到 runtime store${duplicateToolCalls > 0 ? `；拦截了 ${duplicateToolCalls} 次重复工具调用` : ""
        }`;
    await persistWorkflowCheckpoint(service, state.sessionId, "execute", runtimeState, summary);

    return {
      runtimeState,
      executionLog: logLine("execute", summary),
    };
  };

  const reviewNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    // reviewNode 负责把“这次执行到底算不算达成 goal”明确化。
    // 这一步不等于总结。它更像一次结构化判定：
    // - satisfied?
    // - 为什么 satisfied / 不 satisfied?
    // - 剩余风险是什么?
    // - 下一步建议是什么?
    //
    // 这也是为什么 goal-driven workflow 不能只停在 todo list：没有 review，就没有真正的闭环。
    if (!state.runtimeState) {
      return {
        executionLog: logLine("review", "当前 session 没有 active goal，跳过 review"),
      };
    }

    if (!hooks.reviewer) {
      return {
        executionLog: logLine("review", "未注入 reviewer hook，跳过 review"),
      };
    }

    const reviewDraft = await hooks.reviewer(state.runtimeState, {
      sessionId: state.sessionId,
      userMessage: state.userMessage,
    });
    if (!reviewDraft) {
      return {
        executionLog: logLine("review", "reviewer hook 返回空结果，跳过 review"),
      };
    }

    const latestReview = await service.reviewGoal({
      sessionId: state.sessionId,
      ...reviewDraft,
    });
    const runtimeState = await refreshRuntimeState(service, state.sessionId);
    const summary = latestReview.satisfied
      ? "review 判断当前 goal 已满足"
      : "review 判断当前 goal 仍有未关闭风险";
    await persistWorkflowCheckpoint(service, state.sessionId, "review", runtimeState, summary);

    return {
      runtimeState,
      latestReview,
      executionLog: logLine("review", summary),
    };
  };

  const summarizeNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    // summarizeNode 主要服务于“会话恢复”和“IDE 可见性”。
    // 它把当前 goal / task / 风险收束成 session summary，
    // 这样你下次回到这个 session 时，不需要从头翻完整消息历史。
    if (!state.runtimeState) {
      return {
        executionLog: logLine("summarize", "当前 session 没有 active goal，跳过 summarize"),
      };
    }

    const summaryInput =
      (hooks.summarizer
        ? await hooks.summarizer(state.runtimeState, {
          sessionId: state.sessionId,
          userMessage: state.userMessage,
        })
        : null) ?? createDefaultSummary(state.runtimeState);

    await service.updateSessionSummary({
      sessionId: state.sessionId,
      ...summaryInput,
    });

    const runtimeState = await refreshRuntimeState(service, state.sessionId);
    const summary = `已更新 session summary：${summaryInput.shortSummary}`;
    await persistWorkflowCheckpoint(service, state.sessionId, "summarize", runtimeState, summary);

    return {
      runtimeState,
      executionLog: logLine("summarize", summary),
    };
  };

  const closeNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    const summary = "当前最小 LangGraph 运行已到 continue-or-close 收尾节点";
    await persistWorkflowCheckpoint(service, state.sessionId, "continue-or-close", state.runtimeState, summary);
    return {
      executionLog: logLine("continue-or-close", summary),
    };
  };

  const graph = new StateGraph(AgentLangGraphAnnotation)
    .addNode("intake", intakeNode)
    .addNode("clarify", clarifyNode)
    .addNode("plan", planNode)
    .addNode("delegate", delegateNode)
    .addNode("execute", executeNode)
    .addNode("review", reviewNode)
    .addNode("summarize", summarizeNode)
    .addNode("continue-or-close", closeNode)
    // 这里是真正运行时会执行的固定主链。
    // 也就是说：
    // - graph.ts 里的 ALLOWED_TRANSITIONS 负责描述“允许的设计空间”
    // - 这里的 addEdge(...) 才是当前 LangGraph 真正会怎么跑
    //
    // 当前项目还没有把条件分支完全收成“由 ALLOWED_TRANSITIONS 动态驱动”，
    // 所以面试时应该明确说：状态机合同已经抽出来了，但当前 runtime 仍是一条固定主链。
    .addEdge(START, "intake")
    .addEdge("intake", "clarify")
    .addEdge("clarify", "plan")
    .addEdge("plan", "delegate")
    .addEdge("delegate", "execute")
    .addEdge("execute", "review")
    .addEdge("review", "summarize")
    .addEdge("summarize", "continue-or-close")
    .addEdge("continue-or-close", END)
    .compile({
      checkpointer,
      name: "agent-ide-runtime",
      description: "Goal-driven runtime graph wired to the repository application service layer.",
    });

  return new AgentLangGraphRuntime(graph);
}

// AgentLangGraphRuntime 是给应用层用的薄包装。
// 它故意不把 LangGraph 全部 API 都往上暴露，只保留：
// - invoke: 跑一轮图
// - getThreadState: 调试 thread 快照
// - getCompiledGraph: 测试/调试时拿到底层 graph
//
// 这样上层依赖的是“项目自己的 runtime API”，而不是直接贴着框架细节写。
export class AgentLangGraphRuntime {
  constructor(private readonly graph: AgentLangGraphCompiled) { }

  async invoke(input: LangGraphInvokeInput): Promise<AgentLangGraphState> {
    // 这里最关键的设计是：
    // thread_id === sessionId
    //
    // 这样 session 恢复语义和 LangGraph thread 恢复语义就统一了，
    // 后续 durable execution / getState / checkpoint 查询都会更直观。
    return (await this.graph.invoke(
      {
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        runtimeState: null,
      },
      {
        configurable: {
          thread_id: input.sessionId,
        },
      },
    )) as AgentLangGraphState;
  }

  async getThreadState(sessionId: string): Promise<StateSnapshot> {
    // getState(...) 拿到的是 LangGraph 自己的 thread 快照。
    // 它适合调试“图跑到了哪、Annotation values 是什么”，
    // 但不应该代替 RuntimeStore 去查询完整业务实体。
    return this.graph.getState({
      configurable: {
        thread_id: sessionId,
      },
    });
  }

  getCompiledGraph(): AgentLangGraphCompiled {
    return this.graph;
  }
}
