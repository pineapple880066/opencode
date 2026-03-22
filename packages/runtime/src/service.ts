import { randomUUID } from "node:crypto";

import {
  DEFAULT_TOOL_POLICIES,
  type AgentMode,
  type Goal,
  type MemoryRecord,
  type Plan,
  type PlanStep,
  type ReviewReport,
  type Session,
  type SessionSummary,
  type SubagentRun,
  type Task,
  type Workspace,
} from "@agent-ide/core";

import type { AgentGraphState, GraphMessage, GraphToolInvocation, WorkflowNode } from "./graph.js";
import type { PersistedCheckpoint, RuntimeStore, ToolInvocationLog } from "./store.js";

export interface RuntimeServiceOptions {
  now: () => string;
  createId: (prefix: string) => string;
}

export interface EnsureWorkspaceInput {
  path: string;
  label?: string;
}

export interface CreateSessionInput {
  workspacePath: string;
  workspaceLabel?: string;
  title: string;
  agentMode?: AgentMode;
  parentSessionId?: string;
}

export interface RenameSessionInput {
  sessionId: string;
  title: string;
}

export interface ArchiveSessionInput {
  sessionId: string;
}

export interface CreateChildSessionInput {
  parentSessionId: string;
  title?: string;
  agentMode: AgentMode;
  initialSummary?: string;
  inheritActiveGoal?: boolean;
  delegationReason?: string;
}

export interface CreateGoalInput {
  sessionId: string;
  title: string;
  description: string;
  successCriteria: string[];
}

export interface SavePlanInput {
  sessionId: string;
  goalId?: string;
  summary: string;
  status?: Plan["status"];
  steps: Array<{
    id?: string;
    title: string;
    description: string;
    status?: PlanStep["status"];
    evidence?: string;
  }>;
}

export interface SyncTasksInput {
  sessionId: string;
  goalId?: string;
  planId?: string;
  tasks: Array<{
    id?: string;
    ownerAgent?: AgentMode;
    title: string;
    status?: Task["status"];
    inputSummary: string;
    outputSummary?: string;
  }>;
}

export interface RecordMemoryInput {
  workspaceId?: string;
  sessionId?: string;
  scope: MemoryRecord["scope"];
  key: string;
  value: string;
  source: MemoryRecord["source"];
  confidence?: number;
}

export interface ReviewGoalInput {
  sessionId: string;
  satisfied: boolean;
  reasons: string[];
  remainingRisks?: string[];
  recommendedNextStep?: string;
}

export interface UpdateSessionSummaryInput {
  sessionId: string;
  shortSummary: string;
  openLoops?: string[];
  nextActions?: string[];
  importantFacts?: string[];
}

export interface AppendMessageInput {
  sessionId: string;
  role: GraphMessage["role"];
  content: string;
}

export interface CreateCheckpointInput {
  sessionId: string;
  node: WorkflowNode;
  stateJson: string;
  summary: string;
}

export interface StartSubagentRunInput {
  parentSessionId: string;
  childSessionId: string;
  parentTaskId?: string;
  agentMode: AgentMode;
  reason: string;
  inputSummary: string;
}

export interface CompleteSubagentRunInput {
  id: string;
  status?: SubagentRun["status"];
  resultSummary?: string;
  appendParentMessage?: boolean;
  archiveChildSession?: boolean;
  updateChildSummary?: boolean;
  cleanupPolicy?: SubagentCleanupPolicy | false;
}

export interface DelegateToSubagentInput {
  parentSessionId: string;
  parentTaskId?: string;
  agentMode: AgentMode;
  title?: string;
  reason: string;
  inputSummary: string;
  inheritActiveGoal?: boolean;
}

export interface DelegateToSubagentResult {
  childSession: Session;
  childGoal?: Goal;
  run: SubagentRun;
}

export interface SubagentRunReplay {
  run: SubagentRun;
  parentSession: Session;
  childSession: Session;
  parentTask?: Task;
  childGoal?: Goal;
  childTasks: Task[];
  childMessages: GraphMessage[];
  childCheckpoints: PersistedCheckpoint[];
  childToolInvocations: ToolInvocationLog[];
}

