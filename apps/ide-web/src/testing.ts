import type {
  Goal,
  MemoryRecord,
  Plan,
  Session,
  SessionSummary,
  SubagentRun,
  Task,
  Workspace,
} from "@agent-ide/core";
import type {
  PersistedCheckpoint,
  RuntimeStore,
  ToolInvocationLog,
} from "@agent-ide/runtime";
import { GoalDrivenRuntimeService } from "@agent-ide/runtime";

export class InMemoryIdeRuntimeStore implements RuntimeStore {
  readonly workspacesMap = new Map<string, Workspace>();
  readonly sessionsMap = new Map<string, Session>();
  readonly goalsMap = new Map<string, Goal>();
  readonly plansMap = new Map<string, Plan>();
  readonly tasksMap = new Map<string, Task>();
  readonly subagentRunsMap = new Map<string, SubagentRun>();
  readonly checkpointsMap = new Map<string, PersistedCheckpoint>();
  readonly toolInvocationsMap = new Map<string, ToolInvocationLog>();
  readonly messagesMap = new Map<
    string,
    Array<{ id: string; role: "user" | "assistant" | "system" | "tool"; content: string; createdAt: string }>
  >();

  readonly workspaces = {
    upsert: async (workspace: Workspace) => {
      this.workspacesMap.set(workspace.id, workspace);
    },
    getById: async (id: string) => this.workspacesMap.get(id) ?? null,
    getByPath: async (workspacePath: string) =>
      Array.from(this.workspacesMap.values()).find((workspace) => workspace.path === workspacePath) ?? null,
  };

  readonly sessions = {
    create: async (session: Session) => {
      this.sessionsMap.set(session.id, session);
    },
    getById: async (id: string) => this.sessionsMap.get(id) ?? null,
    listByWorkspace: async (workspaceId: string) =>
      Array.from(this.sessionsMap.values()).filter((session) => session.workspaceId === workspaceId),
    listByParentSession: async (parentSessionId: string) =>
      Array.from(this.sessionsMap.values()).filter((session) => session.parentSessionId === parentSessionId),
    rename: async () => undefined,
    archive: async () => undefined,
    updateSummary: async (sessionId: string, summary: SessionSummary, updatedAt: string) => {
      const session = this.sessionsMap.get(sessionId);
      if (!session) {
        return;
      }

      this.sessionsMap.set(sessionId, {
        ...session,
        summary,
        updatedAt,
      });
    },
    setActiveGoal: async (sessionId: string, goalId: string | null, updatedAt: string) => {
      const session = this.sessionsMap.get(sessionId);
      if (!session) {
        return;
      }

      this.sessionsMap.set(sessionId, {
        ...session,
        activeGoalId: goalId ?? undefined,
        updatedAt,
      });
    },
  };

  readonly goals = {
    create: async (goal: Goal) => {
      this.goalsMap.set(goal.id, goal);
    },
    getById: async (id: string) => this.goalsMap.get(id) ?? null,
    listBySession: async (_sessionId: string) => [],
    updateStatus: async () => undefined,
  };

