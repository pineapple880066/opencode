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
    create: async (goal: Goal) => {
      this.goalsMap.set(goal.id, goal);
    },
    getById: async (id: string) => this.goalsMap.get(id) ?? null,
    listBySession: async (sessionId: string) =>
      Array.from(this.goalsMap.values()).filter((goal) => goal.sessionId === sessionId),
    updateStatus: async (id: string, status: Goal["status"], updatedAt: string, completedAt?: string) => {
      const goal = this.goalsMap.get(id);
      if (!goal) {
        return;
      }

      this.goalsMap.set(id, {
        ...goal,
        status,
        updatedAt,
        completedAt,
      });
    },
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
    complete: async (
      id: string,
      status: SubagentRun["status"],
      resultSummary: string | undefined,
      updatedAt: string,
    ) => {
      const run = this.subagentRunsMap.get(id);
      if (!run) {
        return;
      }

      this.subagentRunsMap.set(id, {
        ...run,
        status,
        resultSummary,
        updatedAt,
      });
    },
    listByParentSession: async (parentSessionId: string) =>
      Array.from(this.subagentRunsMap.values()).filter((run) => run.parentSessionId === parentSessionId),
  };

  readonly toolInvocations = {
    start: async (log: ToolInvocationLog) => {
      this.toolInvocationsMap.set(log.id, log);
    },
    finish: async (
      id: string,
      status: ToolInvocationLog["status"],
      outputJson: string | undefined,
      updatedAt: string,
    ) => {
      const current = this.toolInvocationsMap.get(id);
      if (!current) {
        return;
      }

      this.toolInvocationsMap.set(id, {
        ...current,
        status,
        outputJson,
        updatedAt,
      });
    },
    listBySession: async (sessionId: string) =>
      Array.from(this.toolInvocationsMap.values()).filter((log) => log.sessionId === sessionId),
  };
}

