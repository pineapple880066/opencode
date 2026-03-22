import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
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
import { createBuiltinToolRegistry, ToolPermissionDeniedError } from "@agent-ide/tools";

import type {
  PersistedCheckpoint,
  RuntimeStore,
  ToolInvocationLog,
} from "./store.js";
import { RuntimeToolExecutor } from "./tooling.js";

class InMemoryRuntimeStore implements RuntimeStore {
  readonly sessionMap = new Map<string, Session>();
  readonly toolLogs: ToolInvocationLog[] = [];

  readonly workspaces = {
    upsert: async (_workspace: Workspace) => undefined,
    getById: async (_id: string) => null,
    getByPath: async (_path: string) => null,
  };

  readonly sessions = {
    create: async (session: Session) => {
      this.sessionMap.set(session.id, session);
    },
    getById: async (id: string) => this.sessionMap.get(id) ?? null,
    listByWorkspace: async (_workspaceId: string) => [],
    listByParentSession: async (_parentSessionId: string) => [],
    rename: async () => undefined,
    archive: async () => undefined,
    updateSummary: async () => undefined,
    setActiveGoal: async () => undefined,
  };

  readonly goals = {
    create: async (_goal: Goal) => undefined,
    getById: async (_id: string) => null,
    listBySession: async (_sessionId: string) => [],
    updateStatus: async () => undefined,
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
    append: async () => undefined,
    listBySession: async () => [],
  };

  readonly checkpoints = {
    create: async (_checkpoint: PersistedCheckpoint) => undefined,
    listBySession: async () => [],
  };

  readonly subagentRuns = {
    create: async (_run: SubagentRun) => undefined,
    getById: async (_id: string) => null,
    complete: async () => undefined,
    listByParentSession: async () => [],
  };

  readonly toolInvocations = {
    start: async (log: ToolInvocationLog) => {
      this.toolLogs.push(log);
    },
    finish: async (id: string, status: ToolInvocationLog["status"], outputJson: string | undefined, updatedAt: string) => {
      const existing = this.toolLogs.find((item) => item.id === id);
      if (!existing) {
        throw new Error(`未找到 tool invocation: ${id}`);
      }

      existing.status = status;
      existing.outputJson = outputJson;
      existing.updatedAt = updatedAt;
    },
    listBySession: async (_sessionId: string) => this.toolLogs,
  };
}

describe("RuntimeToolExecutor", () => {
  let workspaceRoot = "";

  before(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "agent-ide-tools-"));
  });

  after(async () => {
    // 临时目录会留在系统 tmp 下，测试场景里不强制清理，避免引入额外复杂度。
  });

  test("build 模式可以执行真实文件工具", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_build", {
      id: "session_build",
      workspaceId: "workspace_1",
      title: "build session",
      status: "active",
      activeAgentMode: "build",
      summary: {
        shortSummary: "",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      } satisfies SessionSummary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const writeResult = await executor.execute({
      sessionId: "session_build",
      name: "write",
      input: {
        root: workspaceRoot,
        path: "notes/hello.txt",
        content: "hello planning mode",
        createDirectories: true,
      },
    });

    assert.equal(writeResult.ok, true);

    const viewResult = await executor.execute<any, { content: string }>({
      sessionId: "session_build",
      name: "view",
      input: {
        root: workspaceRoot,
        path: "notes/hello.txt",
      },
    });

    assert.equal(viewResult.ok, true);
    assert.match(viewResult.output?.content ?? "", /hello planning mode/);

    const grepResult = await executor.execute<any, { matches: Array<{ path: string }> }>({
      sessionId: "session_build",
      name: "grep",
      input: {
        root: workspaceRoot,
        query: "planning",
      },
    });

    assert.equal(grepResult.ok, true);
    assert.equal(grepResult.output?.matches[0]?.path, "notes/hello.txt");

    const diskContent = await readFile(path.join(workspaceRoot, "notes/hello.txt"), "utf8");
    assert.equal(diskContent, "hello planning mode");
  });

  test("plan 模式会真实拒绝写工具", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_plan", {
      id: "session_plan",
      workspaceId: "workspace_1",
      title: "plan session",
      status: "active",
      activeAgentMode: "plan",
      summary: {
        shortSummary: "",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      } satisfies SessionSummary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());

    await assert.rejects(
      () =>
        executor.execute({
          sessionId: "session_plan",
          name: "write",
          input: {
            root: workspaceRoot,
            path: "blocked.txt",
            content: "should fail",
          },
        }),
      ToolPermissionDeniedError,
    );

    assert.equal(store.toolLogs.length, 1);
    assert.equal(store.toolLogs[0]?.status, "failed");
  });

  test("build 模式执行 bash 需要显式批准", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_bash", {
      id: "session_bash",
      workspaceId: "workspace_1",
      title: "bash session",
      status: "active",
      activeAgentMode: "build",
      summary: {
        shortSummary: "",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      } satisfies SessionSummary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());

    await assert.rejects(
      () =>
        executor.execute({
          sessionId: "session_bash",
          name: "bash",
          input: {
            root: workspaceRoot,
            command: "pwd",
          },
        }),
      /需要额外批准/,
    );

    const bashResult = await executor.execute<any, { stdout: string }>({
      sessionId: "session_bash",
      name: "bash",
      approvalGranted: true,
      input: {
        root: workspaceRoot,
        command: "pwd",
      },
    });

    assert.equal(bashResult.ok, true);
    assert.match(bashResult.output?.stdout ?? "", /agent-ide-tools-/);
  });

  test("build 模式的 edit 工具兼容 file_path 和 oldString/newString 这类外部 agent 参数风格", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_edit_aliases", {
      id: "session_edit_aliases",
      workspaceId: "workspace_1",
      title: "edit alias session",
      status: "active",
      activeAgentMode: "build",
      summary: {
        shortSummary: "",
        openLoops: [],
        nextActions: [],
        importantFacts: [],
      } satisfies SessionSummary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const filePath = path.join(workspaceRoot, "notes", "alias-test.ts");
    await writeFile(
      filePath,
      [
        "import type { Pool } from \"mysql2/promise\";",
        "",
        "export const value = 1;",
        "",
      ].join("\n"),
      "utf8",
    );

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const result = await executor.execute({
      sessionId: "session_edit_aliases",
      name: "edit",
      input: {
        root: workspaceRoot,
        file_path: "notes/alias-test.ts",
        oldString: "import type { Pool } from \"mysql2/promise\";",
        newString:
          "// Add two comment lines as requested\n// This is a simple test modification\nimport type { Pool } from \"mysql2/promise\";",
      },
    });

    assert.equal(result.ok, true);

    const updatedContent = await readFile(filePath, "utf8");
    assert.match(updatedContent, /Add two comment lines as requested/);
    assert.match(updatedContent, /This is a simple test modification/);
  });
});