  readonly plans = {
    save: async (plan: Plan) => {
      this.plansMap.set(plan.id, plan);
    },
    getLatestByGoal: async (goalId: string) =>
      Array.from(this.plansMap.values())
        .filter((plan) => plan.goalId === goalId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null,
  };

  readonly tasks = {
    getById: async (id: string) => this.tasksMap.get(id) ?? null,
    upsertMany: async (tasks: Task[]) => {
      for (const task of tasks) {
        this.tasksMap.set(task.id, task);
      }
    },
    listBySession: async (sessionId: string) =>
      Array.from(this.tasksMap.values()).filter((task) => task.sessionId === sessionId),
  };

  readonly memory = {
    create: async (_record: MemoryRecord) => undefined,
    listByScope: async (_workspaceId: string, _scope: MemoryRecord["scope"], _sessionId?: string) => [],
  };

  readonly messages = {
    append: async (
      sessionId: string,
      message: { id: string; role: "user" | "assistant" | "system" | "tool"; content: string; createdAt: string },
    ) => {
      const current = this.messagesMap.get(sessionId) ?? [];
      current.push(message);
      this.messagesMap.set(sessionId, current);
    },
    listBySession: async (sessionId: string) => this.messagesMap.get(sessionId) ?? [],
  };

  readonly checkpoints = {
    create: async (checkpoint: PersistedCheckpoint) => {
      this.checkpointsMap.set(checkpoint.id, checkpoint);
    },
    listBySession: async (sessionId: string) =>
      Array.from(this.checkpointsMap.values()).filter((checkpoint) => checkpoint.sessionId === sessionId),
  };

  readonly subagentRuns = {
    create: async (run: SubagentRun) => {
      this.subagentRunsMap.set(run.id, run);
    },
    getById: async (id: string) => this.subagentRunsMap.get(id) ?? null,
    complete: async () => undefined,
    listByParentSession: async (parentSessionId: string) =>
      Array.from(this.subagentRunsMap.values()).filter((run) => run.parentSessionId === parentSessionId),
  };

  readonly toolInvocations = {
    start: async (log: ToolInvocationLog) => {
      this.toolInvocationsMap.set(log.id, log);
    },
    finish: async (id: string, status: ToolInvocationLog["status"], outputJson: string | undefined, updatedAt: string) => {
      const existing = this.toolInvocationsMap.get(id);
      if (!existing) {
        return;
      }

      this.toolInvocationsMap.set(id, {
        ...existing,
        status,
        outputJson,
        updatedAt,
      });
    },
    listBySession: async (sessionId: string) =>
      Array.from(this.toolInvocationsMap.values()).filter((log) => log.sessionId === sessionId),
  };
}

// 这份夹具模拟的是“父 session 委托给 child session，再把结果回收到 replay / delegation 面板”。
// shell、browser、server 这几层测试都围绕它展开，避免每个测试文件各自维护一套不同样本。
export async function seedIdeShellService(): Promise<GoalDrivenRuntimeService> {
  const now = "2026-03-21T10:00:00.000Z";
  const store = new InMemoryIdeRuntimeStore();
  const workspace: Workspace = {
    id: "workspace_1",
    path: "/tmp/project",
    label: "project",
    createdAt: now,
    updatedAt: now,
  };
  const parentSession: Session = {
    id: "session_parent",
    workspaceId: workspace.id,
    title: "main build session",
    status: "active",
    activeAgentMode: "build",
    activeGoalId: "goal_parent",
    summary: { shortSummary: "", openLoops: [], nextActions: [], importantFacts: [] },
    createdAt: now,
    updatedAt: now,
  };
  const childSession: Session = {
    id: "session_child",
    workspaceId: workspace.id,
    parentSessionId: parentSession.id,
    title: "explore child",
    status: "active",
    activeAgentMode: "explore",
    activeGoalId: "goal_child",
    summary: { shortSummary: "", openLoops: [], nextActions: [], importantFacts: [] },
    createdAt: now,
    updatedAt: now,
  };
  const parentGoal: Goal = {
    id: "goal_parent",
    workspaceId: workspace.id,
    sessionId: parentSession.id,
    title: "修复 delegation",
    description: "让 delegation 更稳定",
    successCriteria: ["能查看 replay"],
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const childGoal: Goal = {
    id: "goal_child",
    workspaceId: workspace.id,
    sessionId: childSession.id,
    title: "探索风险",
    description: "找出风险点",
    successCriteria: ["总结风险点"],
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const parentTask: Task = {
    id: "task_parent",
    goalId: parentGoal.id,
    sessionId: parentSession.id,
    ownerAgent: "build",
    title: "追踪 delegation",
    status: "in_progress",
    inputSummary: "trace replay",
    outputSummary: "等待 child",
    createdAt: now,
    updatedAt: now,
  };
  const childTask: Task = {
    id: "task_child",
    goalId: childGoal.id,
    sessionId: childSession.id,
    ownerAgent: "explore",
    title: "读 controller",
    status: "done",
    inputSummary: "grep TODO",
    outputSummary: "发现 2 个风险点",
    createdAt: now,
    updatedAt: now,
  };
  const run: SubagentRun = {
    id: "subagent_run_1",
    parentSessionId: parentSession.id,
    childSessionId: childSession.id,
    parentTaskId: parentTask.id,
    agentMode: "explore",
    status: "completed",
    reason: "读代码找风险",
    inputSummary: "只读分析",
    resultSummary: "找到 2 个风险点",
    createdAt: now,
    updatedAt: now,
  };

  const parentPlan: Plan = {
    id: "plan_parent",
    goalId: parentGoal.id,
    sessionId: parentSession.id,
    status: "in_progress",
    summary: "先追踪 parent task，再检查 replay 和工具调用。",
    steps: [
      {
        id: "plan_step_1",
        title: "检查 parent task",
        description: "确认当前 delegation 的父任务状态。",
        status: "done",
      },
      {
        id: "plan_step_2",
        title: "查看 replay",
        description: "进入 child session replay，确认执行轨迹。",
        status: "in_progress",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  store.workspacesMap.set(workspace.id, workspace);
  store.sessionsMap.set(parentSession.id, parentSession);
  store.sessionsMap.set(childSession.id, childSession);
  store.goalsMap.set(parentGoal.id, parentGoal);
  store.goalsMap.set(childGoal.id, childGoal);
  store.plansMap.set(parentPlan.id, parentPlan);
  store.tasksMap.set(parentTask.id, parentTask);
  store.tasksMap.set(childTask.id, childTask);
  store.subagentRunsMap.set(run.id, run);

  const service = new GoalDrivenRuntimeService(store, {
    now: () => now,
    createId: (prefix: string) => `${prefix}_fixed`,
  });

  await service.appendMessage({
    sessionId: parentSession.id,
    role: "user",
    content: "帮我追踪 delegation 的执行情况",
  });
  await service.appendMessage({
    sessionId: parentSession.id,
    role: "assistant",
    content: "我会先查看 parent task、subagent replay 和工具调用，再给出结果。",
  });
  await service.appendMessage({
    sessionId: childSession.id,
    role: "assistant",
    content: "已经总结出两个风险点",
  });
  await service.createCheckpoint({
    sessionId: childSession.id,
    node: "execute",
    stateJson: JSON.stringify({ phase: "execute" }),
    summary: "执行阶段完成",
  });
  await store.toolInvocations.start({
    id: "tool_parent",
    sessionId: parentSession.id,
    taskId: parentTask.id,
    toolName: "bash",
    inputJson: JSON.stringify({ command: "git status" }),
    status: "started",
    createdAt: now,
    updatedAt: now,
  });
  await store.toolInvocations.finish(
    "tool_parent",
    "completed",
    JSON.stringify({ stdout: "ok" }),
    now,
  );
  await store.toolInvocations.start({
    id: "tool_child",
    sessionId: childSession.id,
    taskId: childTask.id,
    subagentRunId: run.id,
    toolName: "grep",
    inputJson: JSON.stringify({ query: "TODO" }),
    status: "started",
    createdAt: now,
    updatedAt: now,
  });
  await store.toolInvocations.finish(
    "tool_child",
    "completed",
    JSON.stringify({ matches: 2 }),
    now,
  );

  return service;
}
