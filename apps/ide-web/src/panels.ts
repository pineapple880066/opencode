import type {
  GoalDrivenRuntimeService,
  ParentTaskExecutionTrace,
  SubagentRunReplay,
  ToolInvocationLog,
} from "@agent-ide/runtime";

export interface ReplayTimelineItem {
  kind: "message" | "checkpoint" | "tool";
  timestamp: string;
  title: string;
  detail: string;
  status?: string;
}

export interface ToolInvocationGroupState {
  taskId?: string;
  taskTitle: string;
  toolInvocations: Array<{
    id: string;
    toolName: string;
    status: ToolInvocationLog["status"];
    createdAt: string;
    outputPreview?: string;
  }>;
}

export interface SubagentReplayPanelState {
  panel: "subagent-replay";
  runId: string;
  parentSessionTitle: string;
  childSessionTitle: string;
  parentTaskTitle?: string;
  agentMode: string;
  status: string;
  resultSummary?: string;
  childSessionStatus: string;
  messageCount: number;
  checkpointCount: number;
  toolInvocationCount: number;
  taskCount: number;
  taskToolGroups: ToolInvocationGroupState[];
  timeline: ReplayTimelineItem[];
}

export interface ParentTaskDelegationPanelState {
  panel: "parent-task-delegation";
  parentTaskId: string;
  parentTaskTitle: string;
  parentSessionTitle: string;
  directToolInvocations: Array<{
    id: string;
    toolName: string;
    status: ToolInvocationLog["status"];
    createdAt: string;
  }>;
  delegatedRuns: Array<{
    runId: string;
    childSessionId: string;
    childSessionTitle: string;
    agentMode: string;
    status: string;
    resultSummary?: string;
    toolInvocationCount: number;
    taskCount: number;
  }>;
}

function safePreview(outputJson: string | undefined): string | undefined {
  if (!outputJson) {
    return undefined;
  }

  return outputJson.length <= 120 ? outputJson : `${outputJson.slice(0, 117)}...`;
}

function buildToolInvocationGroups(replay: SubagentRunReplay): ToolInvocationGroupState[] {
  const groups = new Map<string, ToolInvocationGroupState>();

  for (const task of replay.childTasks) {
    groups.set(task.id, {
      taskId: task.id,
      taskTitle: task.title,
      toolInvocations: [],
    });
  }

  for (const log of replay.childToolInvocations) {
    const groupKey = log.taskId ?? "unscoped";
    const existing = groups.get(groupKey) ?? {
      taskId: log.taskId,
      taskTitle: log.taskId ? `未同步的 task ${log.taskId}` : "未绑定 task 的工具调用",
      toolInvocations: [],
    };

    existing.toolInvocations.push({
      id: log.id,
      toolName: log.toolName,
      status: log.status,
      createdAt: log.createdAt,
      outputPreview: safePreview(log.outputJson),
    });
    groups.set(groupKey, existing);
  }

  return Array.from(groups.values())
    .filter((group) => group.toolInvocations.length > 0)
    .sort((left, right) => left.taskTitle.localeCompare(right.taskTitle));
}

function buildReplayTimeline(replay: SubagentRunReplay): ReplayTimelineItem[] {
  const messageItems: ReplayTimelineItem[] = replay.childMessages.map((message) => ({
    kind: "message",
    timestamp: message.createdAt,
    title: `${message.role} message`,
    detail: message.content,
  }));
  const checkpointItems: ReplayTimelineItem[] = replay.childCheckpoints.map((checkpoint) => ({
    kind: "checkpoint",
    timestamp: checkpoint.createdAt,
    title: `checkpoint @ ${checkpoint.node}`,
    detail: checkpoint.summary,
  }));
  const toolItems: ReplayTimelineItem[] = replay.childToolInvocations.map((log) => ({
    kind: "tool",
    timestamp: log.createdAt,
    title: `tool: ${log.toolName}`,
    detail: safePreview(log.outputJson) ?? log.inputJson,
    status: log.status,
  }));

  return [...messageItems, ...checkpointItems, ...toolItems].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

// 面试点：panel builder 不直接读数据库，而是消费 runtime service 的聚合结果。
// 这样 UI 只负责展示，不负责重新发明业务拼装逻辑。
export async function buildSubagentReplayPanelState(
  service: GoalDrivenRuntimeService,
  runId: string,
): Promise<SubagentReplayPanelState> {
  const replay = await service.getSubagentRunReplay(runId);

  return {
    panel: "subagent-replay",
    runId: replay.run.id,
    parentSessionTitle: replay.parentSession.title,
    childSessionTitle: replay.childSession.title,
    parentTaskTitle: replay.parentTask?.title,
    agentMode: replay.run.agentMode,
    status: replay.run.status,
    resultSummary: replay.run.resultSummary,
    childSessionStatus: replay.childSession.status,
    messageCount: replay.childMessages.length,
    checkpointCount: replay.childCheckpoints.length,
    toolInvocationCount: replay.childToolInvocations.length,
    taskCount: replay.childTasks.length,
    taskToolGroups: buildToolInvocationGroups(replay),
    timeline: buildReplayTimeline(replay),
  };
}

export async function buildParentTaskDelegationPanelState(
  service: GoalDrivenRuntimeService,
  parentTaskId: string,
): Promise<ParentTaskDelegationPanelState> {
  const trace: ParentTaskExecutionTrace = await service.getParentTaskExecutionTrace(parentTaskId);

  return {
    panel: "parent-task-delegation",
    parentTaskId: trace.parentTask.id,
    parentTaskTitle: trace.parentTask.title,
    parentSessionTitle: trace.parentSession.title,
    directToolInvocations: trace.directToolInvocations.map((log) => ({
      id: log.id,
      toolName: log.toolName,
      status: log.status,
      createdAt: log.createdAt,
    })),
    delegatedRuns: trace.delegatedReplays.map((replay) => ({
      runId: replay.run.id,
      childSessionId: replay.childSession.id,
      childSessionTitle: replay.childSession.title,
      agentMode: replay.run.agentMode,
      status: replay.run.status,
      resultSummary: replay.run.resultSummary,
      toolInvocationCount: replay.childToolInvocations.length,
      taskCount: replay.childTasks.length,
    })),
  };
}
