import { createHash } from "node:crypto";

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
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { GraphMessage, PersistedCheckpoint, ToolInvocationLog } from "@agent-ide/runtime";

import type {
  CheckpointRow,
  GoalRow,
  MemoryRow,
  MessageRow,
  PlanRow,
  SessionRow,
  SubagentRunRow,
  TaskRow,
  ToolInvocationRow,
  WorkspaceRow,
} from "./contracts.js";
import type { SessionSummaryCache } from "./cache.js";

type WorkspaceRecord = WorkspaceRow & RowDataPacket;
type SessionRecord = SessionRow & RowDataPacket;
type GoalRecord = GoalRow & RowDataPacket;
type PlanRecord = PlanRow & RowDataPacket;
type TaskRecord = TaskRow & RowDataPacket;
type MemoryRecordRow = MemoryRow & RowDataPacket;
type MessageRecord = MessageRow & RowDataPacket;
type CheckpointRecord = CheckpointRow & RowDataPacket;
type SubagentRunRecord = SubagentRunRow & RowDataPacket;
type ToolInvocationRecord = ToolInvocationRow & RowDataPacket;

function toJson<T>(value: T): string {
  return JSON.stringify(value);
}

// mysql2 对 JSON 列的返回形态并不总是一致：
// 有时给字符串，有时直接给解析后的 JS 值。
// 所以这里不能假设“只要是 JSON 列，就一定还需要 JSON.parse”。
function fromJson<T>(value: string | T): T {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

function toStoredJsonString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// 面试点：workspace.path 可能很长，直接在 utf8mb4 上做唯一索引会撞 MySQL key length 限制。
// 这里保留原始 path 作为真实值，再额外存一份 path_hash 做稳定唯一键。
function hashWorkspacePath(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// 面试点：领域层统一用 ISO 时间串，MySQL 层统一用 DATETIME(3)。
// 这个适配层的目的就是不让业务层为了数据库格式去改自己的时间表达。
function toMySqlDateTime(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无法转换为 MySQL DATETIME: ${value}`);
  }

  return date.toISOString().replace("T", " ").replace("Z", "");
}

function fromMySqlDateTime(value: string | Date | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString();
}

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
  };
}

function mapSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentSessionId: row.parent_session_id,
    title: row.title,
    status: row.status,
    activeAgentMode: row.agent_mode as Session["activeAgentMode"],
    activeGoalId: row.active_goal_id,
    summary: fromJson<SessionSummary>(row.summary_json),
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
    archivedAt: fromMySqlDateTime(row.archived_at),
  };
}

function mapGoalRow(row: GoalRow): Goal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    title: row.title,
    description: row.description,
    successCriteria: fromJson<string[]>(row.success_criteria_json),
    status: row.status as Goal["status"],
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
    completedAt: fromMySqlDateTime(row.completed_at),
  };
}

function mapPlanRow(row: PlanRow): Plan {
  return {
    id: row.id,
    goalId: row.goal_id,
    sessionId: row.session_id,
    status: row.status as Plan["status"],
    summary: row.summary,
    steps: fromJson<Plan["steps"]>(row.steps_json),
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
  };
}

function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    goalId: row.goal_id,
    planId: row.plan_id,
    sessionId: row.session_id,
    ownerAgent: row.owner_agent as Task["ownerAgent"],
    title: row.title,
    status: row.status as Task["status"],
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
  };
}

function mapMemoryRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    scope: row.scope,
    key: row.key,
    value: row.value,
    source: row.source,
    confidence: row.confidence,
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
  };
}

function mapMessageRow(row: MessageRow): GraphMessage {
  return {
    id: row.id,
    role: row.role,
    content: fromJson<string>(row.content_json),
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
  };
}

function mapCheckpointRow(row: CheckpointRow): PersistedCheckpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    node: row.node as PersistedCheckpoint["node"],
    stateJson: toStoredJsonString(row.state_json),
    summary: row.summary,
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
  };
}

function mapSubagentRunRow(row: SubagentRunRow): SubagentRun {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    parentTaskId: row.parent_task_id,
    agentMode: row.agent_mode as SubagentRun["agentMode"],
    status: row.status as SubagentRun["status"],
    reason: row.reason,
    inputSummary: row.input_summary,
    resultSummary: row.result_summary,
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
  };
}

function mapToolInvocationRow(row: ToolInvocationRow): ToolInvocationLog {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    subagentRunId: row.subagent_run_id,
    toolName: row.tool_name,
    inputJson: toStoredJsonString(row.input_json),
    status: row.status,
    outputJson: row.output_json ? toStoredJsonString(row.output_json) : undefined,
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
  };
}

export class MySqlWorkspaceRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(workspace: Workspace): Promise<void> {
    const pathHash = hashWorkspacePath(workspace.path);

    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO workspaces (id, path, path_hash, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          path = VALUES(path),
          path_hash = VALUES(path_hash),
          label = VALUES(label),
          updated_at = VALUES(updated_at)
      `,
      [
        workspace.id,
        workspace.path,
        pathHash,
        workspace.label,
        toMySqlDateTime(workspace.createdAt),
        toMySqlDateTime(workspace.updatedAt),
      ],
    );
  }

  async getByPath(path: string): Promise<Workspace | null> {
    const pathHash = hashWorkspacePath(path);
    const [rows] = await this.pool.query<WorkspaceRecord[]>(
      `SELECT * FROM workspaces WHERE path_hash = ? AND path = ? LIMIT 1`,
      [pathHash, path],
    );

    return rows[0] ? mapWorkspaceRow(rows[0]) : null;
  }

  async getById(id: string): Promise<Workspace | null> {
    const [rows] = await this.pool.query<WorkspaceRecord[]>(
      `SELECT * FROM workspaces WHERE id = ? LIMIT 1`,
      [id],
    );

    return rows[0] ? mapWorkspaceRow(rows[0]) : null;
  }
}

