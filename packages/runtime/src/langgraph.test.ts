import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});