export interface CleanupChildSessionsInput {
  parentSessionId: string;
  archiveStatuses?: Array<Extract<SubagentRun["status"], "completed" | "failed" | "canceled">>;
  includeAlreadyArchived?: boolean;
  policy?: SubagentCleanupPolicy;
}

export interface CleanupChildSessionsResult {
  parentSessionId: string;
  archivedChildSessionIds: string[];
  skipped: Array<{
    childSessionId: string;
    latestRunId?: string;
    latestRunStatus?: SubagentRun["status"];
    reason: string;
  }>;
}

export interface SubagentCleanupPolicy {
  archiveStatuses?: Array<Extract<SubagentRun["status"], "completed" | "failed" | "canceled">>;
  maxAgeMs?: number;
  retainMostRecentFinishedChildren?: number;
  requireResultSummary?: boolean;
}

export interface CompleteSubagentRunResult {
  run: SubagentRun;
  childSession: Session;
  cleanup?: CleanupChildSessionsResult;
}

export interface ParentTaskExecutionTrace {
  parentTask: Task;
  parentSession: Session;
  directToolInvocations: ToolInvocationLog[];
  delegatedReplays: SubagentRunReplay[];
}

function createDefaultSessionSummary(): SessionSummary {
  return {
    shortSummary: "",
    openLoops: [],
    nextActions: [],
    importantFacts: [],
  };
}

function createSessionSummaryWithBase(shortSummary = ""): SessionSummary {
  return {
    shortSummary,
    openLoops: [],
    nextActions: [],
    importantFacts: [],
  };
}

function createDefaultRuntimeOptions(): RuntimeServiceOptions {
  return {
    now: () => new Date().toISOString(),
    createId: (prefix: string) => `${prefix}_${randomUUID()}`,
  };
}

function mapRunStatusToTaskStatus(status: SubagentRun["status"]): Task["status"] {
  if (status === "completed") {
    return "done";
  }

  if (status === "failed") {
    return "blocked";
  }

  if (status === "canceled") {
    return "canceled";
  }

  return "in_progress";
}

function mapRunStatusToGoalStatus(status: SubagentRun["status"]): Goal["status"] {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed") {
    return "blocked";
  }

  if (status === "canceled") {
    return "abandoned";
  }

  return "active";
}