export class MySqlSessionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly summaryCache?: SessionSummaryCache,
  ) {}

  async create(session: Session): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO sessions (
          id, workspace_id, parent_session_id, title, status, agent_mode,
          active_goal_id, summary_json, created_at, updated_at, archived_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        session.id,
        session.workspaceId,
        session.parentSessionId ?? null,
        session.title,
        session.status,
        session.activeAgentMode,
        session.activeGoalId ?? null,
        toJson(session.summary),
        toMySqlDateTime(session.createdAt),
        toMySqlDateTime(session.updatedAt),
        toMySqlDateTime(session.archivedAt),
      ],
    );

    if (this.summaryCache) {
      await this.summaryCache.set(session.id, session.summary);
    }
  }

  async getById(id: string): Promise<Session | null> {
    const [rows] = await this.pool.query<SessionRecord[]>(
      `SELECT * FROM sessions WHERE id = ? LIMIT 1`,
      [id],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    if (this.summaryCache) {
      const cachedSummary = await this.summaryCache.get(id);
      if (cachedSummary) {
        row.summary_json = toJson(cachedSummary);
      } else {
        await this.summaryCache.set(id, fromJson<SessionSummary>(row.summary_json));
      }
    }

    return mapSessionRow(row);
  }

  async listByWorkspace(workspaceId: string): Promise<Session[]> {
    const [rows] = await this.pool.query<SessionRecord[]>(
      `
        SELECT * FROM sessions
        WHERE workspace_id = ?
        ORDER BY updated_at DESC
      `,
      [workspaceId],
    );

    return rows.map((row) => mapSessionRow(row));
  }

  async listByParentSession(parentSessionId: string): Promise<Session[]> {
    const [rows] = await this.pool.query<SessionRecord[]>(
      `
        SELECT * FROM sessions
        WHERE parent_session_id = ?
        ORDER BY created_at ASC
      `,
      [parentSessionId],
    );

    return rows.map((row) => mapSessionRow(row));
  }

  async rename(sessionId: string, title: string, updatedAt: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
      [title, toMySqlDateTime(updatedAt), sessionId],
    );
  }

  async archive(sessionId: string, archivedAt: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE sessions
        SET status = 'archived', archived_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [toMySqlDateTime(archivedAt), toMySqlDateTime(archivedAt), sessionId],
    );
  }

  async updateSummary(sessionId: string, summary: SessionSummary, updatedAt: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE sessions
        SET summary_json = ?, updated_at = ?
        WHERE id = ?
      `,
      [toJson(summary), toMySqlDateTime(updatedAt), sessionId],
    );

    if (this.summaryCache) {
      await this.summaryCache.set(sessionId, summary);
    }
  }

  async setActiveGoal(sessionId: string, goalId: string | null, updatedAt: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE sessions
        SET active_goal_id = ?, updated_at = ?
        WHERE id = ?
      `,
      [goalId, toMySqlDateTime(updatedAt), sessionId],
    );
  }
}

export class MySqlGoalRepository {
  constructor(private readonly pool: Pool) {}

