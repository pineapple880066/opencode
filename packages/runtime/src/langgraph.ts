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
  assistantMessage?: string;
  tasks?: SyncTasksInput["tasks"];
  memory?: Array<Omit<RecordMemoryInput, "sessionId" | "workspaceId">>;
  toolCalls?: LangGraphToolCall[];
}

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
    let lastSuccessfulToolCallKey: string | undefined;
    const maxToolRounds = 4;
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

      // 有 toolCalls 的轮次属于内部工具循环，中间态不直接当成用户可见 assistant 消息。
      if (execution.assistantMessage && toolCalls.length === 0) {
        await service.appendMessage({
          sessionId: state.sessionId,
          role: "assistant",
          content: execution.assistantMessage,
        });
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
        if (toolCallKey === lastSuccessfulToolCallKey) {
          duplicateToolCalls += 1;
          await service.appendMessage({
            sessionId: state.sessionId,
            role: "system",
            content: createDuplicateToolLoopGuardMessage(toolCall),
          });
          continue;
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