function pickLatestRun(runs: SubagentRun[]): SubagentRun | undefined {
  return [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function toTimestamp(value: string): number {
  return new Date(value).getTime();
}

export class RuntimeEntityNotFoundError extends Error {
  constructor(entityName: string, entityId: string) {
    super(`未找到 ${entityName}: ${entityId}`);
    this.name = "RuntimeEntityNotFoundError";
  }
}

// 面试点：这里故意没有把业务逻辑直接写进数据库层或 UI 层，
// 而是先形成一个 goal-driven 的应用服务层。这样后面接 LangGraph 时，
// graph 负责编排，这里负责稳定业务动作。
// GoalDrivenRuntimeService 是当前 runtime 的应用服务层。
// 它还不是最终的 LangGraph 执行器，但已经把核心业务动作组织起来了。
export class GoalDrivenRuntimeService {
  private readonly options: RuntimeServiceOptions;

  constructor(
    private readonly store: RuntimeStore,
    options?: Partial<RuntimeServiceOptions>,
  ) {
    this.options = {
      ...createDefaultRuntimeOptions(),
      ...options,
    };
  }

  async ensureWorkspace(input: EnsureWorkspaceInput): Promise<Workspace> {
    const existing = await this.store.workspaces.getByPath(input.path);
    if (existing) {
      return existing;
    }

    const now = this.options.now();
    const workspace: Workspace = {
      id: this.options.createId("workspace"),
      path: input.path,
      label: input.label ?? input.path.split("/").filter(Boolean).at(-1) ?? "workspace",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.workspaces.upsert(workspace);
    return workspace;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const workspace = await this.ensureWorkspace({
      path: input.workspacePath,
      label: input.workspaceLabel,
    });
    return this.createSessionRecord({
      workspaceId: workspace.id,
      title: input.title,
      agentMode: input.agentMode ?? "build",
      parentSessionId: input.parentSessionId,
      summary: createDefaultSessionSummary(),
    });
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.requireSession(sessionId);
  }

  async renameSession(input: RenameSessionInput): Promise<Session> {
    await this.requireSession(input.sessionId);
    const now = this.options.now();
    await this.store.sessions.rename(input.sessionId, input.title, now);
    return this.requireSession(input.sessionId);
  }

  async archiveSession(input: ArchiveSessionInput): Promise<Session> {
    await this.requireSession(input.sessionId);
    const now = this.options.now();
    await this.store.sessions.archive(input.sessionId, now);
    return this.requireSession(input.sessionId);
  }

  // 面试点：subagent 不是共享父上下文继续跑，而是创建 child session。
  // 这样上下文边界、lineage 和后续审计都会更清楚。
  async createChildSession(input: CreateChildSessionInput): Promise<{
    childSession: Session;
    childGoal?: Goal;
  }> {
    const parentSession = await this.requireSession(input.parentSessionId);
    const parentGoal = parentSession.activeGoalId
      ? await this.store.goals.getById(parentSession.activeGoalId)
      : null;

    const childSession = await this.createSessionRecord({
      workspaceId: parentSession.workspaceId,
      title: input.title ?? `${input.agentMode} child of ${parentSession.title}`,
      agentMode: input.agentMode,
      parentSessionId: parentSession.id,
      summary: createSessionSummaryWithBase(
        input.initialSummary ??
          `由父 session 委托创建，模式=${input.agentMode}${
            input.delegationReason ? `，原因=${input.delegationReason}` : ""
          }`,
      ),
    });

    if (!input.inheritActiveGoal || !parentGoal) {
      return { childSession };
    }

    const now = this.options.now();
    const childGoal: Goal = {
      id: this.options.createId("goal"),
      workspaceId: childSession.workspaceId,
      sessionId: childSession.id,
      title: `[${input.agentMode}] ${parentGoal.title}`,
      description: input.delegationReason
        ? `${parentGoal.description}\n\n子代理任务重点：${input.delegationReason}`
        : parentGoal.description,
      successCriteria: parentGoal.successCriteria,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.goals.create(childGoal);
    await this.store.sessions.setActiveGoal(childSession.id, childGoal.id, now);

    return {
      childSession,
      childGoal,
    };
  }

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    const session = await this.requireSession(input.sessionId);
    const now = this.options.now();

    const goal: Goal = {
      id: this.options.createId("goal"),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      title: input.title,
      description: input.description,
      successCriteria: input.successCriteria,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.goals.create(goal);
    await this.store.sessions.setActiveGoal(session.id, goal.id, now);
    return goal;
  }

  async savePlan(input: SavePlanInput): Promise<Plan> {
    const session = await this.requireSession(input.sessionId);
    const goalId = input.goalId ?? session.activeGoalId;

    if (!goalId) {
      throw new Error(`session ${session.id} 当前没有 active goal，无法保存 plan`);
    }

    const goal = await this.requireGoal(goalId);
    const now = this.options.now();
    const plan: Plan = {
      id: this.options.createId("plan"),
      goalId: goal.id,
      sessionId: session.id,
      status: input.status ?? "draft",
      summary: input.summary,
      steps: input.steps.map((step) => ({
        id: step.id ?? this.options.createId("plan_step"),
        title: step.title,
        description: step.description,
        status: step.status ?? "todo",
        evidence: step.evidence,
      })),
      createdAt: now,
      updatedAt: now,
    };

    await this.store.plans.save(plan);
    return plan;
  }

  async syncTasks(input: SyncTasksInput): Promise<Task[]> {
    const session = await this.requireSession(input.sessionId);
    const goalId = input.goalId ?? session.activeGoalId;

    if (!goalId) {
      throw new Error(`session ${session.id} 当前没有 active goal，无法写入 task`);
    }

    const now = this.options.now();
    const tasks = input.tasks.map<Task>((task) => ({
      id: task.id ?? this.options.createId("task"),
      goalId,
      planId: input.planId,
      sessionId: session.id,
      ownerAgent: task.ownerAgent ?? session.activeAgentMode,
      title: task.title,
      status: task.status ?? "todo",
      inputSummary: task.inputSummary,
      outputSummary: task.outputSummary,
      createdAt: now,
      updatedAt: now,
    }));

    await this.store.tasks.upsertMany(tasks);
    return tasks;
  }

  async recordMemory(input: RecordMemoryInput): Promise<MemoryRecord> {
    const session = input.sessionId ? await this.requireSession(input.sessionId) : null;
    const workspaceId = input.workspaceId ?? session?.workspaceId;

    if (!workspaceId) {
      throw new Error("recordMemory 需要 workspaceId 或 sessionId");
    }

    const now = this.options.now();
    const record: MemoryRecord = {
      id: this.options.createId("memory"),
      workspaceId,
      sessionId: input.sessionId,
      scope: input.scope,
      key: input.key,
      value: input.value,
      source: input.source,
      confidence: input.confidence ?? 0.8,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.memory.create(record);
    return record;
  }

  async updateSessionSummary(input: UpdateSessionSummaryInput): Promise<SessionSummary> {
    const session = await this.requireSession(input.sessionId);
    const now = this.options.now();
    const summary: SessionSummary = {
      shortSummary: input.shortSummary,
      openLoops: input.openLoops ?? session.summary.openLoops,
      nextActions: input.nextActions ?? session.summary.nextActions,
      importantFacts: input.importantFacts ?? session.summary.importantFacts,
    };

    await this.store.sessions.updateSummary(session.id, summary, now);
    return summary;
  }

  async appendMessage(input: AppendMessageInput): Promise<GraphMessage> {
    await this.requireSession(input.sessionId);
    const message: GraphMessage = {
      id: this.options.createId("message"),
      role: input.role,
      content: input.content,
      createdAt: this.options.now(),
    };

    await this.store.messages.append(input.sessionId, message);
    return message;
  }

  async createCheckpoint(input: CreateCheckpointInput): Promise<PersistedCheckpoint> {
    await this.requireSession(input.sessionId);
    const checkpoint: PersistedCheckpoint = {
      id: this.options.createId("checkpoint"),
      sessionId: input.sessionId,
      node: input.node,
      stateJson: input.stateJson,
      summary: input.summary,
      createdAt: this.options.now(),
    };

    await this.store.checkpoints.create(checkpoint);
    return checkpoint;
  }

  async startSubagentRun(input: StartSubagentRunInput): Promise<SubagentRun> {
    await this.requireSession(input.parentSessionId);
    await this.requireSession(input.childSessionId);
    const now = this.options.now();
    const run: SubagentRun = {
      id: this.options.createId("subagent_run"),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      parentTaskId: input.parentTaskId,
      agentMode: input.agentMode,
      status: "queued",
      reason: input.reason,
      inputSummary: input.inputSummary,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.subagentRuns.create(run);
    return run;
  }

  async delegateToSubagent(input: DelegateToSubagentInput): Promise<DelegateToSubagentResult> {
    const { childSession, childGoal } = await this.createChildSession({
      parentSessionId: input.parentSessionId,
      title: input.title,
      agentMode: input.agentMode,
      inheritActiveGoal: input.inheritActiveGoal ?? true,
      delegationReason: input.reason,
      initialSummary: `等待父 session 回收 delegation 结果：${input.reason}`,
    });

    const run = await this.startSubagentRun({
      parentSessionId: input.parentSessionId,
      childSessionId: childSession.id,
      parentTaskId: input.parentTaskId,
      agentMode: input.agentMode,
      reason: input.reason,
      inputSummary: input.inputSummary,
    });

    await this.appendMessage({
      sessionId: childSession.id,
      role: "system",
      content: `父 session 委托给 ${input.agentMode} 子代理。原因：${input.reason}\n任务摘要：${input.inputSummary}`,
    });

    if (input.parentTaskId) {
      const parentTask = await this.requireTask(input.parentTaskId);
      if (parentTask.sessionId !== input.parentSessionId) {
        throw new Error(`task ${parentTask.id} 不属于 parent session ${input.parentSessionId}`);
      }

      await this.store.tasks.upsertMany([
        {
          ...parentTask,
          status: "in_progress",
          outputSummary:
            parentTask.outputSummary ??
            `已委托给 ${input.agentMode} 子代理，child session=${childSession.id}，等待结果回流`,
          updatedAt: this.options.now(),
        },
      ]);
    }

    return {
      childSession,
      childGoal,
      run,
    };
  }

  async completeSubagentRun(input: CompleteSubagentRunInput): Promise<CompleteSubagentRunResult> {
    const run = await this.requireSubagentRun(input.id);
    const childSession = await this.requireSession(run.childSessionId);
    const now = this.options.now();
    const finalStatus = input.status ?? "completed";

    await this.store.subagentRuns.complete(input.id, finalStatus, input.resultSummary, now);

    if (input.updateChildSummary ?? true) {
      const shortSummary = input.resultSummary
        ? `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}：${input.resultSummary}`
        : `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}`;

      await this.store.sessions.updateSummary(
        childSession.id,
        {
          shortSummary,
          openLoops: childSession.summary.openLoops,
          nextActions: childSession.summary.nextActions,
          importantFacts: childSession.summary.importantFacts,
        },
        now,
      );
    }

    if (childSession.activeGoalId) {
      await this.store.goals.updateStatus(
        childSession.activeGoalId,
        finalStatus === "completed" ? "completed" : finalStatus === "failed" ? "blocked" : "active",
        now,
        finalStatus === "completed" ? now : undefined,
      );
    }

    if (run.parentTaskId) {
      const parentTask = await this.requireTask(run.parentTaskId);
      if (parentTask.sessionId !== run.parentSessionId) {
        throw new Error(`task ${parentTask.id} 不属于 parent session ${run.parentSessionId}`);
      }

      // 面试点：subagent orchestration 不应该只停留在 run 记录。
      // 真正有用的系统，还要把 child 结果回写到 parent task，形成主流程账本。
      await this.store.tasks.upsertMany([
        {
          ...parentTask,
          status: mapRunStatusToTaskStatus(finalStatus),
          outputSummary:
            input.resultSummary ??
            parentTask.outputSummary ??
            `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}`,
          updatedAt: now,
        },
      ]);
    }

    // 面试点：subagent 结束不能只改一条 run 状态，还要把结果吸收到父 session。
    // 这样父会话恢复时能看到 delegation outcome，而不是只能自己再去读 child history。
    if (input.appendParentMessage ?? true) {
      const messageLines = [
        `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}。`,
        `child session: ${run.childSessionId}`,
        `委托原因：${run.reason}`,
      ];

      if (input.resultSummary) {
        messageLines.push(`结果摘要：${input.resultSummary}`);
      }

      await this.appendMessage({
        sessionId: run.parentSessionId,
        role: "system",
        content: messageLines.join("\n"),
      });
    }

    if (input.archiveChildSession) {
      await this.store.sessions.archive(run.childSessionId, now);
    }

    const cleanup =
      input.cleanupPolicy === false || input.archiveChildSession
        ? undefined
        : input.cleanupPolicy
          ? await this.cleanupChildSessions({
              parentSessionId: run.parentSessionId,
              policy: input.cleanupPolicy,
            })
          : undefined;

    return {
      run: await this.requireSubagentRun(run.id),
      childSession: await this.requireSession(run.childSessionId),
      cleanup,
    };
  }

  async reviewGoal(input: ReviewGoalInput): Promise<ReviewReport> {
    const session = await this.requireSession(input.sessionId);
    const goalId = session.activeGoalId;

    if (!goalId) {
      throw new Error(`session ${session.id} 当前没有 active goal，无法执行 review`);
    }

    const goal = await this.requireGoal(goalId);
    const now = this.options.now();
    const report: ReviewReport = {
      goalId: goal.id,
      satisfied: input.satisfied,
      reasons: input.reasons,
      remainingRisks: input.remainingRisks ?? [],
      recommendedNextStep: input.recommendedNextStep,
    };

    await this.store.goals.updateStatus(
      goal.id,
      input.satisfied ? "completed" : report.remainingRisks.length > 0 ? "blocked" : "active",
      now,
      input.satisfied ? now : undefined,
    );

    return report;
  }

  async buildGraphState(sessionId: string): Promise<AgentGraphState | null> {
    const session = await this.requireSession(sessionId);
    if (!session.activeGoalId) {
      return null;
    }

    const activeGoal = await this.requireGoal(session.activeGoalId);
    const currentPlan = await this.store.plans.getLatestByGoal(activeGoal.id);
    const tasks = await this.store.tasks.listBySession(session.id);
    const [sessionMemory, workspaceMemory] = await Promise.all([
      this.store.memory.listByScope(session.workspaceId, "session", session.id),
      this.store.memory.listByScope(session.workspaceId, "workspace"),
    ]);
    const [messages, checkpoints, subagentRuns, toolInvocations] = await Promise.all([
      this.store.messages.listBySession(session.id),
      this.store.checkpoints.listBySession(session.id),
      this.store.subagentRuns.listByParentSession(session.id),
      this.store.toolInvocations.listBySession(session.id),
    ]);

    return {
      workspaceId: session.workspaceId,
      session,
      activeGoal,
      currentPlan: currentPlan ?? undefined,
      tasks,
      messages,
      toolInvocations: toolInvocations.map<GraphToolInvocation>((log) => ({
        id: log.id,
        sessionId: log.sessionId,
        taskId: log.taskId,
        subagentRunId: log.subagentRunId,
        toolName: log.toolName,
        status: log.status,
        inputJson: log.inputJson,
        outputJson: log.outputJson,
        createdAt: log.createdAt,
        updatedAt: log.updatedAt,
      })),
      memory: [...sessionMemory, ...workspaceMemory],
      activeAgent: session.activeAgentMode,
      activePolicy: DEFAULT_TOOL_POLICIES[session.activeAgentMode],
      subagentRuns,
      checkpoints,
    };
  }

  async listSessionsByWorkspacePath(workspacePath: string): Promise<Session[]> {
    const workspace = await this.store.workspaces.getByPath(workspacePath);
    if (!workspace) {
      return [];
    }

    return this.store.sessions.listByWorkspace(workspace.id);
  }

  async listChildSessions(parentSessionId: string): Promise<Session[]> {
    await this.requireSession(parentSessionId);
    return this.store.sessions.listByParentSession(parentSessionId);
  }

  async listMessages(sessionId: string): Promise<GraphMessage[]> {
    await this.requireSession(sessionId);
    return this.store.messages.listBySession(sessionId);
  }

  async listCheckpoints(sessionId: string): Promise<PersistedCheckpoint[]> {
    await this.requireSession(sessionId);
    return this.store.checkpoints.listBySession(sessionId);
  }

  async listToolInvocations(sessionId: string): Promise<ToolInvocationLog[]> {
    await this.requireSession(sessionId);
    return this.store.toolInvocations.listBySession(sessionId);
  }

  async listSubagentRuns(parentSessionId: string): Promise<SubagentRun[]> {
    await this.requireSession(parentSessionId);
    return this.store.subagentRuns.listByParentSession(parentSessionId);
  }

  async getWorkspaceForSession(sessionId: string): Promise<Workspace> {
    const session = await this.requireSession(sessionId);
    const workspace = await this.store.workspaces.getById(session.workspaceId);
    if (!workspace) {
      throw new RuntimeEntityNotFoundError("workspace", session.workspaceId);
    }

    return workspace;
  }

  // 面试点：subagent 不只是“跑完了就算”。
  // 这里把 child session 里的消息、checkpoint、工具调用、任务一起聚合出来，
  // 让后续的 UI / API 能真正回放一次 delegation 的执行痕迹。
  async getSubagentRunReplay(runId: string): Promise<SubagentRunReplay> {
    const run = await this.requireSubagentRun(runId);
    const [parentSession, childSession] = await Promise.all([
      this.requireSession(run.parentSessionId),
      this.requireSession(run.childSessionId),
    ]);

    const [parentTask, childGoal, childTasks, childMessages, childCheckpoints, childToolInvocations] =
      await Promise.all([
        run.parentTaskId ? this.requireTask(run.parentTaskId) : Promise.resolve(undefined),
        childSession.activeGoalId ? this.requireGoal(childSession.activeGoalId) : Promise.resolve(undefined),
        this.store.tasks.listBySession(childSession.id),
        this.store.messages.listBySession(childSession.id),
        this.store.checkpoints.listBySession(childSession.id),
        this.store.toolInvocations.listBySession(childSession.id),
      ]);

    return {
      run,
      parentSession,
      childSession,
      parentTask,
      childGoal,
      childTasks,
      childMessages,
      childCheckpoints,
      childToolInvocations: childToolInvocations.filter(
        (log) => !log.subagentRunId || log.subagentRunId === run.id,
      ),
    };
  }

  async getParentTaskExecutionTrace(parentTaskId: string): Promise<ParentTaskExecutionTrace> {
    const parentTask = await this.requireTask(parentTaskId);
    const parentSession = await this.requireSession(parentTask.sessionId);
    const [sessionToolInvocations, parentRuns] = await Promise.all([
      this.store.toolInvocations.listBySession(parentSession.id),
      this.store.subagentRuns.listByParentSession(parentSession.id),
    ]);

    const delegatedRuns = parentRuns
      .filter((run) => run.parentTaskId === parentTask.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const delegatedReplays = await Promise.all(
      delegatedRuns.map(async (run) => this.getSubagentRunReplay(run.id)),
    );

    return {
      parentTask,
      parentSession,
      directToolInvocations: sessionToolInvocations.filter(
        (log) => log.taskId === parentTask.id && !log.subagentRunId,
      ),
      delegatedReplays,
    };
  }

  // 面试点：child session 需要有“收尾策略”，否则 subagent 会不断堆积成上下文垃圾。
  // 这里的 cleanup 只归档已经结束的 child session，并保留跳过原因，方便后面审计。
  async cleanupChildSessions(input: CleanupChildSessionsInput): Promise<CleanupChildSessionsResult> {
    await this.requireSession(input.parentSessionId);
    const policy = input.policy;
    const archiveStatuses =
      input.archiveStatuses ?? policy?.archiveStatuses ?? ["completed", "failed", "canceled"];
    const now = this.options.now();
    const nowTimestamp = toTimestamp(now);
    const [childSessions, runs] = await Promise.all([
      this.store.sessions.listByParentSession(input.parentSessionId),
      this.store.subagentRuns.listByParentSession(input.parentSessionId),
    ]);

    const retainMostRecentFinishedChildren = policy?.retainMostRecentFinishedChildren ?? 0;
    const childSessionsWithLatestFinishedRuns = childSessions
      .map((childSession) => ({
        childSessionId: childSession.id,
        latestRun: pickLatestRun(runs.filter((run) => run.childSessionId === childSession.id)),
      }))
      .flatMap((entry) => {
        if (!entry.latestRun) {
          return [];
        }

        if (!archiveStatuses.includes(entry.latestRun.status as (typeof archiveStatuses)[number])) {
          return [];
        }

        return [{ childSessionId: entry.childSessionId, latestRun: entry.latestRun }];
      });
    const retainedChildSessionIds = new Set(
      childSessionsWithLatestFinishedRuns
        .sort((left, right) => right.latestRun.updatedAt.localeCompare(left.latestRun.updatedAt))
        .slice(0, retainMostRecentFinishedChildren)
        .map((entry) => entry.childSessionId),
    );

    const archivedChildSessionIds: string[] = [];
    const skipped: CleanupChildSessionsResult["skipped"] = [];

    for (const childSession of childSessions) {
      if (childSession.status === "archived" && !(input.includeAlreadyArchived ?? false)) {
        skipped.push({
          childSessionId: childSession.id,
          reason: "child session 已归档",
        });
        continue;
      }

      const latestRun = pickLatestRun(runs.filter((run) => run.childSessionId === childSession.id));
      if (!latestRun) {
        skipped.push({
          childSessionId: childSession.id,
          reason: "未找到关联的 subagent run",
        });
        continue;
      }

      if (!archiveStatuses.includes(latestRun.status as (typeof archiveStatuses)[number])) {
        skipped.push({
          childSessionId: childSession.id,
          latestRunId: latestRun.id,
          latestRunStatus: latestRun.status,
          reason: "最新 subagent run 还未结束，不应归档",
        });
        continue;
      }

      if (retainedChildSessionIds.has(childSession.id)) {
        skipped.push({
          childSessionId: childSession.id,
          latestRunId: latestRun.id,
          latestRunStatus: latestRun.status,
          reason: "命中保留窗口，暂不自动归档",
        });
        continue;
      }

      if (policy?.requireResultSummary && !latestRun.resultSummary) {
        skipped.push({
          childSessionId: childSession.id,
          latestRunId: latestRun.id,
          latestRunStatus: latestRun.status,
          reason: "缺少结果摘要，不满足自动归档策略",
        });
        continue;
      }

      if (policy?.maxAgeMs !== undefined) {
        const ageMs = nowTimestamp - toTimestamp(latestRun.updatedAt);
        if (ageMs < policy.maxAgeMs) {
          skipped.push({
            childSessionId: childSession.id,
            latestRunId: latestRun.id,
            latestRunStatus: latestRun.status,
            reason: `距离最新结束时间仅 ${ageMs}ms，未达到自动归档阈值`,
          });
          continue;
        }
      }

      if (childSession.activeGoalId) {
        await this.store.goals.updateStatus(
          childSession.activeGoalId,
          mapRunStatusToGoalStatus(latestRun.status),
          now,
          latestRun.status === "completed" ? now : undefined,
        );
      }

      await this.store.sessions.updateSummary(
        childSession.id,
        {
          shortSummary:
            childSession.summary.shortSummary ||
            `子代理 ${latestRun.agentMode} 已${latestRun.status === "completed" ? "完成" : "结束"}`,
          openLoops: [],
          nextActions: [],
          importantFacts: childSession.summary.importantFacts,
        },
        now,
      );
      await this.store.sessions.archive(childSession.id, now);
      archivedChildSessionIds.push(childSession.id);
    }

    return {
      parentSessionId: input.parentSessionId,
      archivedChildSessionIds,
      skipped,
    };
  }

  private async createSessionRecord(input: {
    workspaceId: string;
    title: string;
    agentMode: AgentMode;
    parentSessionId?: string;
    summary: SessionSummary;
  }): Promise<Session> {
    const now = this.options.now();
    const session: Session = {
      id: this.options.createId("session"),
      workspaceId: input.workspaceId,
      parentSessionId: input.parentSessionId,
      title: input.title,
      status: "active",
      activeAgentMode: input.agentMode,
      summary: input.summary,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.sessions.create(session);
    return session;
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.store.sessions.getById(sessionId);
    if (!session) {
      throw new RuntimeEntityNotFoundError("session", sessionId);
    }

    return session;
  }

  private async requireGoal(goalId: string): Promise<Goal> {
    const goal = await this.store.goals.getById(goalId);
    if (!goal) {
      throw new RuntimeEntityNotFoundError("goal", goalId);
    }

    return goal;
  }

  private async requireSubagentRun(id: string): Promise<SubagentRun> {
    const run = await this.store.subagentRuns.getById(id);
    if (!run) {
      throw new RuntimeEntityNotFoundError("subagent_run", id);
    }

    return run;
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.store.tasks.getById(id);
    if (!task) {
      throw new RuntimeEntityNotFoundError("task", id);
    }

    return task;
  }
}