  async create(goal: Goal): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO goals (
          id, workspace_id, session_id, title, description,
          success_criteria_json, status, created_at, updated_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        goal.id,
        goal.workspaceId,
        goal.sessionId,
        goal.title,
        goal.description,
        toJson(goal.successCriteria),
        goal.status,
        toMySqlDateTime(goal.createdAt),
        toMySqlDateTime(goal.updatedAt),
        toMySqlDateTime(goal.completedAt),
      ],
    );
  }

  async getById(id: string): Promise<Goal | null> {
    const [rows] = await this.pool.query<GoalRecord[]>(
      `SELECT * FROM goals WHERE id = ? LIMIT 1`,
      [id],
    );

    return rows[0] ? mapGoalRow(rows[0]) : null;
  }

  async listBySession(sessionId: string): Promise<Goal[]> {
    const [rows] = await this.pool.query<GoalRecord[]>(
      `
        SELECT * FROM goals
        WHERE session_id = ?
        ORDER BY updated_at DESC
      `,
      [sessionId],
    );

    return rows.map((row) => mapGoalRow(row));
  }

  async updateStatus(id: string, status: Goal["status"], updatedAt: string, completedAt?: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE goals
        SET status = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `,
      [status, toMySqlDateTime(updatedAt), toMySqlDateTime(completedAt), id],
    );
  }
}

export class MySqlPlanRepository {
  constructor(private readonly pool: Pool) {}

  async save(plan: Plan): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO plans (id, goal_id, session_id, status, summary, steps_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          summary = VALUES(summary),
          steps_json = VALUES(steps_json),
          updated_at = VALUES(updated_at)
      `,
      [
        plan.id,
        plan.goalId,
        plan.sessionId,
        plan.status,
        plan.summary,
        toJson(plan.steps),
        toMySqlDateTime(plan.createdAt),
        toMySqlDateTime(plan.updatedAt),
      ],
    );
  }

  async getLatestByGoal(goalId: string): Promise<Plan | null> {
    const [rows] = await this.pool.query<PlanRecord[]>(
      `
        SELECT * FROM plans
        WHERE goal_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [goalId],
    );

    return rows[0] ? mapPlanRow(rows[0]) : null;
  }
}

export class MySqlTaskRepository {
  constructor(private readonly pool: Pool) {}

  async getById(id: string): Promise<Task | null> {
    const [rows] = await this.pool.query<TaskRecord[]>(
      `
        SELECT * FROM tasks
        WHERE id = ?
        LIMIT 1
      `,
      [id],
    );

    return rows[0] ? mapTaskRow(rows[0]) : null;
  }

  async upsertMany(tasks: Task[]): Promise<void> {
    if (tasks.length === 0) {
      return;
    }

    for (const task of tasks) {
      await this.pool.execute<ResultSetHeader>(
        `
          INSERT INTO tasks (
            id, goal_id, plan_id, session_id, owner_agent, title, status,
            input_summary, output_summary, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            owner_agent = VALUES(owner_agent),
            title = VALUES(title),
            status = VALUES(status),
            input_summary = VALUES(input_summary),
            output_summary = VALUES(output_summary),
            updated_at = VALUES(updated_at)
        `,
        [
          task.id,
          task.goalId,
          task.planId ?? null,
          task.sessionId,
          task.ownerAgent,
          task.title,
          task.status,
          task.inputSummary,
          task.outputSummary ?? null,
          toMySqlDateTime(task.createdAt),
          toMySqlDateTime(task.updatedAt),
        ],
      );
    }
  }

  async listBySession(sessionId: string): Promise<Task[]> {
    const [rows] = await this.pool.query<TaskRecord[]>(
      `
        SELECT * FROM tasks
        WHERE session_id = ?
        ORDER BY updated_at DESC
      `,
      [sessionId],
    );

    return rows.map((row) => mapTaskRow(row));
  }
}

export class MySqlMemoryRepository {
  constructor(private readonly pool: Pool) {}

  async create(record: MemoryRecord): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO memory_records (
          id, workspace_id, session_id, scope, \`key\`, \`value\`,
          source, confidence, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.id,
        record.workspaceId,
        record.sessionId ?? null,
        record.scope,
        record.key,
        record.value,
        record.source,
        record.confidence,
        toMySqlDateTime(record.createdAt),
        toMySqlDateTime(record.updatedAt),
      ],
    );
  }

  async listByScope(workspaceId: string, scope: MemoryRecord["scope"], sessionId?: string): Promise<MemoryRecord[]> {
    const [rows] = sessionId
      ? await this.pool.query<MemoryRecordRow[]>(
          `
            SELECT * FROM memory_records
            WHERE workspace_id = ? AND scope = ? AND session_id = ?
            ORDER BY updated_at DESC
          `,
          [workspaceId, scope, sessionId],
        )
      : await this.pool.query<MemoryRecordRow[]>(
          `
            SELECT * FROM memory_records
            WHERE workspace_id = ? AND scope = ?
            ORDER BY updated_at DESC
          `,
          [workspaceId, scope],
        );

    return rows.map((row) => mapMemoryRow(row));
  }
}

export class MySqlMessageRepository {
  constructor(private readonly pool: Pool) {}

  async append(sessionId: string, message: GraphMessage): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO messages (id, session_id, role, content_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [message.id, sessionId, message.role, toJson(message.content), toMySqlDateTime(message.createdAt)],
    );
  }

  async listBySession(sessionId: string): Promise<GraphMessage[]> {
    const [rows] = await this.pool.query<MessageRecord[]>(
      `
        SELECT * FROM messages
        WHERE session_id = ?
        ORDER BY created_at ASC
      `,
      [sessionId],
    );

    return rows.map((row) => mapMessageRow(row));
  }
}

export class MySqlCheckpointRepository {
  constructor(private readonly pool: Pool) {}

  async create(checkpoint: PersistedCheckpoint): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO checkpoints (id, session_id, node, state_json, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.node,
        checkpoint.stateJson,
        checkpoint.summary,
        toMySqlDateTime(checkpoint.createdAt),
      ],
    );
  }

  async listBySession(sessionId: string): Promise<PersistedCheckpoint[]> {
    const [rows] = await this.pool.query<CheckpointRecord[]>(
      `
        SELECT * FROM checkpoints
        WHERE session_id = ?
        ORDER BY created_at DESC
      `,
      [sessionId],
    );

    return rows.map((row) => mapCheckpointRow(row));
  }
}

export class MySqlSubagentRunRepository {
  constructor(private readonly pool: Pool) {}

  async create(run: SubagentRun): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO subagent_runs (
          id, parent_session_id, child_session_id, parent_task_id,
          agent_mode, status, reason, input_summary, result_summary,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        run.id,
        run.parentSessionId,
        run.childSessionId,
        run.parentTaskId ?? null,
        run.agentMode,
        run.status,
        run.reason,
        run.inputSummary,
        run.resultSummary ?? null,
        toMySqlDateTime(run.createdAt),
        toMySqlDateTime(run.updatedAt),
      ],
    );
  }

  async getById(id: string): Promise<SubagentRun | null> {
    const [rows] = await this.pool.query<SubagentRunRecord[]>(
      `
        SELECT * FROM subagent_runs
        WHERE id = ?
        LIMIT 1
      `,
      [id],
    );

    return rows[0] ? mapSubagentRunRow(rows[0]) : null;
  }

  async complete(
    id: string,
    status: SubagentRun["status"],
    resultSummary: string | undefined,
    updatedAt: string,
  ): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE subagent_runs
        SET status = ?, result_summary = ?, updated_at = ?
        WHERE id = ?
      `,
      [status, resultSummary ?? null, toMySqlDateTime(updatedAt), id],
    );
  }

  async listByParentSession(parentSessionId: string): Promise<SubagentRun[]> {
    const [rows] = await this.pool.query<SubagentRunRecord[]>(
      `
        SELECT * FROM subagent_runs
        WHERE parent_session_id = ?
        ORDER BY created_at DESC
      `,
      [parentSessionId],
    );

    return rows.map((row) => mapSubagentRunRow(row));
  }
}