describe("GoalDrivenRuntimeService subagent delegation", () => {
  test("会创建 child session、复制 active goal，并记录 subagent run", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      activeGoalId: "goal_parent",
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    const parentGoal: Goal = {
      id: "goal_parent",
      workspaceId: workspace.id,
      sessionId: parentSession.id,
      title: "修复核心流程",
      description: "让主流程更稳定",
      successCriteria: ["完成子任务并回传结果"],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.goalsMap.set(parentGoal.id, parentGoal);

    let sequence = 0;
    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_${++sequence}`,
    });

    const result = await service.delegateToSubagent({
      parentSessionId: parentSession.id,
      agentMode: "explore",
      reason: "先读代码找风险",
      inputSummary: "只做只读探索",
      inheritActiveGoal: true,
    });

    assert.equal(result.childSession.parentSessionId, parentSession.id);
    assert.equal(result.childSession.activeAgentMode, "explore");
    assert.equal(result.run.parentSessionId, parentSession.id);
    assert.equal(result.run.childSessionId, result.childSession.id);
    assert.equal(result.run.status, "queued");
    assert.ok(result.childGoal);
    assert.equal(result.childGoal?.sessionId, result.childSession.id);
    assert.match(result.childGoal?.description ?? "", /子代理任务重点：先读代码找风险/);

    const childSessions = await service.listChildSessions(parentSession.id);
    assert.equal(childSessions.length, 1);
    assert.equal(childSessions[0]?.id, result.childSession.id);

    const childMessages = await store.messages.listBySession(result.childSession.id);
    assert.equal(childMessages.length, 1);
    assert.match(childMessages[0]?.content ?? "", /父 session 委托给 explore 子代理/);
  });

  test("完成 subagent run 会更新状态和结果摘要", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
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
      summary: {
        shortSummary: "child",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    const subagentRun: SubagentRun = {
      id: "subagent_run_1",
      parentSessionId: parentSession.id,
      childSessionId: childSession.id,
      agentMode: "explore",
      status: "queued",
      reason: "读代码",
      inputSummary: "先看一遍",
      createdAt: now,
      updatedAt: now,
    };

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.sessionsMap.set(childSession.id, childSession);
    store.subagentRunsMap.set(subagentRun.id, subagentRun);

    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_fixed`,
    });

    await service.completeSubagentRun({
      id: subagentRun.id,
      status: "completed",
      resultSummary: "已经收集完风险点",
    });

    const updated = store.subagentRunsMap.get(subagentRun.id);
    assert.equal(updated?.status, "completed");
    assert.equal(updated?.resultSummary, "已经收集完风险点");
  });

  test("完成 subagent run 时可以把结果吸收到父 session，并归档 child session", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
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
      summary: {
        shortSummary: "等待结果",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
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
    const subagentRun: SubagentRun = {
      id: "subagent_run_1",
      parentSessionId: parentSession.id,
      childSessionId: childSession.id,
      agentMode: "explore",
      status: "running",
      reason: "读代码找风险",
      inputSummary: "只读分析",
      createdAt: now,
      updatedAt: now,
    };

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.sessionsMap.set(childSession.id, childSession);
    store.goalsMap.set(childGoal.id, childGoal);
    store.subagentRunsMap.set(subagentRun.id, subagentRun);

    let sequence = 0;
    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_${++sequence}`,
    });

    await service.completeSubagentRun({
      id: subagentRun.id,
      status: "completed",
      resultSummary: "发现 3 个需要优先处理的风险点",
      appendParentMessage: true,
      archiveChildSession: true,
    });

    const updatedRun = store.subagentRunsMap.get(subagentRun.id);
    assert.equal(updatedRun?.status, "completed");
    assert.equal(updatedRun?.resultSummary, "发现 3 个需要优先处理的风险点");

    const archivedChild = store.sessionsMap.get(childSession.id);
    assert.equal(archivedChild?.status, "archived");
    assert.match(archivedChild?.summary.shortSummary ?? "", /发现 3 个需要优先处理的风险点/);

    const updatedGoal = store.goalsMap.get(childGoal.id);
    assert.equal(updatedGoal?.status, "completed");

    const parentMessages = await store.messages.listBySession(parentSession.id);
    assert.equal(parentMessages.length, 1);
    assert.match(parentMessages[0]?.content ?? "", /结果摘要：发现 3 个需要优先处理的风险点/);
  });

  test("delegation 和 completion 会联动父 task 的状态与结果摘要", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      activeGoalId: "goal_parent",
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    const parentGoal: Goal = {
      id: "goal_parent",
      workspaceId: workspace.id,
      sessionId: parentSession.id,
      title: "修复核心流程",
      description: "让主流程更稳定",
      successCriteria: ["完成子任务并回传结果"],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const parentTask: Task = {
      id: "task_parent",
      goalId: parentGoal.id,
      sessionId: parentSession.id,
      ownerAgent: "build",
      title: "调查风险",
      status: "todo",
      inputSummary: "把风险读一遍",
      createdAt: now,
      updatedAt: now,
    };

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.goalsMap.set(parentGoal.id, parentGoal);
    store.tasksMap.set(parentTask.id, parentTask);

    let sequence = 0;
    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_${++sequence}`,
    });

    const delegated = await service.delegateToSubagent({
      parentSessionId: parentSession.id,
      parentTaskId: parentTask.id,
      agentMode: "explore",
      reason: "先做只读探索",
      inputSummary: "列出风险点",
      inheritActiveGoal: true,
    });

    const inProgressTask = store.tasksMap.get(parentTask.id);
    assert.equal(inProgressTask?.status, "in_progress");
    assert.match(inProgressTask?.outputSummary ?? "", /等待结果回流/);

    await service.completeSubagentRun({
      id: delegated.run.id,
      status: "completed",
      resultSummary: "已总结出 2 个高优先级风险点",
    });

    const completedTask = store.tasksMap.get(parentTask.id);
    assert.equal(completedTask?.status, "done");
    assert.equal(completedTask?.outputSummary, "已总结出 2 个高优先级风险点");
  });

  test("可以回放 subagent run 的 child artifacts", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
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
      summary: {
        shortSummary: "等待结果",
        openLoops: ["继续阅读剩余模块"],
        nextActions: ["总结结果"],
        importantFacts: ["child session 有工具调用"],
      },
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
      title: "调用子代理",
      status: "in_progress",
      inputSummary: "把风险读一遍",
      outputSummary: "等待子代理回流",
      createdAt: now,
      updatedAt: now,
    };
    const childTask: Task = {
      id: "task_child",
      goalId: childGoal.id,
      sessionId: childSession.id,
      ownerAgent: "explore",
      title: "读代码",
      status: "done",
      inputSummary: "只读分析 controller",
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
      resultSummary: "已找到 2 个风险点",
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

    let sequence = 0;
    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_${++sequence}`,
    });

    await service.appendMessage({
      sessionId: childSession.id,
      role: "assistant",
      content: "已经总结出 controller 的两个潜在风险点",
    });
    await service.createCheckpoint({
      sessionId: childSession.id,
      node: "execute",
      stateJson: JSON.stringify({ phase: "execute", child: true }),
      summary: "执行阶段已记录",
    });
    await store.toolInvocations.start({
      id: "tool_invocation_1",
      sessionId: childSession.id,
      subagentRunId: run.id,
      toolName: "grep",
      inputJson: JSON.stringify({ query: "TODO" }),
      status: "started",
      createdAt: now,
      updatedAt: now,
    });
    await store.toolInvocations.finish(
      "tool_invocation_1",
      "completed",
      JSON.stringify({ matches: 2 }),
      now,
    );

    const replay = await service.getSubagentRunReplay(run.id);

    assert.equal(replay.run.id, run.id);
    assert.equal(replay.parentSession.id, parentSession.id);
    assert.equal(replay.childSession.id, childSession.id);
    assert.equal(replay.parentTask?.id, parentTask.id);
    assert.equal(replay.childGoal?.id, childGoal.id);
    assert.equal(replay.childTasks.length, 1);
    assert.equal(replay.childMessages.length, 1);
    assert.equal(replay.childCheckpoints.length, 1);
    assert.equal(replay.childToolInvocations.length, 1);
    assert.equal(replay.childToolInvocations[0]?.subagentRunId, run.id);
  });

  test("cleanupChildSessions 会归档已结束 child session，并跳过仍在运行的 child session", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    const completedChildSession: Session = {
      id: "session_child_completed",
      workspaceId: workspace.id,
      parentSessionId: parentSession.id,
      title: "completed child",
      status: "active",
      activeAgentMode: "explore",
      activeGoalId: "goal_completed",
      summary: {
        shortSummary: "",
        openLoops: ["等待收尾"],
        nextActions: ["归档前整理结果"],
        importantFacts: ["已完成探索"],
      },
      createdAt: now,
      updatedAt: now,
    };
    const runningChildSession: Session = {
      id: "session_child_running",
      workspaceId: workspace.id,
      parentSessionId: parentSession.id,
      title: "running child",
      status: "active",
      activeAgentMode: "explore",
      summary: {
        shortSummary: "still running",
        openLoops: ["还有模块没看"],
        nextActions: ["继续 grep"],
        importantFacts: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    const completedGoal: Goal = {
      id: "goal_completed",
      workspaceId: workspace.id,
      sessionId: completedChildSession.id,
      title: "完成探索",
      description: "找出风险点",
      successCriteria: ["有结果摘要"],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const completedRun: SubagentRun = {
      id: "subagent_run_completed",
      parentSessionId: parentSession.id,
      childSessionId: completedChildSession.id,
      agentMode: "explore",
      status: "completed",
      reason: "只读探索",
      inputSummary: "读 controller",
      resultSummary: "已经总结结果",
      createdAt: now,
      updatedAt: "2026-03-21T10:05:00.000Z",
    };
    const runningRun: SubagentRun = {
      id: "subagent_run_running",
      parentSessionId: parentSession.id,
      childSessionId: runningChildSession.id,
      agentMode: "explore",
      status: "running",
      reason: "继续 grep",
      inputSummary: "还在处理中",
      createdAt: now,
      updatedAt: "2026-03-21T10:06:00.000Z",
    };

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.sessionsMap.set(completedChildSession.id, completedChildSession);
    store.sessionsMap.set(runningChildSession.id, runningChildSession);
    store.goalsMap.set(completedGoal.id, completedGoal);
    store.subagentRunsMap.set(completedRun.id, completedRun);
    store.subagentRunsMap.set(runningRun.id, runningRun);

    const service = new GoalDrivenRuntimeService(store, {
      now: () => "2026-03-21T10:10:00.000Z",
      createId: (prefix: string) => `${prefix}_fixed`,
    });

    const result = await service.cleanupChildSessions({
      parentSessionId: parentSession.id,
    });

    assert.deepEqual(result.archivedChildSessionIds, [completedChildSession.id]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.childSessionId, runningChildSession.id);
    assert.match(result.skipped[0]?.reason ?? "", /还未结束/);

    const archivedSession = store.sessionsMap.get(completedChildSession.id);
    assert.equal(archivedSession?.status, "archived");
    assert.deepEqual(archivedSession?.summary.openLoops, []);
    assert.deepEqual(archivedSession?.summary.nextActions, []);

    const stillRunningSession = store.sessionsMap.get(runningChildSession.id);
    assert.equal(stillRunningSession?.status, "active");

    const updatedGoal = store.goalsMap.get(completedGoal.id);
    assert.equal(updatedGoal?.status, "completed");
  });

  test("completeSubagentRun 可以按策略自动 cleanup child session", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
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
      summary: {
        shortSummary: "等待结果",
        openLoops: ["待收尾"],
        nextActions: ["等父会话吸收"],
        importantFacts: [],
      },
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
    const subagentRun: SubagentRun = {
      id: "subagent_run_1",
      parentSessionId: parentSession.id,
      childSessionId: childSession.id,
      agentMode: "explore",
      status: "running",
      reason: "读代码找风险",
      inputSummary: "只读分析",
      createdAt: now,
      updatedAt: now,
    };

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(parentSession.id, parentSession);
    store.sessionsMap.set(childSession.id, childSession);
    store.goalsMap.set(childGoal.id, childGoal);
    store.subagentRunsMap.set(subagentRun.id, subagentRun);

    const service = new GoalDrivenRuntimeService(store, {
      now: () => "2026-03-21T10:10:00.000Z",
      createId: (prefix: string) => `${prefix}_fixed`,
    });

    const result = await service.completeSubagentRun({
      id: subagentRun.id,
      status: "completed",
      resultSummary: "已收集完成",
      cleanupPolicy: {
        maxAgeMs: 0,
        requireResultSummary: true,
      },
    });

    assert.deepEqual(result.cleanup?.archivedChildSessionIds, [childSession.id]);
    assert.equal(store.sessionsMap.get(childSession.id)?.status, "archived");
    assert.equal(store.goalsMap.get(childGoal.id)?.status, "completed");
  });

  test("getParentTaskExecutionTrace 会聚合 direct tool invocations 和 delegated replay", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T10:00:00.000Z";
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
      summary: {
        shortSummary: "父 session",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
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
      summary: {
        shortSummary: "等待结果",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    const parentTask: Task = {
      id: "task_parent",
      goalId: "goal_parent",
      sessionId: parentSession.id,
      ownerAgent: "build",
      title: "追踪 delegation",
      status: "in_progress",
      inputSummary: "看 delegation trace",
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
      outputSummary: "已整理风险点",
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

    const trace = await service.getParentTaskExecutionTrace(parentTask.id);

    assert.equal(trace.parentTask.id, parentTask.id);
    assert.equal(trace.directToolInvocations.length, 1);
    assert.equal(trace.directToolInvocations[0]?.toolName, "bash");
    assert.equal(trace.delegatedReplays.length, 1);
    assert.equal(trace.delegatedReplays[0]?.run.id, run.id);
    assert.equal(trace.delegatedReplays[0]?.childToolInvocations.length, 1);
    assert.equal(trace.delegatedReplays[0]?.childToolInvocations[0]?.toolName, "grep");
  });
});
