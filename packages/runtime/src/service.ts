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
  type Task,
  type Workspace,
} from "@agent-ide/core";

import type { AgentGraphState } from "./graph.js";
import type { RuntimeStore } from "./store.js";

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

function createDefaultSessionSummary(): SessionSummary {
  return {
    shortSummary: "",
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

export class RuntimeEntityNotFoundError extends Error {
  constructor(entityName: string, entityId: string) {
    super(`未找到 ${entityName}: ${entityId}`);
    this.name = "RuntimeEntityNotFoundError";
  }
}

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
    const now = this.options.now();

    const session: Session = {
      id: this.options.createId("session"),
      workspaceId: workspace.id,
      parentSessionId: input.parentSessionId,
      title: input.title,
      status: "active",
      activeAgentMode: input.agentMode ?? "build",
      summary: createDefaultSessionSummary(),
      createdAt: now,
      updatedAt: now,
    };

    await this.store.sessions.create(session);
    return session;
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

    return {
      workspaceId: session.workspaceId,
      session,
      activeGoal,
      currentPlan: currentPlan ?? undefined,
      tasks,
      messages: [],
      memory: [...sessionMemory, ...workspaceMemory],
      activeAgent: session.activeAgentMode,
      activePolicy: DEFAULT_TOOL_POLICIES[session.activeAgentMode],
      subagentRuns: [],
      checkpoints: [],
    };
  }

  async listSessionsByWorkspacePath(workspacePath: string): Promise<Session[]> {
    const workspace = await this.store.workspaces.getByPath(workspacePath);
    if (!workspace) {
      return [];
    }

    return this.store.sessions.listByWorkspace(workspace.id);
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
}

