import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
import type {
  LangGraphCheckpointRepository,
  SerializedCheckpointRecord,
  SerializedCheckpointWriteRecord,
} from "@agent-ide/db";
import { PersistentLangGraphCheckpointSaver } from "@agent-ide/db";
import { createAgentLangGraph } from "./langgraph.js";
import { GoalDrivenRuntimeService } from "./service.js";
import { RuntimeToolExecutor } from "./tooling.js";
import { createBuiltinToolRegistry } from "@agent-ide/tools";

class InMemoryLangGraphCheckpointRepository implements LangGraphCheckpointRepository {
  checkpointRows: SerializedCheckpointRecord[] = [];
  writeRows: SerializedCheckpointWriteRecord[] = [];

  async getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId?: string,
  ): Promise<SerializedCheckpointRecord | null> {
    const rows = this.checkpointRows
      .filter(
        (row) =>
          row.threadId === threadId &&
          row.checkpointNs === checkpointNs &&
          (checkpointId ? row.checkpointId === checkpointId : true),
      )
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));

    return rows[0] ?? null;
  }

  async listCheckpoints(filter?: {
    threadId?: string;
    checkpointNs?: string;
    checkpointId?: string;
    beforeCheckpointId?: string;
    limit?: number;
  }): Promise<SerializedCheckpointRecord[]> {
    const rows = this.checkpointRows
      .filter((row) => {
        if (filter?.threadId && row.threadId !== filter.threadId) {
          return false;
        }

        if (filter?.checkpointNs !== undefined && row.checkpointNs !== filter.checkpointNs) {
          return false;
        }

        if (filter?.checkpointId && row.checkpointId !== filter.checkpointId) {
          return false;
        }

        if (filter?.beforeCheckpointId && row.checkpointId >= filter.beforeCheckpointId) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));

    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async putCheckpoint(record: SerializedCheckpointRecord): Promise<void> {
    this.checkpointRows = this.checkpointRows.filter(
      (row) =>
        !(
          row.threadId === record.threadId &&
          row.checkpointNs === record.checkpointNs &&
          row.checkpointId === record.checkpointId
        ),
    );
    this.checkpointRows.push(record);
  }

  async listWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<SerializedCheckpointWriteRecord[]> {
    return this.writeRows
      .filter(
        (row) =>
          row.threadId === threadId && row.checkpointNs === checkpointNs && row.checkpointId === checkpointId,
      )
      .sort((left, right) => {
        const taskComparison = left.taskId.localeCompare(right.taskId);
        if (taskComparison !== 0) {
          return taskComparison;
        }

        return left.writeIdx - right.writeIdx;
      });
  }

  async putWrite(record: SerializedCheckpointWriteRecord, overwrite: boolean): Promise<void> {
    const existingIndex = this.writeRows.findIndex(
      (row) =>
        row.threadId === record.threadId &&
        row.checkpointNs === record.checkpointNs &&
        row.checkpointId === record.checkpointId &&
        row.taskId === record.taskId &&
        row.writeIdx === record.writeIdx,
    );

    if (existingIndex >= 0) {
      if (overwrite) {
        this.writeRows.splice(existingIndex, 1, record);
      }
      return;
    }

    this.writeRows.push(record);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.checkpointRows = this.checkpointRows.filter((row) => row.threadId !== threadId);
    this.writeRows = this.writeRows.filter((row) => row.threadId !== threadId);
  }
}

