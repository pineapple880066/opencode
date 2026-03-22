import { describe, test } from "node:test";
import assert from "node:assert/strict";

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
} from "./store.js";
import { GoalDrivenRuntimeService } from "./service.js";

class InMemoryRuntimeStore implements RuntimeStore {
  readonly workspacesMap = new Map<string, Workspace>();
  readonly sessionsMap = new Map<string, Session>();

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
    rename: async (sessionId: string, title: string, updatedAt: string) => {
      const session = this.sessionsMap.get(sessionId);
      if (!session) {
        return;
      }

      this.sessionsMap.set(sessionId, {
        ...session,
        title,
        updatedAt,
      });
    },
    archive: async (sessionId: string, archivedAt: string) => {
      const session = this.sessionsMap.get(sessionId);
      if (!session) {
        return;
      }

      this.sessionsMap.set(sessionId, {
        ...session,
        status: "archived",
        archivedAt,
        updatedAt: archivedAt,
      });
    },
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
    create: async (_goal: Goal) => undefined,
    getById: async (_id: string) => null,
    listBySession: async (_sessionId: string) => [],
    updateStatus: async (
      _id: string,
      _status: Goal["status"],
      _updatedAt: string,
      _completedAt?: string,
    ) => undefined,
  };

  readonly plans = {
    save: async (_plan: Plan) => undefined,
    getLatestByGoal: async (_goalId: string) => null,
  };

  readonly tasks = {
    getById: async (_id: string) => null,
    upsertMany: async (_tasks: Task[]) => undefined,
    listBySession: async (_sessionId: string) => [],
  };

  readonly memory = {
    create: async (_record: MemoryRecord) => undefined,
    listByScope: async (_workspaceId: string, _scope: MemoryRecord["scope"], _sessionId?: string) => [],
  };

  readonly messages = {
    append: async (_sessionId: string, _message: any) => undefined,
    listBySession: async (_sessionId: string) => [],
  };

  readonly checkpoints = {
    create: async (_checkpoint: PersistedCheckpoint) => undefined,
    listBySession: async (_sessionId: string) => [],
  };

  readonly subagentRuns = {
    create: async (_run: SubagentRun) => undefined,
    getById: async (_id: string) => null,
    complete: async (
      _id: string,
      _status: SubagentRun["status"],
      _resultSummary: string | undefined,
      _updatedAt: string,
    ) => undefined,
    listByParentSession: async (_parentSessionId: string) => [],
  };

  readonly toolInvocations = {
    start: async (_log: ToolInvocationLog) => undefined,
    finish: async (
      _id: string,
      _status: ToolInvocationLog["status"],
      _outputJson: string | undefined,
      _updatedAt: string,
    ) => undefined,
    listBySession: async (_sessionId: string) => [],
  };
}

describe("GoalDrivenRuntimeService multi-session scenarios", () => {
  test("可以覆盖 create -> rename -> child lineage -> archive -> list 的多会话流程", async () => {
    const store = new InMemoryRuntimeStore();
    let tick = 0;
    const service = new GoalDrivenRuntimeService(store, {
      now: () => `2026-03-21T10:00:0${tick++}.000Z`,
      createId: (prefix: string) => `${prefix}_${tick}`,
    });

    const mainSession = await service.createSession({
      workspacePath: "/tmp/project",
      workspaceLabel: "project",
      title: "main",
      agentMode: "build",
    });
    const renamedMain = await service.renameSession({
      sessionId: mainSession.id,
      title: "main-renamed",
    });
    const reviewSession = await service.createSession({
      workspacePath: "/tmp/project",
      title: "review-pass",
      agentMode: "review",
    });
    const child = await service.createChildSession({
      parentSessionId: mainSession.id,
      title: "explore-child",
      agentMode: "explore",
      inheritActiveGoal: false,
      delegationReason: "只读探索",
    });
    const archivedReview = await service.archiveSession({
      sessionId: reviewSession.id,
    });

    const sessions = await service.listSessionsByWorkspacePath("/tmp/project");
    const childSessions = await service.listChildSessions(mainSession.id);
    const fetchedMain = await service.getSession(mainSession.id);

    assert.equal(renamedMain.title, "main-renamed");
    assert.equal(fetchedMain.title, "main-renamed");
    assert.equal(archivedReview.status, "archived");
    assert.equal(sessions.length, 3);
    assert.equal(childSessions.length, 1);
    assert.equal(childSessions[0]?.id, child.childSession.id);
    assert.equal(child.childSession.parentSessionId, mainSession.id);

    const workspaceIds = new Set(sessions.map((session) => session.workspaceId));
    assert.equal(workspaceIds.size, 1);

    const sessionStatuses = new Map(sessions.map((session) => [session.id, session.status]));
    assert.equal(sessionStatuses.get(mainSession.id), "active");
    assert.equal(sessionStatuses.get(reviewSession.id), "archived");
    assert.equal(sessionStatuses.get(child.childSession.id), "active");
  });
});
