import type {
  SubagentRun,
  Goal,
  MemoryRecord,
  Plan,
  Session,
  SessionSummary,
  Task,
  Workspace,
} from "@agent-ide/core";
import type { GraphCheckpoint, GraphMessage, WorkflowNode } from "./graph.js";

// RuntimeStore 是 runtime 访问持久化层的统一入口。
// runtime 只依赖这组合同，不直接依赖具体的 MySQL/Redis 实现。
export interface WorkspaceStore {
  upsert(workspace: Workspace): Promise<void>;
  getById(id: string): Promise<Workspace | null>;
  getByPath(path: string): Promise<Workspace | null>;
}

export interface SessionStore {
  create(session: Session): Promise<void>;
  getById(id: string): Promise<Session | null>;
  listByWorkspace(workspaceId: string): Promise<Session[]>;
  listByParentSession(parentSessionId: string): Promise<Session[]>;
  rename(sessionId: string, title: string, updatedAt: string): Promise<void>;
  archive(sessionId: string, archivedAt: string): Promise<void>;
  updateSummary(sessionId: string, summary: SessionSummary, updatedAt: string): Promise<void>;
  setActiveGoal(sessionId: string, goalId: string | null, updatedAt: string): Promise<void>;
}

export interface GoalStore {
  create(goal: Goal): Promise<void>;
  getById(id: string): Promise<Goal | null>;
  listBySession(sessionId: string): Promise<Goal[]>;
  updateStatus(id: string, status: Goal["status"], updatedAt: string, completedAt?: string): Promise<void>;
}

export interface PlanStore {
  save(plan: Plan): Promise<void>;
  getLatestByGoal(goalId: string): Promise<Plan | null>;
}

export interface TaskStore {
  getById(id: string): Promise<Task | null>;
  upsertMany(tasks: Task[]): Promise<void>;
  listBySession(sessionId: string): Promise<Task[]>;
}

export interface MemoryStore {
  create(record: MemoryRecord): Promise<void>;
  listByScope(
    workspaceId: string,
    scope: MemoryRecord["scope"],
    sessionId?: string,
  ): Promise<MemoryRecord[]>;
}

export interface PersistedCheckpoint extends GraphCheckpoint {
  stateJson: string;
}

export interface ToolInvocationLog {
  id: string;
  sessionId: string;
  taskId?: string;
  subagentRunId?: string;
  toolName: string;
  inputJson: string;
  status: "started" | "completed" | "failed";
  outputJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageStore {
  append(sessionId: string, message: GraphMessage): Promise<void>;
  listBySession(sessionId: string): Promise<GraphMessage[]>;
}

export interface CheckpointStore {
  create(checkpoint: PersistedCheckpoint): Promise<void>;
  listBySession(sessionId: string): Promise<PersistedCheckpoint[]>;
}

export interface SubagentRunStore {
  create(run: SubagentRun): Promise<void>;
  getById(id: string): Promise<SubagentRun | null>;
  complete(
    id: string,
    status: SubagentRun["status"],
    resultSummary: string | undefined,
    updatedAt: string,
  ): Promise<void>;
  listByParentSession(parentSessionId: string): Promise<SubagentRun[]>;
}

export interface ToolInvocationStore {
  start(log: ToolInvocationLog): Promise<void>;
  finish(
    id: string,
    status: ToolInvocationLog["status"],
    outputJson: string | undefined,
    updatedAt: string,
  ): Promise<void>;
  listBySession(sessionId: string): Promise<ToolInvocationLog[]>;
}

export interface RuntimeStore {
  workspaces: WorkspaceStore;
  sessions: SessionStore;
  goals: GoalStore;
  plans: PlanStore;
  tasks: TaskStore;
  memory: MemoryStore;
  messages: MessageStore;
  checkpoints: CheckpointStore;
  subagentRuns: SubagentRunStore;
  toolInvocations: ToolInvocationStore;
}
