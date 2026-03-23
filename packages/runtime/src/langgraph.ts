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

export type LangGraphExecutionPhase = "explain" | "modify" | "finalize";

export interface LangGraphToolCall {
  name: Extract<ToolName, "list" | "view" | "grep" | "write" | "edit">;
  input: Record<string, unknown>;
  taskId?: string;
  reasoning?: string;
}

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
}

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

function logLine(node: WorkflowNode, message: string): string[] {
  return [`${node}: ${message}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

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

  const lineRange = toolCall.input.lineRange ?? toolCall.input.line_range;
  return typeof lineRange === "string" && lineRange.trim().length > 0;
}

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
  seenFocusedRanges: Set<string>;
}

function createViewReadBudgetState(): ViewReadBudgetState {
  return {
    hasFullRead: false,
    focusedRereads: 0,
    seenFocusedRanges: new Set<string>(),
  };
}

function inferExecutionPhase(execution: LangGraphExecuteResult): LangGraphExecutionPhase {
  if (execution.executionPhase) {
    return execution.executionPhase;
  }

  const toolNames = new Set((execution.toolCalls ?? []).map((toolCall) => toolCall.name));
  if (toolNames.has("edit") || toolNames.has("write")) {
    return "modify";
  }
  if (toolNames.has("view") || toolNames.has("grep") || toolNames.has("list")) {
    return "explain";
  }

  return "finalize";
}

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

function looksLikeModificationRequest(userMessage: string | undefined): boolean {
  if (!userMessage) {
    return false;
  }

  return /(修改|编辑|改动|加注释|注释|写入|替换|重构|补上|comment|edit|write|patch|modify|change|update)/i.test(
    userMessage,
  );
}

function hasPendingModificationWork(state: AgentGraphState): boolean {
  const taskSuggestsModify = state.tasks.some(
    (task) =>
      (task.status === "todo" || task.status === "in_progress" || task.status === "blocked")
      && /(修改|编辑|加注释|写|替换|补|edit|write|comment|modify|update)/i.test(
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
        && /(修改|编辑|加注释|写|替换|补|edit|write|comment|modify|update)/i.test(
          `${step.title} ${step.description} ${step.evidence ?? ""}`,
        ),
    ),
  );
}

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

async function refreshRuntimeState(
  service: GoalDrivenRuntimeService,
  sessionId: string,
): Promise<AgentGraphState | null> {
  return service.buildGraphState(sessionId);
}

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
export function createAgentLangGraph(
  service: GoalDrivenRuntimeService,
  options: LangGraphRuntimeOptions,
): AgentLangGraphRuntime {
  const hooks = options.hooks ?? {};
  const checkpointer = options.checkpointer;
  const toolExecutor = options.toolExecutor;

  const intakeNode = async (state: AgentLangGraphState): Promise<AgentLangGraphUpdate> => {
    // intake 是 graph 的入口。
    // 它负责把外部输入先稳定落到系统里：
    // - 用户消息先入 message ledger
    // - 如果当前 session 还没有 active goal，再尝试调用 goalFactory 生成第一个 goal
    //
    // 所以后面 plan/execute 能否运行，前提通常都在这里建立。
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
    let lastSuccessfulToolCallKey: string | undefined;
    const viewReadBudgets = new Map<string, ViewReadBudgetState>();
    const maxToolRounds = 5;
    const maxToolCallsPerRound = 4;

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
      const shouldForceModifyContinuation =
        toolCalls.length === 0
        && executionPhase === "explain"
        && executedToolCalls > 0
        && !executedWriteLikeTool
        && looksLikeModificationRequest(state.userMessage)
        && hasPendingModificationWork(runtimeState)
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

      if (shouldForceModifyContinuation) {
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "system",
          content: [
            "EXECUTION_POLICY: 用户请求同时包含解释和修改。",
            "当前 explain phase 已经产出了说明，但文件还没有真实改动。",
            "下一轮必须切到 modify phase，直接发起 edit/write，不能在 explain phase 收尾。",
          ].join("\n"),
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
        // - 完整读取之后，允许 1 次 focused reread
        // - focused reread 必须带新的范围，并且当前 phase 仍是 explain
        // - 进入 modify/finalize 后，不再允许回头 reread
        // - 第 3 次读取同一路径时再拦截
        //
        // 这层更像“tool-use control loop”而不是简单去重。
        if (toolCall.name === "view" && toolPath && viewBudget) {
          if (viewBudget.hasFullRead) {
            let budgetViolationReason: string | undefined;

            if (!explicitViewRangeKey) {
              budgetViolationReason =
                "当前文件已经完整读取过一次。full reread 不再允许；如果证据已经足够，请直接 edit/write 或总结。";
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

        const result = await toolExecutor.execute({
          sessionId: state.sessionId,
          name: toolCall.name,
          input: prepareToolInput(workspace.path, toolCall),
          taskId: toolCall.taskId,
        });
        executedToolCalls += 1;
        executedThisRound += 1;
        if (result.ok) {
          lastSuccessfulToolCallKey = toolCallKey;
          if (toolCall.name === "edit" || toolCall.name === "write") {
            executedWriteLikeTool = true;
          }

          if (toolCall.name === "view" && toolPath && viewBudget) {
            if (hasExplicitViewRange(toolCall) && explicitViewRangeKey) {
              viewBudget.seenFocusedRanges.add(explicitViewRangeKey);
              if (viewBudget.hasFullRead) {
                viewBudget.focusedRereads += 1;
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
        ? `已执行 ${executedToolCalls} 次工具调用，并把 executor 结果吸收到 runtime store${
            duplicateToolCalls > 0 ? `；拦截了 ${duplicateToolCalls} 次重复工具调用` : ""
          }`
        : `已把 executor 结果吸收到 runtime store${
            duplicateToolCalls > 0 ? `；拦截了 ${duplicateToolCalls} 次重复工具调用` : ""
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

export class AgentLangGraphRuntime {
  constructor(private readonly graph: AgentLangGraphCompiled) {}

  async invoke(input: LangGraphInvokeInput): Promise<AgentLangGraphState> {
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