export class MySqlToolInvocationRepository {
  constructor(private readonly pool: Pool) {}

  async start(log: ToolInvocationLog): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO tool_invocations (
          id, session_id, task_id, subagent_run_id,
          tool_name, input_json, status, output_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        log.id,
        log.sessionId,
        log.taskId ?? null,
        log.subagentRunId ?? null,
        log.toolName,
        log.inputJson,
        log.status,
        log.outputJson ?? null,
        toMySqlDateTime(log.createdAt),
        toMySqlDateTime(log.updatedAt),
      ],
    );
  }

  async finish(
    id: string,
    status: ToolInvocationLog["status"],
    outputJson: string | undefined,
    updatedAt: string,
  ): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE tool_invocations
        SET status = ?, output_json = ?, updated_at = ?
        WHERE id = ?
      `,
      [status, outputJson ?? null, toMySqlDateTime(updatedAt), id],
    );
  }

  async listBySession(sessionId: string): Promise<ToolInvocationLog[]> {
    const [rows] = await this.pool.query<ToolInvocationRecord[]>(
      `
        SELECT * FROM tool_invocations
        WHERE session_id = ?
        ORDER BY created_at DESC
      `,
      [sessionId],
    );

    return rows.map((row) => mapToolInvocationRow(row));
  }
}
