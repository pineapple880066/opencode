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
} from "@agent-ide/runtime";
import { GoalDrivenRuntimeService } from "@agent-ide/runtime";

import { buildParentTaskDelegationPanelState, buildSubagentReplayPanelState } from "./panels.js";

class InMemoryRuntimeStore implements RuntimeStore {
  readonly workspacesMap = new Map<string, Workspace>();
  readonly sessionsMap = new Map<string, Session>();
  readonly goalsMap = new Map<string, Goal>();
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
    save: async (_plan: Plan) => undefined,
    getLatestByGoal: async (_goalId: string) => null,
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

describe("ide replay panels", () => {
  test("可以把 subagent replay 构造成 panel 状态", async () => {
    const now = "2026-03-21T10:00:00.000Z";
    const store = new InMemoryRuntimeStore();
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
      title: "parent",
      status: "active",
      activeAgentMode: "build",
      summary: { shortSummary: "", openLoops: [], nextActions: [], importantFacts: [] },
      createdAt: now,
      updatedAt: now,
    };
    const childSession: Session = {
      id: "session_child",
      workspaceId: workspace.id,
      parentSessionId: parentSession.id,
      title: "child",
      status: "active",
      activeAgentMode: "explore",
      activeGoalId: "goal_child",
      summary: { shortSummary: "", openLoops: [], nextActions: [], importantFacts: [] },
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
      goalId: "goal_parent",
      sessionId: parentSession.id,
      ownerAgent: "build",
      title: "看 delegation",
      status: "in_progress",
      inputSummary: "trace",
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
      outputSummary: "有 2 个风险点",
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

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.sessionsMap.set(childSession.id, childSession);
    store.goalsMap.set(childGoal.id, childGoal);
    store.tasksMap.set(parentTask.id, parentTask);
    store.tasksMap.set(childTask.id, childTask);
    store.subagentRunsMap.set(run.id, run);

    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_fixed`,
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

    const panel = await buildSubagentReplayPanelState(service, run.id);

    assert.equal(panel.panel, "subagent-replay");
    assert.equal(panel.runId, run.id);
    assert.equal(panel.parentTaskTitle, parentTask.title);
    assert.equal(panel.taskToolGroups.length, 1);
    assert.equal(panel.taskToolGroups[0]?.taskId, childTask.id);
    assert.equal(panel.timeline.length, 3);
  });

  test("可以把 parent task delegation 聚合成 panel 状态", async () => {
    const now = "2026-03-21T10:00:00.000Z";
    const store = new InMemoryRuntimeStore();
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
      title: "parent",
      status: "active",
      activeAgentMode: "build",
      summary: { shortSummary: "", openLoops: [], nextActions: [], importantFacts: [] },
      createdAt: now,
      updatedAt: now,
    };
    const childSession: Session = {
      id: "session_child",
      workspaceId: workspace.id,
      parentSessionId: parentSession.id,
      title: "child",
      status: "active",
      activeAgentMode: "explore",
      summary: { shortSummary: "", openLoops: [], nextActions: [], importantFacts: [] },
      createdAt: now,
      updatedAt: now,
    };
    const parentTask: Task = {
      id: "task_parent",
      goalId: "goal_parent",
      sessionId: parentSession.id,
      ownerAgent: "build",
      title: "聚合 delegation",
      status: "in_progress",
      inputSummary: "trace",
      createdAt: now,
      updatedAt: now,
    };
    const childTask: Task = {
      id: "task_child",
      goalId: "goal_child",
      sessionId: childSession.id,
      ownerAgent: "explore",
      title: "读 controller",
      status: "done",
      inputSummary: "grep TODO",
      outputSummary: "有 2 个风险点",
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

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.sessionsMap.set(childSession.id, childSession);
    store.tasksMap.set(parentTask.id, parentTask);
    store.tasksMap.set(childTask.id, childTask);
    store.subagentRunsMap.set(run.id, run);

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

    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_fixed`,
    });
    const panel = await buildParentTaskDelegationPanelState(service, parentTask.id);

    assert.equal(panel.panel, "parent-task-delegation");
    assert.equal(panel.parentTaskTitle, parentTask.title);
    assert.equal(panel.directToolInvocations.length, 1);
    assert.equal(panel.directToolInvocations[0]?.toolName, "bash");
    assert.equal(panel.delegatedRuns.length, 1);
    assert.equal(panel.delegatedRuns[0]?.toolInvocationCount, 1);
  });
});
