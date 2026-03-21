import type {
  Goal,
  MemoryRecord,
  Plan,
  Session,
  SessionSummary,
  Task,
  Workspace,
} from "@agent-ide/core";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type {
  GoalRow,
  MemoryRow,
  PlanRow,
  SessionRow,
  TaskRow,
  WorkspaceRow,
} from "./contracts.js";
import type { SessionSummaryCache } from "./cache.js";

type WorkspaceRecord = WorkspaceRow & RowDataPacket;
type SessionRecord = SessionRow & RowDataPacket;
type GoalRecord = GoalRow & RowDataPacket;
type PlanRecord = PlanRow & RowDataPacket;
type TaskRecord = TaskRow & RowDataPacket;
type MemoryRecordRow = MemoryRow & RowDataPacket;

function toJson<T>(value: T): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MySqlWorkspaceRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(workspace: Workspace): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO workspaces (id, path, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          path = VALUES(path),
          label = VALUES(label),
          updated_at = VALUES(updated_at)
      `,
      [workspace.id, workspace.path, workspace.label, workspace.createdAt, workspace.updatedAt],
    );
  }

  async getByPath(path: string): Promise<Workspace | null> {
    const [rows] = await this.pool.query<WorkspaceRecord[]>(
      `SELECT * FROM workspaces WHERE path = ? LIMIT 1`,
      [path],
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
        session.createdAt,
        session.updatedAt,
        session.archivedAt ?? null,
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

  async rename(sessionId: string, title: string, updatedAt: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
      [title, updatedAt, sessionId],
    );
  }

  async archive(sessionId: string, archivedAt: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE sessions
        SET status = 'archived', archived_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [archivedAt, archivedAt, sessionId],
    );
  }

  async updateSummary(sessionId: string, summary: SessionSummary, updatedAt: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        UPDATE sessions
        SET summary_json = ?, updated_at = ?
        WHERE id = ?
      `,
      [toJson(summary), updatedAt, sessionId],
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
      [goalId, updatedAt, sessionId],
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
        goal.createdAt,
        goal.updatedAt,
        goal.completedAt ?? null,
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
      [status, updatedAt, completedAt ?? null, id],
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
        plan.createdAt,
        plan.updatedAt,
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
          task.createdAt,
          task.updatedAt,
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
        record.createdAt,
        record.updatedAt,
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