class InMemoryRuntimeStore implements RuntimeStore {
  readonly workspacesMap = new Map<string, Workspace>();
  readonly sessionsMap = new Map<string, Session>();
  readonly goalsMap = new Map<string, Goal>();
  readonly plansMap = new Map<string, Plan>();
  readonly tasksMap = new Map<string, Task>();
  readonly memoryMap = new Map<string, MemoryRecord>();
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
    create: async (record: MemoryRecord) => {
      this.memoryMap.set(record.id, record);
    },
    listByScope: async (workspaceId: string, scope: MemoryRecord["scope"], sessionId?: string) =>
      Array.from(this.memoryMap.values()).filter(
        (record) =>
          record.workspaceId === workspaceId &&
          record.scope === scope &&
          (sessionId ? record.sessionId === sessionId : true),
      ),
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

describe("AgentLangGraphRuntime", () => {
  test("可以用 LangGraph 编排 goal / plan / delegate / execute / review / summarize", async () => {
    const store = new InMemoryRuntimeStore();
    const now = "2026-03-21T12:00:00.000Z";
    const workspace: Workspace = {
      id: "workspace_1",
      path: "/tmp/project",
      label: "project",
      createdAt: now,
      updatedAt: now,
    };
    const session: Session = {
      id: "session_1",
      workspaceId: workspace.id,
      title: "main",
      status: "active",
      activeAgentMode: "build",
      summary: {
        shortSummary: "",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      },
      createdAt: now,
      updatedAt: now,
    };

    store.workspacesMap.set(workspace.id, workspace);
    store.sessionsMap.set(session.id, session);

    let sequence = 0;
    const service = new GoalDrivenRuntimeService(store, {
      now: () => now,
      createId: (prefix: string) => `${prefix}_${++sequence}`,
    });
    const langGraphCheckpointer = new PersistentLangGraphCheckpointSaver(
      new InMemoryLangGraphCheckpointRepository(),
    );

    const runtime = createAgentLangGraph(service, {
      checkpointer: langGraphCheckpointer,
      hooks: {
        goalFactory: async () => ({
          title: "把 LangGraph 接到 runtime 上",
          description: "让 graph 能驱动 service 层，而不是只停留在概念文档",
          successCriteria: ["能创建 plan", "能留下 checkpoint", "能走到 review"],
        }),
        planner: async () => ({
          summary: "先接 graph，再验证 orchestration",
          status: "ready",
          steps: [
            {
              title: "创建 goal",
              description: "保证 session 有 active goal",
              status: "done",
            },
            {
              title: "驱动编排",
              description: "让 graph 节点落到 service 调用",
              status: "in_progress",
            },
          ],
        }),
        delegate: async () => ({
          agentMode: "explore",
          reason: "先做只读探索，看看 runtime 还有哪些缺口",
          inputSummary: "只做只读分析，不改文件",
          inheritActiveGoal: true,
        }),
        executor: async () => ({
          assistantMessage: "LangGraph 已经把执行结果吸收到 runtime service。",
          tasks: [
            {
              title: "记录 LangGraph 接入结果",
              inputSummary: "把 graph orchestration 的状态写入 task",
              status: "in_progress",
            },
          ],
          memory: [
            {
              scope: "session",
              key: "langgraph_adapter",
              value: "已接最小 graph adapter",
              source: "assistant",
            },
          ],
        }),
        reviewer: async () => ({
          satisfied: false,
          reasons: ["子代理已经发出，但还没有完整结果回流闭环"],
          remainingRisks: ["等待 child session 进一步执行"],
          recommendedNextStep: "继续补子代理结果回放和更复杂 orchestration",
        }),
        summarizer: async () => ({
          shortSummary: "LangGraph 最小编排已接入",
          openLoops: ["继续补子代理 orchestration"],
          nextActions: ["把 LangGraph checkpointer 从 MemorySaver 往持久化推进"],
          importantFacts: ["graph 现在已经会调用 runtime service"],
        }),
      },
    });

    const result = await runtime.invoke({
      sessionId: session.id,
      userMessage: "把 LangGraph 接上去",
    });

    assert.equal(result.sessionId, session.id);
    assert.ok(result.runtimeState);
    assert.equal(result.runtimeState?.activeGoal.title, "把 LangGraph 接到 runtime 上");
    assert.equal(result.runtimeState?.currentPlan?.summary, "先接 graph，再验证 orchestration");
    assert.equal(result.runtimeState?.activeGoal.status, "blocked");
    assert.equal(result.runtimeState?.subagentRuns.length, 1);
    assert.equal(result.runtimeState?.tasks.length, 1);
    assert.equal(result.runtimeState?.memory.length, 1);
    assert.match(result.executionLog.join("\n"), /summarize: 已更新 session summary/);

    const childSessions = await service.listChildSessions(session.id);
    assert.equal(childSessions.length, 1);
    assert.equal(childSessions[0]?.activeAgentMode, "explore");

    const checkpoints = await store.checkpoints.listBySession(session.id);
    assert.equal(checkpoints.length, 8);

    const threadState = await runtime.getThreadState(session.id);
    assert.equal(threadState.values.sessionId, session.id);
    assert.ok(Array.isArray(threadState.values.executionLog));
    assert.ok(threadState.values.executionLog.length >= 8);

    const updatedSession = await store.sessions.getById(session.id);
    assert.equal(updatedSession?.summary.shortSummary, "LangGraph 最小编排已接入");
  });

  test("executor 请求工具调用时，会真实执行 view/edit 并改动工作区文件", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-tool-loop-"));

    try {
      const targetPath = path.join(tempRoot, "bootstrap.ts");
      await writeFile(
        targetPath,
        [
          "export async function createIdeRuntimeEnvironment() {",
          "  const config = readPersistenceConfig();",
          "  return config;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-22T02:00:00.000Z";
      const workspace: Workspace = {
        id: "workspace_tool_loop",
        path: tempRoot,
        label: "tool-loop",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_tool_loop",
        workspaceId: workspace.id,
        title: "tool loop session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      let scriptedStep = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(store, createBuiltinToolRegistry(), () => now, (prefix) => `${prefix}_${++sequence}`),
        hooks: {
          goalFactory: async () => ({
            title: "给 bootstrap.ts 加注释",
            description: "通过真实工具循环读取并编辑 bootstrap.ts",
            successCriteria: ["先读文件", "再改文件", "最终给出结果总结"],
          }),
          planner: async () => ({
            summary: "先读取 bootstrap.ts，再用 edit 工具插入两行注释。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "读取 bootstrap.ts",
                description: "先确认文件内容和插入位置。",
                status: "todo",
              },
              {
                id: "plan_step_edit",
                title: "插入两行注释",
                description: "在函数体开头补上两行注释。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;

            if (executorCallCount === 1) {
              return {
                assistantMessage: "先读取 bootstrap.ts，确认插入注释的位置。",
                tasks: [
                  {
                    id: "plan_step_view",
                    title: "读取 bootstrap.ts",
                    inputSummary: "读取 bootstrap.ts，确认文件结构。",
                    status: "in_progress",
                  },
                ],
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先看文件内容，避免盲改。",
                    input: {
                      path: "bootstrap.ts",
                    },
                  },
                ],
              };
            }

            if (executorCallCount === 2) {
              const sawViewOutput = state.messages.some(
                (message) => message.role === "tool" && message.content.includes("tool=view"),
              );
              assert.equal(sawViewOutput, true);

              return {
                assistantMessage: "已读取文件，准备插入两行注释。",
                tasks: [
                  {
                    id: "plan_step_edit",
                    title: "插入两行注释",
                    inputSummary: "在函数体开头插入两行说明持久化顺序的注释。",
                    status: "in_progress",
                  },
                ],
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "基于刚读到的内容做局部替换，避免整文件覆盖。",
                    input: {
                      path: "bootstrap.ts",
                      search: "export async function createIdeRuntimeEnvironment() {\n  const config = readPersistenceConfig();",
                      replace:
                        "export async function createIdeRuntimeEnvironment() {\n  // 先读取持久化配置，确保 runtime 启动顺序稳定。\n  // 后续再连接 Redis，避免把热缓存误当成真相源。\n  const config = readPersistenceConfig();",
                    },
                  },
                ],
              };
            }

            return {
              assistantMessage: "已通过真实工具循环完成注释插入。",
              tasks: [
                {
                  id: "plan_step_view",
                  title: "读取 bootstrap.ts",
                  inputSummary: "读取 bootstrap.ts，确认文件结构。",
                  status: "done",
                },
                {
                  id: "plan_step_edit",
                  title: "插入两行注释",
                  inputSummary: "在函数体开头插入两行说明持久化顺序的注释。",
                  outputSummary: "注释已写入 bootstrap.ts。",
                  status: "done",
                },
              ],
              memory: [
                {
                  scope: "session",
                  key: "tool_loop",
                  value: "LangGraph execute 已接入真实工具循环",
                  source: "tool",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["目标文件已经被真实编辑，且执行链路留下了工具记录。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "真实工具循环已经跑通",
            openLoops: [],
            nextActions: ["继续扩展更多工具和更复杂的多轮执行"],
            importantFacts: ["executor 已可通过 toolCalls 触发真实工具"],
          }),
        },
      });

      const result = await runtime.invoke({
        sessionId: session.id,
        userMessage: "在 bootstrap.ts 里加两行注释",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /先读取持久化配置/);
      assert.match(finalContent, /后续再连接 Redis/);
      assert.equal(executorCallCount, 3);
      assert.match(result.executionLog.join("\n"), /execute: 已执行 2 次工具调用/);

      const toolLogs = await store.toolInvocations.listBySession(session.id);
      assert.equal(toolLogs.length, 2);
      assert.equal(toolLogs[0]?.toolName, "view");
      assert.equal(toolLogs[1]?.toolName, "edit");

      const toolMessages = await store.messages.listBySession(session.id);
      assert.equal(toolMessages.some((message) => message.role === "tool" && message.content.includes("tool=view")), true);
      assert.equal(toolMessages.some((message) => message.role === "tool" && message.content.includes("tool=edit")), true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("重复的相同工具调用会被 loop guard 拦截，并推动 executor 改用 edit", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-tool-guard-"));

    try {
      const targetPath = path.join(tempRoot, "bootstrap.ts");
      await writeFile(
        targetPath,
        [
          "export async function createIdeRuntimeEnvironment() {",
          "  const config = readPersistenceConfig();",
          "  return config;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-22T03:40:00.000Z";
      const workspace: Workspace = {
        id: "workspace_tool_guard",
        path: tempRoot,
        label: "tool-guard",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_tool_guard",
        workspaceId: workspace.id,
        title: "tool guard session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      let scriptedStep = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "避免重复 view 循环",
            description: "先读取文件，再在 loop guard 之后改用 edit。",
            successCriteria: ["重复 view 会被拦截", "后续可以继续 edit", "最终文件被真实修改"],
          }),
          planner: async () => ({
            summary: "先读取 bootstrap.ts，如果重复读取就触发 loop guard，再继续 edit。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "读取 bootstrap.ts",
                description: "确认函数体内容。",
                status: "todo",
              },
              {
                id: "plan_step_edit",
                title: "插入注释",
                description: "在函数体开头插入两行注释。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=view"),
            );
            const sawLoopGuard = state.messages.some(
              (message) => message.role === "system" && message.content.includes("LOOP_GUARD"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );

            if (!sawView) {
              return {
                assistantMessage: "正在读取 bootstrap.ts。",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先读取文件，确认插入位置。",
                    input: {
                      path: "bootstrap.ts",
                    },
                  },
                ],
              };
            }

            if (!sawLoopGuard) {
              return {
                assistantMessage: "正在基于已读取内容继续处理。",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "错误地重复读取同一个文件。",
                    input: {
                      path: "bootstrap.ts",
                    },
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "收到 loop guard 之后，改用 edit 完成局部修改。",
                    input: {
                      path: "bootstrap.ts",
                      search: "export async function createIdeRuntimeEnvironment() {\n  const config = readPersistenceConfig();",
                      replace:
                        "export async function createIdeRuntimeEnvironment() {\n  // loop guard 已阻止重复读取。\n  // 接下来直接做局部编辑。\n  const config = readPersistenceConfig();",
                    },
                  },
                ],
              };
            }

            return {
              assistantMessage: "已完成文件修改，没有再重复读取同一个文件。",
              tasks: [
                {
                  id: "plan_step_view",
                  title: "读取 bootstrap.ts",
                  inputSummary: "确认函数体内容。",
                  status: "done",
                },
                {
                  id: "plan_step_edit",
                  title: "插入注释",
                  inputSummary: "在函数体开头插入两行注释。",
                  outputSummary: "loop guard 后已改用 edit 完成修改。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["重复工具调用已被拦截，文件也已经被真实修改。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "loop guard 已阻止重复 view 循环",
            openLoops: [],
            nextActions: ["继续扩展更复杂的工具循环策略"],
            importantFacts: ["execute 节点已能拦截重复工具调用"],
          }),
        },
      });

      const result = await runtime.invoke({
        sessionId: session.id,
        userMessage: "在 bootstrap.ts 里加两行注释看看",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /loop guard 已阻止重复读取/);
      assert.match(finalContent, /接下来直接做局部编辑/);
      assert.equal(executorCallCount, 4);
      assert.match(result.executionLog.join("\n"), /拦截了 1 次重复工具调用/);

      const toolLogs = await store.toolInvocations.listBySession(session.id);
      assert.equal(toolLogs.length, 2);
      assert.equal(toolLogs[0]?.toolName, "view");
      assert.equal(toolLogs[1]?.toolName, "edit");

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some((message) => message.role === "system" && message.content.includes("LOOP_GUARD")),
        true,
      );
      assert.equal(
        messages.some((message) => message.role === "assistant" && message.content.includes("正在读取 bootstrap.ts")),
        false,
      );
      assert.equal(
        messages.some((message) => message.role === "assistant" && message.content.includes("已完成文件修改")),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("完整读取后允许 1 次 focused reread，第 3 次 reread 会被 budget guard 拦截，并继续推进 edit", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-tool-view-budget-"));

    try {
      const targetPath = path.join(tempRoot, "browser.test.ts");
      await writeFile(
        targetPath,
        [
          "import assert from \"node:assert/strict\";",
          "import { describe, test } from \"node:test\";",
          "",
          "describe(\"browser runtime\", () => {",
          "  test(\"works\", () => {",
          "    assert.equal(1, 1);",
          "  });",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-22T11:05:00.000Z";
      const workspace: Workspace = {
        id: "workspace_view_path_guard",
        path: tempRoot,
        label: "view-path-guard",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_view_path_guard",
        workspaceId: workspace.id,
        title: "view path guard session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      let scriptedStep = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "控制同一路径的 reread 预算",
            description: "完整读取一次后，允许 1 次 focused reread，第 3 次再拦截。",
            successCriteria: ["允许 1 次 focused reread", "第 3 次 reread 会被拦截", "后续仍能 edit"],
          }),
          planner: async () => ({
            summary: "先完整读取，再做 1 次 focused reread，第 3 次 reread 被 budget guard 拦下，然后改用 edit。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "完整读取 browser.test.ts",
                description: "先拿到完整文件内容。",
                status: "todo",
              },
              {
                id: "plan_step_reread",
                title: "做 1 次 focused reread",
                description: "只补充查看局部断言片段。",
                status: "todo",
              },
              {
                id: "plan_step_edit",
                title: "加两行注释",
                description: "在 import 顶部前插入两行说明注释。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=view"),
            );
            const sawFocusedReread = state.messages.some(
              (message) =>
                message.role === "tool" &&
                message.content.includes("tool=view") &&
                message.content.includes("lineRange=4-6"),
            );
            const sawBudgetGuard = state.messages.some(
              (message) =>
                message.role === "system" &&
                message.content.includes("不满足 reread policy"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先完整读取文件。",
                    input: {
                      path: "browser.test.ts",
                    },
                  },
                ],
              };
            }

            if (!sawFocusedReread) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_reread",
                    reasoning: "完整读取后，补一小段断言上下文做精读。",
                    input: {
                      path: "browser.test.ts",
                      startLine: 4,
                      endLine: 6,
                    },
                  },
                ],
              };
            }

            if (!sawBudgetGuard) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_reread",
                    reasoning: "错误地再做一次 focused reread，应该被预算 guard 拦下。",
                    input: {
                      path: "browser.test.ts",
                      offset: 1,
                      limit: 3,
                    },
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "收到 budget guard 之后，直接 edit。",
                    input: {
                      path: "browser.test.ts",
                      search: "import assert from \"node:assert/strict\";",
                      replace:
                        "// 这个测试文件主要覆盖 browser runtime 的导航和文档输出。\n// 这里额外补两行注释，验证 budgeted reread 之后的 edit 流程。\nimport assert from \"node:assert/strict\";",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经先解释测试文件职责，再完成注释修改。",
              tasks: [
                {
                  id: "plan_step_view",
                  title: "完整读取 browser.test.ts",
                  inputSummary: "先拿到完整文件内容。",
                  status: "done",
                },
                {
                  id: "plan_step_reread",
                  title: "做 1 次 focused reread",
                  inputSummary: "只补充查看局部断言片段。",
                  outputSummary: "完整读取后允许 1 次 focused reread，第 3 次 reread 被 budget guard 拦下。",
                  status: "done",
                },
                {
                  id: "plan_step_edit",
                  title: "加两行注释",
                  inputSummary: "在 import 顶部前插入两行说明注释。",
                  outputSummary: "focused reread 预算用尽后，直接完成 edit。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["完整读取后允许 1 次 focused reread，第 3 次 reread 被预算 guard 拦截，并成功完成 edit。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "budgeted reread policy 已阻止第 3 次读取",
            openLoops: [],
            nextActions: ["继续增强 mixed explain + edit 任务的执行策略"],
            importantFacts: ["完整读取后允许 1 次 focused reread", "第 3 次 reread 会被 guard 拦下"],
          }),
        },
      });

      const result = await runtime.invoke({
        sessionId: session.id,
        userMessage: "先解释这个测试文件在测什么，然后再加两行注释说明",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /这个测试文件主要覆盖 browser runtime 的导航和文档输出/);
      assert.match(finalContent, /budgeted reread 之后的 edit 流程/);
      assert.equal(executorCallCount, 5);
      assert.match(result.executionLog.join("\n"), /拦截了 1 次重复工具调用/);

      const toolLogs = await store.toolInvocations.listBySession(session.id);
      assert.equal(toolLogs.length, 3);
      assert.equal(toolLogs[0]?.toolName, "view");
      assert.equal(toolLogs[1]?.toolName, "view");
      assert.equal(toolLogs[2]?.toolName, "edit");

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
                message.role === "system" &&
                message.content.includes("不满足 reread policy"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("tool=view") &&
            message.content.includes("lineRange=4-6"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
                message.role === "assistant" &&
                message.content.includes("已经先解释测试文件职责，再完成注释修改"),
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("失败的重复工具调用不会被误判成成功循环 guard", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-tool-failed-guard-"));

    try {
      const targetPath = path.join(tempRoot, "bootstrap.ts");
      await writeFile(
        targetPath,
        [
          "export async function createIdeRuntimeEnvironment() {",
          "  const config = readPersistenceConfig();",
          "  return config;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-22T03:55:00.000Z";
      const workspace: Workspace = {
        id: "workspace_failed_guard",
        path: tempRoot,
        label: "failed-guard",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_failed_guard",
        workspaceId: workspace.id,
        title: "failed guard session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "验证失败工具不会误触发 guard",
            description: "连续失败的 edit 不应该马上被 loop guard 拦截。",
            successCriteria: ["失败工具可被记录", "不会误触发 loop guard"],
          }),
          planner: async () => ({
            summary: "先故意触发失败 edit，再确认没有误触发 guard。",
            status: "ready",
            steps: [],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const failedToolMessages = state.messages.filter(
              (message) => message.role === "tool" && message.content.includes("未找到要替换的内容"),
            );
            if (failedToolMessages.length < 2) {
              return {
                toolCalls: [
                  {
                    name: "edit",
                    reasoning: "故意用错误 search，验证失败调用不会马上触发 loop guard。",
                    input: {
                      path: "bootstrap.ts",
                      search: "missing line",
                      replace: "replacement",
                    },
                  },
                ],
              };
            }

            return {
              assistantMessage: "已经看到连续失败的工具调用，当前没有误触发 loop guard。",
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["失败工具调用被正常记录，没有被误判为成功重复调用。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "失败工具调用不会误触发 loop guard",
            openLoops: [],
            nextActions: [],
            importantFacts: ["只有成功的重复工具调用才会触发 loop guard"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "测试失败 edit 的 guard 行为",
      });

      const toolLogs = await store.toolInvocations.listBySession(session.id);
      assert.equal(toolLogs.length, 2);
      assert.equal(toolLogs.every((log) => log.status === "failed"), true);
      assert.equal(executorCallCount, 3);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some((message) => message.role === "system" && message.content.includes("LOOP_GUARD")),
        false,
      );
      assert.equal(
        messages.some((message) => message.role === "assistant" && message.content.includes("没有误触发 loop guard")),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("mixed explain + edit 请求里，explain phase 不能提前收尾，runtime 会强制继续 modify", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-mixed-explain-edit-"));

    try {
      const targetPath = path.join(tempRoot, "browser.test.ts");
      await writeFile(
        targetPath,
        [
          "import assert from \"node:assert/strict\";",
          "import { describe, test } from \"node:test\";",
          "",
          "describe(\"ide browser runtime\", () => {",
          "  test(\"works\", () => {",
          "    assert.equal(1, 1);",
          "  });",
          "});",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-23T02:30:00.000Z";
      const workspace: Workspace = {
        id: "workspace_mixed_explain_edit",
        path: tempRoot,
        label: "mixed-explain-edit",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_mixed_explain_edit",
        workspaceId: workspace.id,
        title: "mixed explain edit session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "先解释再修改测试文件",
            description: "解释 browser.test.ts 在测什么，然后真的补两行注释。",
            successCriteria: ["会解释测试职责", "会真实修改文件"],
          }),
          planner: async () => ({
            summary: "先读文件拿上下文，再解释，再补注释。",
            status: "ready",
            steps: [
              {
                id: "plan_step_explain",
                title: "解释 browser.test.ts",
                description: "说明它在测 browser runtime 的导航和文档输出。",
                status: "in_progress",
              },
              {
                id: "plan_step_edit",
                title: "补两行注释",
                description: "在文件顶部插入说明注释。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=view"),
            );
            const sawPolicyNudge = state.messages.some(
              (message) =>
                message.role === "system" &&
                message.content.includes("EXECUTION_POLICY: 用户请求同时包含解释和修改"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_explain",
                    reasoning: "先读取测试文件拿上下文。",
                    input: {
                      path: "browser.test.ts",
                      startLine: 1,
                      endLine: 8,
                    },
                  },
                ],
              };
            }

            if (!sawPolicyNudge) {
              return {
                executionPhase: "explain",
                assistantMessage:
                  "browser.test.ts 主要在测 browser runtime 的导航参数解析、data-action 还原，以及最终 IDE 文档渲染。",
                tasks: [
                  {
                    id: "plan_step_explain",
                    title: "解释 browser.test.ts",
                    inputSummary: "说明它在测 browser runtime 的导航和文档输出。",
                    outputSummary: "已经完成测试职责解释。",
                    status: "done",
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "解释完成后，继续落真实注释修改。",
                    input: {
                      path: "browser.test.ts",
                      search: "import assert from \"node:assert/strict\";",
                      replace:
                        "// 这个测试文件主要覆盖 browser runtime 的导航和文档渲染。\n// 这里补两行注释，验证 mixed explain + edit 不会提前收尾。\nimport assert from \"node:assert/strict\";",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经先解释测试内容，再补上两行注释。",
              tasks: [
                {
                  id: "plan_step_edit",
                  title: "补两行注释",
                  inputSummary: "在文件顶部插入说明注释。",
                  outputSummary: "已在解释完成后真实修改文件。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["解释已给出，文件也已经被真实修改。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "mixed explain + edit 已走完两阶段执行",
            openLoops: [],
            nextActions: [],
            importantFacts: ["runtime 不会在 explain phase 提前收尾"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage:
          "我没看懂 browser.test.ts 在测试什么，先解释一下，然后再加两行注释说明。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /这个测试文件主要覆盖 browser runtime 的导航和文档渲染/);
      assert.match(finalContent, /mixed explain \+ edit 不会提前收尾/);
      assert.equal(executorCallCount, 4);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("EXECUTION_POLICY: 用户请求同时包含解释和修改"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant"
            && message.content.includes("主要在测 browser runtime 的导航参数解析"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant" && message.content.includes("已经先解释测试内容，再补上两行注释"),
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("mixed explain + edit 请求里，即使模型声称进入 modify phase，但没有发 edit/write，runtime 仍会继续追 modify", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-empty-modify-phase-"));

    try {
      const targetPath = path.join(tempRoot, "browser.test.ts");
      await writeFile(
        targetPath,
        [
          "import assert from \"node:assert/strict\";",
          "import { describe, test } from \"node:test\";",
          "",
          "describe(\"ide browser runtime\", () => {",
          "  test(\"works\", () => {",
          "    assert.equal(1, 1);",
          "  });",
          "});",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-25T11:20:00.000Z";
      const workspace: Workspace = {
        id: "workspace_empty_modify_phase",
        path: tempRoot,
        label: "empty-modify-phase",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_empty_modify_phase",
        workspaceId: workspace.id,
        title: "empty modify phase session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "modify phase 不能空转",
            description: "如果模型说自己进入 modify phase，但没有真的发 edit/write，runtime 仍要继续追到真实修改。",
            successCriteria: ["空 modify phase 不会直接收尾", "后续会真实 edit 文件"],
          }),
          planner: async () => ({
            summary: "先读文件，再模拟一个空 modify phase，最后真正 edit。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "读取文件",
                description: "拿到文件上下文。",
                status: "in_progress",
              },
              {
                id: "plan_step_edit",
                title: "补注释",
                description: "真的修改文件。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=view"),
            );
            const sawPolicyNudge = state.messages.some(
              (message) =>
                message.role === "system"
                && message.content.includes("EXECUTION_POLICY: 用户请求同时包含解释和修改"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先读取文件。",
                    input: {
                      path: "browser.test.ts",
                      startLine: 1,
                      endLine: 8,
                    },
                  },
                ],
              };
            }

            if (!sawPolicyNudge) {
              return {
                executionPhase: "modify",
                assistantMessage: "我已经知道要改文件顶部 import 之前，但这轮故意不发 edit。",
                tasks: [
                  {
                    id: "plan_step_view",
                    title: "读取文件",
                    inputSummary: "拿到文件上下文。",
                    outputSummary: "已经知道 import 顶部是修改锚点。",
                    status: "done",
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "runtime 已经追了 modify，这一轮必须真实改文件。",
                    input: {
                      path: "browser.test.ts",
                      search: "import assert from \"node:assert/strict\";",
                      replace:
                        "// 这里补一行注释，验证空 modify phase 不会直接收尾。\nimport assert from \"node:assert/strict\";",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "空 modify phase 已被 runtime 继续追到真实 edit。",
              tasks: [
                {
                  id: "plan_step_edit",
                  title: "补注释",
                  inputSummary: "真的修改文件。",
                  outputSummary: "空 modify phase 之后，runtime 继续推进到了真实 edit。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["模型虽然一度空转在 modify phase，但 runtime 最终仍推进到了真实 edit。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "空 modify phase 不会让 runtime 提前收尾",
            openLoops: [],
            nextActions: [],
            importantFacts: ["modify phase 必须对应真实 edit/write，不能只说不做"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "先看看这个文件，然后补一行注释。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /空 modify phase 不会直接收尾/);
      assert.equal(executorCallCount, 4);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant"
            && message.content.includes("这轮故意不发 edit"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("EXECUTION_POLICY: 用户请求同时包含解释和修改"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant"
            && message.content.includes("空 modify phase 已被 runtime 继续追到真实 edit"),
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("像 'Add a text parameter' 这类新增需求也会被视为待修改工作，不能在 explain 后提前收尾", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-add-parameter-"));

    try {
      const targetPath = path.join(tempRoot, "config.py");
      await writeFile(
        targetPath,
        [
          "def from_file(filename, load):",
          "    with open(filename) as f:",
          "        return load(f)",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-25T10:50:00.000Z";
      const workspace: Workspace = {
        id: "workspace_add_parameter",
        path: tempRoot,
        label: "add-parameter",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_add_parameter",
        workspaceId: workspace.id,
        title: "add parameter session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "Add a text parameter to from_file",
            description: "先读取 config.py，再为 from_file 添加 text 参数支持。",
            successCriteria: ["会定位 from_file", "会真实修改函数签名和 open 模式"],
          }),
          planner: async () => ({
            summary: "Add a text parameter to from_file and use it to choose the file mode.",
            status: "ready",
            steps: [
              {
                id: "plan_step_read",
                title: "Read the target function",
                description: "Locate from_file in config.py.",
                status: "in_progress",
              },
              {
                id: "plan_step_add_parameter",
                title: "Add a text parameter",
                description: "Change signature and open mode for binary/text loaders.",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=view"),
            );
            const sawPolicyNudge = state.messages.some(
              (message) =>
                message.role === "system" &&
                message.content.includes("EXECUTION_POLICY: 用户请求同时包含解释和修改"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_read",
                    reasoning: "先读完整函数内容。",
                    input: {
                      path: "config.py",
                    },
                  },
                ],
              };
            }

            if (!sawPolicyNudge) {
              return {
                executionPhase: "finalize",
                assistantMessage: "已经定位到 from_file，接下来理论上可以添加参数。",
                tasks: [
                  {
                    id: "plan_step_read",
                    title: "Read the target function",
                    inputSummary: "Locate from_file in config.py.",
                    outputSummary: "已完成定位。",
                    status: "done",
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_add_parameter",
                    reasoning: "收到策略提示后，进入真实修改。",
                    input: {
                      path: "config.py",
                      search: "def from_file(filename, load):\n    with open(filename) as f:\n        return load(f)",
                      replace:
                        "def from_file(filename, load, text=True):\n    mode = \"r\" if text else \"rb\"\n    with open(filename, mode) as f:\n        return load(f)",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经添加 text 参数并调整文件打开模式。",
              tasks: [
                {
                  id: "plan_step_add_parameter",
                  title: "Add a text parameter",
                  inputSummary: "Change signature and open mode for binary/text loaders.",
                  outputSummary: "已完成真实修改。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["新增需求被识别为真实修改工作，并且文件已经改动。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "add parameter 请求没有在 explain 后提前收尾",
            openLoops: [],
            nextActions: [],
            importantFacts: ["Add/parameter 这类措辞也会触发 modify 过渡"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "Add a text parameter to from_file so binary parsers can be supported.",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /def from_file\(filename, load, text=True\):/);
      assert.match(finalContent, /mode = "r" if text else "rb"/);
      assert.equal(executorCallCount, 5);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("EXECUTION_POLICY: 用户请求同时包含解释和修改"),
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("行为性修改在有明确测试目标时，必须补齐目标化行为验证后才能 finalize", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-verify-policy-"));

    try {
      const targetPath = path.join(tempRoot, "app.py");
      const testsDir = path.join(tempRoot, "tests");
      await writeFile(
        targetPath,
        [
          "def greet():",
          "    return \"hello\"",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(testsDir, { recursive: true });
      await writeFile(path.join(testsDir, "__init__.py"), "", "utf8");
      await writeFile(
        path.join(testsDir, "test_app.py"),
        [
          "import unittest",
          "",
          "import app",
          "",
          "",
          "class GreetTests(unittest.TestCase):",
          "    def test_greet(self):",
          "        self.assertEqual(app.greet(), \"hello!\")",
          "",
          "",
          "if __name__ == \"__main__\":",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-26T09:00:00.000Z";
      const workspace: Workspace = {
        id: "workspace_verify_policy",
        path: tempRoot,
        label: "verify-policy",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_verify_policy",
        workspaceId: workspace.id,
        title: "verify policy session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
        maxToolRounds: 12,
        hooks: {
          goalFactory: async () => ({
            title: "修复 greet 的返回值并保住相关测试",
            description: "修改 app.py 的行为后，既要做结构性验证，也要围绕 tests/test_app.py 做目标化行为验证。",
            successCriteria: ["真实修改文件", "结构性验证通过", "相关测试通过后再收尾"],
          }),
          planner: async () => ({
            summary: "先读取 app.py 和对应测试，再修改，再验证，最后收尾。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "读取目标文件",
                description: "拿到 greet 的当前实现。",
                status: "in_progress",
              },
              {
                id: "plan_step_target",
                title: "读取测试目标",
                description: "确认最小行为验证应该落在 tests/test_app.py。",
                status: "todo",
              },
              {
                id: "plan_step_edit",
                title: "修改 greet 行为",
                description: "先故意制造一次需要验证才能发现的问题，再修正它。",
                status: "todo",
              },
              {
                id: "plan_step_verify",
                title: "跑结构性验证和目标化行为验证",
                description: "先用 py_compile 兜语法，再用 unittest 跑 tests.test_app。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const toolMessages = state.messages.filter((message) => message.role === "tool");
            const systemMessages = state.messages.filter((message) => message.role === "system");
            const sawView = toolMessages.some((message) => message.content.includes("path=app.py"));
            const sawTestView = toolMessages.some((message) => message.content.includes("path=tests/test_app.py"));
            const editMessages = toolMessages.filter((message) => message.content.includes("tool=edit"));
            const bashMessages = toolMessages.filter((message) => message.content.includes("tool=bash"));
            const sawNeedVerifyNudge = systemMessages.some(
              (message) =>
                message.content.includes("VERIFICATION_POLICY: 当前 invoke 已经进入真实修改阶段。")
                && message.content.includes("还没有任何验证尝试"),
            );
	            const sawNeedStrongerVerify = systemMessages.some(
	              (message) => message.content.includes("缺少一次目标化行为验证"),
	            );
	            const sawFailedVerifyNudge = systemMessages.some(
	              (message) =>
	                (
	                  message.content.includes("VERIFICATION_POLICY: 当前 invoke 已经进入真实修改阶段。")
	                  || message.content.includes("MODIFICATION_POLICY: 当前 invoke 已经进入行为修改阶段。")
	                )
	                && (
	                  message.content.includes("最近一次 verify phase 在最新改动之后失败了")
	                  || message.content.includes("最近一次 verify 在最新补丁之后失败了")
	                ),
	            );
            const sawFailedVerify = bashMessages.some(
              (message) =>
                message.content.includes("python3 -m py_compile app.py")
                && message.content.includes("\"exitCode\":1"),
            );
            const sawSuccessfulStructuralVerify = bashMessages.some(
              (message) =>
                message.content.includes("python3 -m py_compile app.py")
                && message.content.includes("\"exitCode\":0"),
            );
            const sawSuccessfulBehaviorVerify = bashMessages.some(
              (message) =>
                message.content.includes("python3 -m unittest tests.test_app")
                && message.content.includes("\"exitCode\":0"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先看当前 greet 实现。",
                    input: {
                      path: "app.py",
                    },
                  },
                ],
              };
            }

            if (!sawTestView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_target",
                    reasoning: "先看测试目标，确定后续 verify 的最小粒度。",
                    input: {
                      path: "tests/test_app.py",
                    },
                  },
                ],
              };
            }

            if (editMessages.length === 0) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "先做一次真实修改，但故意留下语法问题，验证 runtime 会继续追 verify/fix。",
                    input: {
                      path: "app.py",
                      search: "def greet():\n    return \"hello\"",
                      replace: "def greet()\n    return \"hello!\"",
                    },
                  },
                ],
              };
            }

            if (!sawNeedVerifyNudge) {
              return {
                executionPhase: "finalize",
                assistantMessage: "已经改了 greet，理论上可以收尾。",
              };
            }

            if (!sawFailedVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "先跑一次最小语法验证，确认这次修改是否可用。",
                    input: {
                      cmd: "python3 -m py_compile app.py",
                      working_directory: ".",
                      timeout_ms: 10_000,
                    },
                  },
                ],
              };
            }

            if (!sawFailedVerifyNudge) {
              return {
                executionPhase: "finalize",
                assistantMessage: "虽然刚才验证失败了，但我先试着收尾。",
              };
            }

            if (editMessages.length === 1) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "收到失败验证的策略提示后，修复语法错误。",
                    input: {
                      path: "app.py",
                      search: "def greet()\n    return \"hello!\"",
                      replace: "def greet():\n    return \"hello!\"",
                    },
                  },
                ],
              };
            }

            if (!sawSuccessfulStructuralVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "修完以后再次跑最小验证，确认这次通过。",
                    input: {
                      command: "python3 -m py_compile app.py",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            if (!sawNeedStrongerVerify) {
              return {
                executionPhase: "finalize",
                assistantMessage: "py_compile 已经过了，我先收尾。",
              };
            }

            if (!sawSuccessfulBehaviorVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "当前已经拿到明确测试目标，所以继续补足目标化行为验证。",
                    input: {
                      command: "python3 -m unittest tests.test_app",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经修改 greet，并补齐结构性验证和目标化行为验证。",
              tasks: [
                {
                  id: "plan_step_edit",
                  title: "修改 greet 行为",
                  inputSummary: "先故意制造一次需要验证才能发现的问题，再修正它，并跑到目标测试。",
                  outputSummary: "最终修改已经稳定落地，相关测试也已通过。",
                  status: "done",
                },
                {
                  id: "plan_step_verify",
                  title: "跑结构性验证和目标化行为验证",
                  inputSummary: "先用 py_compile 兜语法，再用 unittest 跑 tests.test_app。",
                  outputSummary: "py_compile 先失败后通过，随后 tests.test_app 也通过。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["runtime 没有允许结构性验证替代目标化行为验证。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "行为性修改在有明确测试目标时，必须补齐目标化行为验证",
            openLoops: [],
            nextActions: [],
            importantFacts: ["结构性验证不足以替代目标化行为验证"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "修复 app.py 里的 greet 返回值，并确认 tests/test_app.py 这条相关测试通过。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /def greet\(\):/);
      assert.match(finalContent, /return "hello!"/);
      assert.equal(executorCallCount, 11);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("VERIFICATION_POLICY: 当前 invoke 已经进入真实修改阶段。")
            && message.content.includes("还没有任何验证尝试"),
        ),
        true,
      );
	      assert.equal(
	        messages.some(
	          (message) =>
	            message.role === "system"
	            && (
	              message.content.includes("最近一次 verify phase 在最新改动之后失败了")
	              || message.content.includes("最近一次 verify 在最新补丁之后失败了")
	            ),
	        ),
	        true,
	      );
	      assert.equal(
	        messages.some(
	          (message) =>
	            message.role === "system"
	            && message.content.includes("回到目标代码路径继续 modify")
	            && message.content.includes("目标代码路径：app.py"),
	        ),
	        true,
	      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("缺少一次目标化行为验证"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && (
              message.content.includes("优先目标：tests/test_app.py")
              || message.content.includes("目标验证命令：python3 -m pytest tests/test_app.py")
              || message.content.includes("目标验证命令：python3 -m unittest tests.test_app")
              || message.content.includes("tests.test_app")
            ),
        ),
        true,
      );
      assert.equal(
        messages.filter(
          (message) => message.role === "tool" && message.content.includes("tool=bash"),
        ).length,
        3,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant"
            && message.content.includes("已经修改 greet，并补齐结构性验证和目标化行为验证"),
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("行为性任务里，只有 import/comment 级补丁时不能 finalize，必须继续命中真实行为路径", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-substantive-behavior-"));

    try {
      const targetPath = path.join(tempRoot, "streaming.py");
      const testsDir = path.join(tempRoot, "tests");
      await writeFile(
        targetPath,
        [
          "import socket",
          "",
          "def read_chunks(raw):",
          "    return list(raw.stream(1))",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(testsDir, { recursive: true });
      await writeFile(path.join(testsDir, "__init__.py"), "", "utf8");
      await writeFile(
        path.join(testsDir, "test_streaming.py"),
        [
          "import socket",
          "import unittest",
          "",
          "import streaming",
          "",
          "",
          "class RawMock:",
          "    def stream(self, chunk_size):",
          "        raise socket.error()",
          "",
          "",
          "class StreamTests(unittest.TestCase):",
          "    def test_wraps_socket_error(self):",
          "        with self.assertRaises(RuntimeError):",
          "            streaming.read_chunks(RawMock())",
          "",
          "",
          "if __name__ == \"__main__\":",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-26T12:00:00.000Z";
      const workspace: Workspace = {
        id: "workspace_substantive_behavior",
        path: tempRoot,
        label: "substantive-behavior",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_substantive_behavior",
        workspaceId: workspace.id,
        title: "substantive behavior session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
        maxToolRounds: 12,
        hooks: {
          goalFactory: async () => ({
            title: "把 socket.error 包装成 RuntimeError",
            description: "先解释 streaming.py 的测试，再修复真实行为；只有 import/comment 级补丁不能算完成。",
            successCriteria: ["真实命中行为路径", "相关测试通过后再收尾"],
          }),
          planner: async () => ({
            summary: "先读源码和测试，再尝试修改；如果只是表层 patch，则继续 modify，直到命中真实行为路径。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view_source",
                title: "读取 streaming.py",
                description: "确认当前行为路径。",
                status: "in_progress",
              },
              {
                id: "plan_step_view_test",
                title: "读取测试文件",
                description: "确认目标测试要求。",
                status: "todo",
              },
              {
                id: "plan_step_modify",
                title: "修复 socket.error 包装",
                description: "必须命中真实行为路径。",
                status: "todo",
              },
              {
                id: "plan_step_verify",
                title: "运行目标测试",
                description: "确认 test_streaming 通过。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const toolMessages = state.messages.filter((message) => message.role === "tool");
            const systemMessages = state.messages.filter((message) => message.role === "system");
            const sawSourceView = toolMessages.some((message) => message.content.includes("path=streaming.py"));
            const sawTestView = toolMessages.some((message) => message.content.includes("path=tests/test_streaming.py"));
            const editMessages = toolMessages.filter((message) => message.content.includes("tool=edit"));
            const sawSubstantiveNudge = systemMessages.some(
              (message) =>
                message.content.includes("MODIFICATION_POLICY: 当前 invoke 已经进入行为修改阶段。")
                && message.content.includes("当前 edit 只在目标文件上做 import/comment/表层整理"),
            );
            const sawBehaviorVerify = toolMessages.some(
              (message) =>
                message.content.includes("tool=bash")
                && message.content.includes("python3 -m unittest tests.test_streaming")
                && message.content.includes("\"exitCode\":0"),
            );

            if (!sawSourceView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_source",
                    reasoning: "先看当前行为实现。",
                    input: {
                      path: "streaming.py",
                    },
                  },
                ],
              };
            }

            if (!sawTestView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_test",
                    reasoning: "确认目标测试要求。",
                    input: {
                      path: "tests/test_streaming.py",
                    },
                  },
                ],
              };
            }

            if (sawSubstantiveNudge && editMessages.length === 0) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "继续命中真实行为路径，把 socket.error 包成 RuntimeError。",
                    input: {
                      path: "streaming.py",
                      search: "def read_chunks(raw):\n    return list(raw.stream(1))",
                      replace: [
                        "def read_chunks(raw):",
                        "    try:",
                        "        return list(raw.stream(1))",
                        "    except socket.error as error:",
                        "        raise RuntimeError(\"socket failed\") from error",
                      ].join("\n"),
                    },
                  },
                ],
              };
            }

            if (editMessages.length === 0) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "先做一次表层 patch，验证 runtime 会继续追真实行为修改。",
                    input: {
                      path: "streaming.py",
                      search: "import socket",
                      replace: "import socket\nfrom typing import Any",
                    },
                  },
                ],
              };
            }

            if (!sawBehaviorVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "运行目标测试，确认行为修复已经生效。",
                    input: {
                      command: "python3 -m unittest tests.test_streaming",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经命中真实行为路径并通过目标测试。",
              tasks: [
                {
                  id: "plan_step_modify",
                  title: "修复 socket.error 包装",
                  inputSummary: "必须命中真实行为路径。",
                  outputSummary: "最终在函数体里把 socket.error 包成 RuntimeError。",
                  status: "done",
                },
                {
                  id: "plan_step_verify",
                  title: "运行目标测试",
                  inputSummary: "确认 test_streaming 通过。",
                  outputSummary: "tests.test_streaming 已通过。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["runtime 没有允许 import/comment 级补丁冒充行为修复完成。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "行为任务必须命中真实行为路径，import/comment 级补丁不能 finalize",
            openLoops: [],
            nextActions: [],
            importantFacts: ["behavioral fix 不能只停在 import/comment 级修改"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "解释 tests/test_streaming.py 在测什么，然后修复 streaming.py，让 socket.error 被包装成 RuntimeError。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /raise RuntimeError\("socket failed"\) from error/);
      assert.doesNotMatch(finalContent, /from typing import Any/);
      assert.ok(executorCallCount >= 6);

      const messages = await store.messages.listBySession(session.id);
	      assert.equal(
	        messages.some(
	          (message) =>
	            message.role === "system"
	            && message.content.includes("MODIFICATION_POLICY: 当前 invoke 已经进入行为修改阶段。")
	            && message.content.includes("当前 edit 只在目标文件上做 import/comment/表层整理"),
	        ),
	        true,
	      );
	      assert.equal(
	        messages.some(
	          (message) =>
	            message.role === "system"
	            && message.content.includes("目标代码路径：streaming.py"),
	        ),
	        true,
	      );
	      assert.equal(
	        messages.filter(
	          (message) => message.role === "tool" && message.content.includes("tool=bash"),
	        ).length,
        1,
      );
      assert.equal(
        messages.filter(
          (message) => message.role === "tool" && message.content.includes("tool=edit"),
        ).length,
        1,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("verify 失败后会生成结构化失败反馈，并把下一轮 modify 拉回目标代码路径", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-structured-verify-feedback-"));

    try {
      const targetPath = path.join(tempRoot, "streaming.py");
      const testsDir = path.join(tempRoot, "tests");
      await writeFile(
        targetPath,
        [
          "import socket",
          "",
          "def read_chunks(raw):",
          "    return list(raw.stream(1))",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(testsDir, { recursive: true });
      await writeFile(path.join(testsDir, "__init__.py"), "", "utf8");
      await writeFile(
        path.join(testsDir, "test_streaming.py"),
        [
          "import socket",
          "import unittest",
          "",
          "import streaming",
          "",
          "",
          "class RawMock:",
          "    def stream(self, chunk_size):",
          "        raise socket.error()",
          "",
          "",
          "class StreamTests(unittest.TestCase):",
          "    def test_wraps_socket_error(self):",
          "        with self.assertRaises(RuntimeError):",
          "            streaming.read_chunks(RawMock())",
          "",
          "",
          "if __name__ == \"__main__\":",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-26T13:30:00.000Z";
      const workspace: Workspace = {
        id: "workspace_structured_verify_feedback",
        path: tempRoot,
        label: "structured-verify-feedback",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_structured_verify_feedback",
        workspaceId: workspace.id,
        title: "structured verify feedback session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
        maxToolRounds: 12,
        hooks: {
          goalFactory: async () => ({
            title: "修复 socket.error 包装",
            description: "先解释测试在测什么，再修复真实行为；verify 失败后必须基于结构化反馈回到目标函数体继续修改。",
            successCriteria: ["相关测试通过", "失败反馈能指回目标路径和函数体"],
          }),
          planner: async () => ({
            summary: "先读取测试和源码，尝试修改；如果 verify 失败，则根据结构化反馈继续命中真实行为路径。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view_test",
                title: "读取测试文件",
                description: "确认目标测试要求。",
                status: "in_progress",
              },
              {
                id: "plan_step_view_source",
                title: "读取源码文件",
                description: "定位行为路径。",
                status: "todo",
              },
              {
                id: "plan_step_modify",
                title: "修复 read_chunks",
                description: "失败后必须回到目标函数体继续改。",
                status: "todo",
              },
              {
                id: "plan_step_verify",
                title: "运行目标测试",
                description: "确认 tests.test_streaming 通过。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const toolMessages = state.messages.filter((message) => message.role === "tool");
            const systemMessages = state.messages.filter((message) => message.role === "system");
            const sawTestView = toolMessages.some((message) => message.content.includes("path=tests/test_streaming.py"));
            const sawSourceView = toolMessages.some((message) => message.content.includes("path=streaming.py"));
            const editMessages = toolMessages.filter((message) => message.content.includes("tool=edit"));
            const sawFailedVerify = toolMessages.some(
              (message) =>
                message.content.includes("tool=bash")
                && message.content.includes("python3 -m unittest tests.test_streaming")
                && message.content.includes("\"exitCode\":1"),
            );
            const verificationFeedback = systemMessages.find((message) =>
              message.content.includes("VERIFICATION_FEEDBACK:"),
            );
            const sawPassingVerify = toolMessages.some(
              (message) =>
                message.content.includes("tool=bash")
                && message.content.includes("python3 -m unittest tests.test_streaming")
                && message.content.includes("\"exitCode\":0"),
            );

            if (!sawTestView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_test",
                    reasoning: "先看测试在验证什么。",
                    input: {
                      path: "tests/test_streaming.py",
                    },
                  },
                ],
              };
            }

            if (!sawSourceView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_source",
                    reasoning: "定位需要修改的源码路径。",
                    input: {
                      path: "streaming.py",
                    },
                  },
                ],
              };
            }

            if (editMessages.length === 0) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "先命中 read_chunks 函数体，但故意修错异常类型，逼 verify 失败并产出结构化反馈。",
                    input: {
                      path: "streaming.py",
                      search: "def read_chunks(raw):\n    return list(raw.stream(1))",
                      replace: [
                        "def read_chunks(raw):",
                        "    try:",
                        "        return list(raw.stream(1))",
                        "    except socket.error as error:",
                        "        raise ValueError(\"socket failed\") from error",
                      ].join("\n"),
                    },
                  },
                ],
              };
            }

            if (!sawFailedVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "先跑目标测试，看失败会落在哪条真实行为路径。",
                    input: {
                      command: "python3 -m unittest tests.test_streaming",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            if (!verificationFeedback) {
              return {
                executionPhase: "finalize",
                assistantMessage: "我已经拿到失败输出，准备先收尾。",
              };
            }

            if (editMessages.length === 1) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "基于结构化失败反馈，直接命中 read_chunks 函数体修复真实行为。",
                    input: {
                      path: "streaming.py",
                      search: [
                        "def read_chunks(raw):",
                        "    try:",
                        "        return list(raw.stream(1))",
                        "    except socket.error as error:",
                        "        raise ValueError(\"socket failed\") from error",
                      ].join("\n"),
                      replace: [
                        "def read_chunks(raw):",
                        "    try:",
                        "        return list(raw.stream(1))",
                        "    except socket.error as error:",
                        "        raise RuntimeError(\"socket failed\") from error",
                      ].join("\n"),
                    },
                  },
                ],
              };
            }

            if (!sawPassingVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "修正后重新跑目标测试，确认行为修复已经生效。",
                    input: {
                      command: "python3 -m unittest tests.test_streaming",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经基于结构化失败反馈回到目标函数体完成修复，并通过目标测试。",
              tasks: [
                {
                  id: "plan_step_modify",
                  title: "修复 read_chunks",
                  inputSummary: "失败后必须回到目标函数体继续改。",
                  outputSummary: "最终命中 read_chunks 函数体，把 socket.error 包成 RuntimeError。",
                  status: "done",
                },
                {
                  id: "plan_step_verify",
                  title: "运行目标测试",
                  inputSummary: "确认 tests.test_streaming 通过。",
                  outputSummary: "tests.test_streaming 已通过。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["verify 失败后，runtime 会结构化提取 failing tests、目标路径和行为锚点。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "verify 失败会被结构化解析，并驱动下一轮回到目标函数体继续修改",
            openLoops: [],
            nextActions: [],
            importantFacts: ["VERIFICATION_FEEDBACK 会把 failing tests、代码路径和锚点喂回 executor"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "我没看懂 tests/test_streaming.py 在测什么，你先解释一下，然后修复这个 socket 错误包装问题。",
      });

      assert.ok(executorCallCount >= 5);

      const messages = await store.messages.listBySession(session.id);
      const structuredFeedbackMessage = messages.find(
        (message) =>
          message.role === "system"
          && message.content.includes("VERIFICATION_FEEDBACK:")
          && message.content.includes("目标代码路径：streaming.py")
          && message.content.includes("目标行为锚点：")
          && message.content.includes("read_chunks"),
      );

      assert.ok(structuredFeedbackMessage);
      assert.match(structuredFeedbackMessage.content, /test_wraps_socket_error/);
      assert.match(structuredFeedbackMessage.content, /(AssertionError|OSError|socket\.error|ValueError|RuntimeError)/);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("回到目标代码路径继续 modify")
            && message.content.includes("目标代码路径：streaming.py"),
        ),
        true,
      );
      assert.equal(
        messages.filter(
          (message) => message.role === "tool" && message.content.includes("tool=bash"),
        ).length >= 1,
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("高风险共享路径上的过宽 edit 会先被 budget guard 拦下，并至少推进到目标验证阶段", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-adjacent-regression-"));

    try {
      const targetPath = path.join(tempRoot, "adapters.py");
      const testsDir = path.join(tempRoot, "tests");
      await writeFile(
        targetPath,
        [
          "def normalize_timeout(value):",
          "    if value is None:",
          "        return None",
          "    if value < 0:",
          "        raise ValueError(\"timeout must be >= 0\")",
          "    return value",
          "",
          "def normalize_retries(value):",
          "    if value < 0:",
          "        raise ValueError(\"retries must be >= 0\")",
          "    return value",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(testsDir, { recursive: true });
      await writeFile(path.join(testsDir, "__init__.py"), "", "utf8");
      await writeFile(
        path.join(testsDir, "test_adapters.py"),
        [
          "import unittest",
          "",
          "import adapters",
          "",
          "",
          "class AdapterBehaviorTests(unittest.TestCase):",
          "    def test_none_timeout(self):",
          "        self.assertEqual(adapters.normalize_timeout(None), 30)",
          "",
          "    def test_negative_timeout(self):",
          "        with self.assertRaises(ValueError):",
          "            adapters.normalize_timeout(-1)",
          "",
          "    def test_negative_retries(self):",
          "        with self.assertRaises(ValueError):",
          "            adapters.normalize_retries(-1)",
          "",
          "",
          "if __name__ == \"__main__\":",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-26T12:20:00.000Z";
      const workspace: Workspace = {
        id: "workspace_adjacent_regression",
        path: tempRoot,
        label: "adjacent-regression",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_adjacent_regression",
        workspaceId: workspace.id,
        title: "adjacent regression session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
        maxToolRounds: 12,
        hooks: {
          goalFactory: async () => ({
            title: "修复 adapters.py 的 timeout 默认值并守住相邻回归",
            description: "这是共享热路径上的行为修改。除了主目标测试，还要补同模块相邻回归。",
            successCriteria: ["真实修改文件", "先跑主目标测试", "再补相邻回归后收尾"],
          }),
          planner: async () => ({
            summary: "先读源码和测试，再修改 adapters.py，然后先跑主目标、再跑同模块回归。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view_source",
                title: "读取 adapters.py",
                description: "确认 timeout 逻辑。",
                status: "in_progress",
              },
              {
                id: "plan_step_view_test",
                title: "读取测试文件",
                description: "确认主目标和相邻回归。",
                status: "todo",
              },
              {
                id: "plan_step_modify",
                title: "修改 timeout 逻辑",
                description: "落一版真实 patch。",
                status: "todo",
              },
              {
                id: "plan_step_verify",
                title: "先主目标、再相邻回归",
                description: "主目标通过后，还要跑整模块回归。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const toolMessages = state.messages.filter((message) => message.role === "tool");
            const systemMessages = state.messages.filter((message) => message.role === "system");
            const sawSourceView = toolMessages.some((message) => message.content.includes("path=adapters.py"));
            const sawTestView = toolMessages.some((message) => message.content.includes("path=tests/test_adapters.py"));
            const editMessages = toolMessages.filter((message) => message.content.includes("tool=edit"));
            const sawBudgetGuard = systemMessages.some(
              (message) =>
                message.content.includes("MODIFICATION_POLICY: 当前 invoke 已经进入行为修改阶段。")
                && message.content.includes("执行前拦截")
                && message.content.includes("过宽改动"),
            );
	            const sawAdjacentRegressionNudge = systemMessages.some(
	              (message) =>
	                message.content.includes("缺少一次相邻回归验证")
	                || message.content.includes("当前验证门槛：目标化行为验证 + 相邻回归验证"),
	            );
            const sawPrimaryVerify = toolMessages.some(
              (message) =>
                message.content.includes("tool=bash")
                && message.content.includes("python3 -m unittest tests.test_adapters.AdapterBehaviorTests.test_none_timeout")
                && message.content.includes("\"exitCode\":0"),
            );
            const sawAdjacentVerify = toolMessages.some(
              (message) =>
                message.content.includes("tool=bash")
                && message.content.includes("input={\"command\":\"python3 -m unittest tests.test_adapters\",\"cwd\":\".\"}")
                && message.content.includes("\"exitCode\":0"),
            );

            if (!sawSourceView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_source",
                    reasoning: "先看 adapters.py 的 timeout 逻辑。",
                    input: {
                      path: "adapters.py",
                    },
                  },
                ],
              };
            }

            if (!sawTestView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_test",
                    reasoning: "看测试文件，确认主目标和相邻回归。",
                    input: {
                      path: "tests/test_adapters.py",
                    },
                  },
                ],
              };
            }

            if (editMessages.length === 0 && !sawBudgetGuard) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "先尝试一版过宽 patch，验证 runtime 会拦截高风险共享路径上的超预算 edit。",
                    input: {
                      path: "adapters.py",
                      search: [
                        "def normalize_timeout(value):",
                        "    if value is None:",
                        "        return None",
                        "    if value < 0:",
                        "        raise ValueError(\"timeout must be >= 0\")",
                        "    return value",
                        "",
                        "def normalize_retries(value):",
                        "    if value < 0:",
                        "        raise ValueError(\"retries must be >= 0\")",
                        "    return value",
                      ].join("\n"),
                      replace: [
                        "def normalize_timeout(value):",
                        "    try:",
                        "        if value is None:",
                        "            return 30",
                        "        if value < 0:",
                        "            raise ValueError(\"timeout must be >= 0\")",
                        "        return value",
                        "    except TypeError as error:",
                        "        raise ValueError(\"timeout must be >= 0\") from error",
                        "",
                        "def normalize_retries(value):",
                        "    try:",
                        "        if value < 0:",
                        "            raise ValueError(\"retries must be >= 0\")",
                        "        return value",
                        "    except TypeError as error:",
                        "        raise ValueError(\"retries must be >= 0\") from error",
                      ].join("\n"),
                    },
                  },
                ],
              };
            }

            if (editMessages.length === 0 && sawBudgetGuard) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "改成最小增量 edit，只命中 timeout 的既有分支。",
                    input: {
                      path: "adapters.py",
                      search: [
                        "def normalize_timeout(value):",
                        "    if value is None:",
                        "        return None",
                        "    if value < 0:",
                        "        raise ValueError(\"timeout must be >= 0\")",
                        "    return value",
                      ].join("\n"),
                      replace: [
                        "def normalize_timeout(value):",
                        "    if value is None:",
                        "        return 30",
                        "    if value < 0:",
                        "        raise ValueError(\"timeout must be >= 0\")",
                        "    return value",
                      ].join("\n"),
                    },
                  },
                ],
              };
            }

            if (!sawPrimaryVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "先跑主目标测试。",
                    input: {
                      command: "python3 -m unittest tests.test_adapters.AdapterBehaviorTests.test_none_timeout",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            if (!sawAdjacentRegressionNudge) {
              return {
                executionPhase: "finalize",
                assistantMessage: "主目标已经过了，我先收尾。",
              };
            }

            if (!sawAdjacentVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "补整模块相邻回归，确认没有把旧语义打坏。",
                    input: {
                      command: "python3 -m unittest tests.test_adapters",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经通过主目标和相邻回归验证。",
              tasks: [
                {
                  id: "plan_step_modify",
                  title: "修改 timeout 逻辑",
                  inputSummary: "落一版真实 patch。",
                  outputSummary: "共享热路径上的 timeout 逻辑已修改。",
                  status: "done",
                },
                {
                  id: "plan_step_verify",
                  title: "先主目标、再相邻回归",
                  inputSummary: "主目标通过后，还要跑整模块回归。",
                  outputSummary: "单目标和整模块验证均已通过。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["高风险共享路径上的补丁在 finalize 前补齐了相邻回归验证。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "高风险共享路径会被要求补齐相邻回归验证",
            openLoops: [],
            nextActions: [],
            importantFacts: ["high-risk shared path 不能只跑单目标测试就收尾"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage:
          "修复 adapters.py 的 timeout 默认值，并确认 tests.test_adapters.AdapterBehaviorTests.test_none_timeout 通过；这是共享热路径，最后还要补 tests.test_adapters 的相邻回归验证再收尾。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /return 30/);
      assert.ok(executorCallCount >= 8);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("执行前拦截")
            && message.content.includes("过宽改动"),
        ),
        true,
      );
      assert.equal(
        messages.filter(
          (message) => message.role === "tool" && message.content.includes("tool=bash"),
        ).length >= 1,
        true,
      );
      assert.equal(
        messages.filter(
          (message) => message.role === "tool" && message.content.includes("tool=edit"),
        ).length,
        1,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("纯结构性修改在真实 edit 后，做过最小结构性验证就可以 finalize", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-structural-verify-"));

    try {
      const targetPath = path.join(tempRoot, "util.py");
      await writeFile(
        targetPath,
        [
          "import os",
          "import sys",
          "",
          "def join_with_prefix(value: str):",
          "    return os.path.join(sys.prefix, value)",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-26T10:10:00.000Z";
      const workspace: Workspace = {
        id: "workspace_structural_verify",
        path: tempRoot,
        label: "structural-verify",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_structural_verify",
        workspaceId: workspace.id,
        title: "structural verify session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
        hooks: {
          goalFactory: async () => ({
            title: "重排 util.py import 顺序",
            description: "这次只做结构性整理，不改变函数行为。",
            successCriteria: ["真实修改文件", "至少完成一轮结构性验证"],
          }),
          planner: async () => ({
            summary: "先读取 util.py，再重排 import，并做最小结构性验证。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "读取 util.py",
                description: "确认 import 位置。",
                status: "in_progress",
              },
              {
                id: "plan_step_edit",
                title: "重排 import",
                description: "只做结构性整理。",
                status: "todo",
              },
              {
                id: "plan_step_verify",
                title: "做结构性验证",
                description: "跑最小语法检查。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("path=util.py"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );
            const sawVerificationPolicy = state.messages.some(
              (message) =>
                message.role === "system"
                && message.content.includes("当前验证门槛：结构性验证"),
            );
            const sawSuccessfulVerify = state.messages.some(
              (message) =>
                message.role === "tool"
                && message.content.includes("tool=bash")
                && message.content.includes("python3 -m py_compile util.py")
                && message.content.includes("\"exitCode\":0"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先看 util.py 的 import 区域。",
                    input: {
                      path: "util.py",
                    },
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "只重排 import，不改逻辑。",
                    input: {
                      path: "util.py",
                      search: "import os\nimport sys",
                      replace: "import sys\nimport os",
                    },
                  },
                ],
              };
            }

            if (!sawVerificationPolicy) {
              return {
                executionPhase: "finalize",
                assistantMessage: "这次只是结构整理，我先试着收尾。",
              };
            }

            if (!sawSuccessfulVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "跑最小结构性验证。",
                    input: {
                      command: "python3 -m py_compile util.py",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已完成结构性整理，并通过最小结构性验证。",
              tasks: [
                {
                  id: "plan_step_edit",
                  title: "重排 import",
                  inputSummary: "只做结构性整理。",
                  outputSummary: "import 顺序已调整。",
                  status: "done",
                },
                {
                  id: "plan_step_verify",
                  title: "做结构性验证",
                  inputSummary: "运行 py_compile。",
                  outputSummary: "结构性验证已通过。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["结构性修改只要求最小结构性验证即可收尾。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "结构性修改通过最小验证后即可收尾",
            openLoops: [],
            nextActions: [],
            importantFacts: ["结构性验证不强求行为级测试"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "重排 util.py 的 import 顺序，不改逻辑，做最小结构性验证后收尾。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /import sys\nimport os/);
      assert.equal(executorCallCount, 5);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("当前验证门槛：结构性验证"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "tool"
            && message.content.includes("tool=bash")
            && message.content.includes("python3 -m py_compile util.py")
            && message.content.includes("\"exitCode\":0"),
        ),
        true,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant"
            && message.content.includes("已完成结构性整理，并通过最小结构性验证"),
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("纯注释修改在真实 edit 后不会被强制进入 verify phase", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-comment-no-verify-"));

    try {
      const targetPath = path.join(tempRoot, "notes.ts");
      await writeFile(
        targetPath,
        [
          "export function value() {",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-26T09:30:00.000Z";
      const workspace: Workspace = {
        id: "workspace_comment_no_verify",
        path: tempRoot,
        label: "comment-no-verify",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_comment_no_verify",
        workspaceId: workspace.id,
        title: "comment no verify session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "给 notes.ts 补两行注释",
            description: "这次只是纯注释修改，不涉及行为变更。",
            successCriteria: ["真实修改文件", "不被错误地强制跑验证"],
          }),
          planner: async () => ({
            summary: "读取 notes.ts，再直接补注释并收尾。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "读取 notes.ts",
                description: "看清函数顶部的插入位置。",
                status: "in_progress",
              },
              {
                id: "plan_step_comment",
                title: "补注释",
                description: "只做注释修改。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=view"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先看函数顶部。",
                    input: {
                      path: "notes.ts",
                    },
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_comment",
                    reasoning: "这是纯注释修改，直接落文件。",
                    input: {
                      path: "notes.ts",
                      search: "export function value() {",
                      replace: "// 这里补两行注释。\n// 这次修改只影响说明文本，不影响行为。\nexport function value() {",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经补上两行注释。",
              tasks: [
                {
                  id: "plan_step_comment",
                  title: "补注释",
                  inputSummary: "只做注释修改。",
                  outputSummary: "已补两行注释。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["纯注释修改不需要额外 verify phase。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "纯注释修改不会被错误地强制验证",
            openLoops: [],
            nextActions: [],
            importantFacts: ["documentation-only 修改允许 edit 后直接 finalize"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "在 notes.ts 顶部加两行注释说明这个函数的作用。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /这次修改只影响说明文本，不影响行为/);
      assert.equal(executorCallCount, 3);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) => message.role === "system" && message.content.includes("VERIFICATION_POLICY:"),
        ),
        false,
      );
      assert.equal(
        messages.some(
          (message) => message.role === "tool" && message.content.includes("tool=bash"),
        ),
        false,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("已经 view 过同一路径后，如果下一轮还想对同一路径继续纯只读，runtime 会强制切到 modify", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-force-modify-after-view-"));

    try {
      const targetPath = path.join(tempRoot, "browser.test.ts");
      await writeFile(
        targetPath,
        [
          "import assert from \"node:assert/strict\";",
          "import { describe, test } from \"node:test\";",
          "",
          "describe(\"browser runtime\", () => {",
          "  test(\"works\", () => {",
          "    assert.equal(1, 1);",
          "  });",
          "});",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-25T10:40:00.000Z";
      const workspace: Workspace = {
        id: "workspace_force_modify_after_view",
        path: tempRoot,
        label: "force-modify-after-view",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_force_modify_after_view",
        workspaceId: workspace.id,
        title: "force modify after view session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        hooks: {
          goalFactory: async () => ({
            title: "解释后修改测试文件",
            description: "先定位 browser.test.ts，再直接落注释修改。",
            successCriteria: ["定位文件", "不要卡在重复只读", "真实修改文件"],
          }),
          planner: async () => ({
            summary: "先 view 一次拿上下文；如果已定位文件，则不要继续同一路径纯只读，直接 edit。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view",
                title: "定位 browser.test.ts",
                description: "确认测试文件内容和可修改锚点。",
                status: "in_progress",
              },
              {
                id: "plan_step_edit",
                title: "补两行注释",
                description: "定位到文件后直接编辑。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const sawView = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=view"),
            );
            const sawPolicyNudge = state.messages.some(
              (message) =>
                message.role === "system"
                && message.content.includes("不要继续对同一路径发起纯只读 toolCalls"),
            );
            const sawEdit = state.messages.some(
              (message) => message.role === "tool" && message.content.includes("tool=edit"),
            );

            if (!sawView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view",
                    reasoning: "先读取目标测试文件。",
                    input: {
                      path: "browser.test.ts",
                    },
                  },
                ],
              };
            }

            if (!sawPolicyNudge) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "grep",
                    taskId: "plan_step_view",
                    reasoning: "已经知道是 browser.test.ts，但错误地还想继续对同一路径做只读搜索。",
                    input: {
                      path: "browser.test.ts",
                      pattern: "describe|test",
                    },
                  },
                ],
              };
            }

            if (!sawEdit) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_edit",
                    reasoning: "收到 EXECUTION_POLICY 后，直接做真实修改。",
                    input: {
                      path: "browser.test.ts",
                      search: "import assert from \"node:assert/strict\";",
                      replace:
                        "// 已经定位到目标测试文件。\n// 这里验证 runtime 会在已知路径后强制进入 edit。\nimport assert from \"node:assert/strict\";",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已避免继续纯只读，直接完成修改。",
              tasks: [
                {
                  id: "plan_step_view",
                  title: "定位 browser.test.ts",
                  inputSummary: "确认测试文件内容和可修改锚点。",
                  outputSummary: "已定位目标文件。",
                  status: "done",
                },
                {
                  id: "plan_step_edit",
                  title: "补两行注释",
                  inputSummary: "定位到文件后直接编辑。",
                  outputSummary: "已真实修改文件。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["重复只读已被阻止，文件已修改。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "已知路径后的纯只读调用会被强制切到 modify",
            openLoops: [],
            nextActions: [],
            importantFacts: ["runtime 会阻止已知路径上的继续纯只读"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "先看 browser.test.ts 在测什么，再补两行注释说明。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /已经定位到目标测试文件/);
      assert.match(finalContent, /强制进入 edit/);
      assert.equal(executorCallCount, 4);

      const toolLogs = await store.toolInvocations.listBySession(session.id);
      assert.equal(toolLogs.length, 2);
      assert.equal(toolLogs[0]?.toolName, "view");
      assert.equal(toolLogs[1]?.toolName, "edit");

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("不要继续对同一路径发起纯只读 toolCalls"),
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("高风险共享路径上的 import 级表层补丁不能长期占住 modify phase", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-high-risk-superficial-"));

    try {
      const targetPath = path.join(tempRoot, "adapters.py");
      const testsDir = path.join(tempRoot, "tests");
      await writeFile(
        targetPath,
        [
          "def normalize_timeout(value):",
          "    if value is None:",
          "        return None",
          "    if value < 0:",
          "        raise ValueError(\"timeout must be >= 0\")",
          "    return value",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(testsDir, { recursive: true });
      await writeFile(path.join(testsDir, "__init__.py"), "", "utf8");
      await writeFile(
        path.join(testsDir, "test_adapters.py"),
        [
          "import unittest",
          "",
          "import adapters",
          "",
          "",
          "class AdapterBehaviorTests(unittest.TestCase):",
          "    def test_none_timeout(self):",
          "        self.assertEqual(adapters.normalize_timeout(None), 30)",
          "",
          "",
          "if __name__ == \"__main__\":",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryRuntimeStore();
      const now = "2026-03-26T13:00:00.000Z";
      const workspace: Workspace = {
        id: "workspace_high_risk_superficial",
        path: tempRoot,
        label: "high-risk-superficial",
        createdAt: now,
        updatedAt: now,
      };
      const session: Session = {
        id: "session_high_risk_superficial",
        workspaceId: workspace.id,
        title: "high risk superficial session",
        status: "active",
        activeAgentMode: "build",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: now,
        updatedAt: now,
      };

      store.workspacesMap.set(workspace.id, workspace);
      store.sessionsMap.set(session.id, session);

      let sequence = 0;
      let executorCallCount = 0;
      const service = new GoalDrivenRuntimeService(store, {
        now: () => now,
        createId: (prefix: string) => `${prefix}_${++sequence}`,
      });
      const runtime = createAgentLangGraph(service, {
        checkpointer: new PersistentLangGraphCheckpointSaver(
          new InMemoryLangGraphCheckpointRepository(),
        ),
        toolExecutor: new RuntimeToolExecutor(
          store,
          createBuiltinToolRegistry(),
          () => now,
          (prefix) => `${prefix}_${++sequence}`,
        ),
        toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
        maxToolRounds: 10,
        hooks: {
          goalFactory: async () => ({
            title: "修复 adapters.py 的 timeout 默认值",
            description: "共享热路径上的行为修复不能只停在 import 级补丁。",
            successCriteria: ["命中 normalize_timeout 函数体", "目标测试通过"],
          }),
          planner: async () => ({
            summary: "读取源码和测试，先尝试修改，再确认目标测试通过。",
            status: "ready",
            steps: [
              {
                id: "plan_step_view_source",
                title: "读取 adapters.py",
                description: "确认 timeout 逻辑。",
                status: "in_progress",
              },
              {
                id: "plan_step_view_test",
                title: "读取测试文件",
                description: "确认目标测试。",
                status: "todo",
              },
              {
                id: "plan_step_modify",
                title: "修改 timeout 逻辑",
                description: "必须命中 normalize_timeout 函数体。",
                status: "todo",
              },
              {
                id: "plan_step_verify",
                title: "运行目标测试",
                description: "确认 test_none_timeout 通过。",
                status: "todo",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (state) => {
            executorCallCount += 1;
            const toolMessages = state.messages.filter((message) => message.role === "tool");
            const systemMessages = state.messages.filter((message) => message.role === "system");
            const sawSourceView = toolMessages.some((message) => message.content.includes("path=adapters.py"));
            const sawTestView = toolMessages.some((message) => message.content.includes("path=tests/test_adapters.py"));
            const editMessages = toolMessages.filter((message) => message.content.includes("tool=edit"));
            const sawSuperficialNudge = systemMessages.some(
              (message) =>
                message.content.includes("共享热路径")
                && message.content.includes("当前 edit 只在目标文件上做 import/comment/表层整理")
                && message.content.includes("目标代码路径：adapters.py"),
            );
            const sawBehaviorVerify = toolMessages.some(
              (message) =>
                message.content.includes("tool=bash")
                && message.content.includes("python3 -m unittest tests.test_adapters.AdapterBehaviorTests.test_none_timeout")
                && message.content.includes("\"exitCode\":0"),
            );

            if (!sawSourceView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_source",
                    reasoning: "先看 adapters.py。",
                    input: { path: "adapters.py" },
                  },
                ],
              };
            }

            if (!sawTestView) {
              return {
                executionPhase: "explain",
                toolCalls: [
                  {
                    name: "view",
                    taskId: "plan_step_view_test",
                    reasoning: "确认目标测试。",
                    input: { path: "tests/test_adapters.py" },
                  },
                ],
              };
            }

            if (sawSuperficialNudge && editMessages.length === 0) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "收到策略提示后，真正命中 normalize_timeout 函数体。",
                    input: {
                      path: "adapters.py",
                      search: [
                        "def normalize_timeout(value):",
                        "    if value is None:",
                        "        return None",
                        "    if value < 0:",
                        "        raise ValueError(\"timeout must be >= 0\")",
                        "    return value",
                      ].join("\n"),
                      replace: [
                        "def normalize_timeout(value):",
                        "    if value is None:",
                        "        return 30",
                        "    if value < 0:",
                        "        raise ValueError(\"timeout must be >= 0\")",
                        "    return value",
                      ].join("\n"),
                    },
                  },
                ],
              };
            }

            if (editMessages.length === 0) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "plan_step_modify",
                    reasoning: "先落一版 import 级补丁，验证 runtime 不允许它长期占住 modify phase。",
                    input: {
                      path: "adapters.py",
                      search: "def normalize_timeout(value):",
                      replace: "from typing import Optional\n\ndef normalize_timeout(value):",
                    },
                  },
                ],
              };
            }

            if (!sawBehaviorVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "plan_step_verify",
                    reasoning: "运行目标测试。",
                    input: {
                      command: "python3 -m unittest tests.test_adapters.AdapterBehaviorTests.test_none_timeout",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经命中 normalize_timeout 函数体并通过目标测试。",
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["高风险共享路径上的 import 级补丁没有长期占住 modify phase。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "高风险共享路径上的表层补丁会被继续追到真实函数体修改",
            openLoops: [],
            nextActions: [],
            importantFacts: ["adapters.py 这类共享热路径不能只停在 import 级补丁"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "修复 adapters.py 里的 normalize_timeout，让 tests/test_adapters.py 里的 test_none_timeout 通过。",
      });

      const finalContent = await readFile(targetPath, "utf8");
      assert.match(finalContent, /return 30/);
      assert.doesNotMatch(finalContent, /from typing import Optional/);
      assert.equal(executorCallCount >= 6, true);

      const messages = await store.messages.listBySession(session.id);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "system"
            && message.content.includes("共享热路径")
            && message.content.includes("当前 edit 只在目标文件上做 import/comment/表层整理")
            && (
              message.content.includes("目标代码路径：adapters.py")
              || message.content.includes("normalize_timeout")
            ),
        ),
        true,
      );
      assert.equal(
        messages.filter(
          (message) => message.role === "tool" && message.content.includes("tool=edit"),
        ).length,
        1,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
