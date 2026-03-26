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

  test("build 模式的 view 工具兼容 lineRange 范围参数", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_view_range", {
      id: "session_view_range",
      workspaceId: "workspace_1",
      title: "view range session",
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

    await writeFile(
      path.join(workspaceRoot, "notes", "range.txt"),
      ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"),
      "utf8",
    );

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const viewResult = await executor.execute<any, { content: string; startLine: number; endLine: number }>({
      sessionId: "session_view_range",
      name: "view",
      input: {
        root: workspaceRoot,
        path: "notes/range.txt",
        lineRange: "2-4",
      },
    });

    assert.equal(viewResult.ok, true);
    assert.equal(viewResult.output?.startLine, 2);
    assert.equal(viewResult.output?.endLine, 4);
    assert.equal(viewResult.output?.content, ["line 2", "line 3", "line 4"].join("\n"));
  });

  test("build 模式的 view 工具兼容 offset/limit 分页参数", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_view_offset_limit", {
      id: "session_view_offset_limit",
      workspaceId: "workspace_1",
      title: "view offset limit session",
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

    await writeFile(
      path.join(workspaceRoot, "notes", "offset-limit.txt"),
      ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n"),
      "utf8",
    );

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const viewResult = await executor.execute<any, { content: string; startLine: number; endLine: number }>({
      sessionId: "session_view_offset_limit",
      name: "view",
      input: {
        root: workspaceRoot,
        path: "notes/offset-limit.txt",
        offset: 1,
        limit: 2,
      },
    });

    assert.equal(viewResult.ok, true);
    assert.equal(viewResult.output?.startLine, 2);
    assert.equal(viewResult.output?.endLine, 3);
    assert.equal(viewResult.output?.content, ["beta", "gamma"].join("\n"));
  });

  test("build 模式的 view 工具在传入目录时会退化成目录预览，而不是直接报 EISDIR", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_view_directory", {
      id: "session_view_directory",
      workspaceId: "workspace_1",
      title: "view directory session",
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

    await writeFile(path.join(workspaceRoot, "notes", "dir-preview-a.txt"), "alpha", "utf8");
    await writeFile(path.join(workspaceRoot, "notes", "dir-preview-b.txt"), "beta", "utf8");

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const viewResult = await executor.execute<any, { content: string; totalLines: number; kind?: string }>({
      sessionId: "session_view_directory",
      name: "view",
      input: {
        root: workspaceRoot,
        path: "notes",
        offset: 0,
        limit: 10,
      },
    });

    assert.equal(viewResult.ok, true);
    assert.equal(viewResult.output?.kind, "directory");
    assert.match(viewResult.output?.content ?? "", /file\tdir-preview-a\.txt/);
    assert.match(viewResult.output?.content ?? "", /file\tdir-preview-b\.txt/);
    assert.ok((viewResult.output?.totalLines ?? 0) >= 2);
  });

  test("build 模式的 grep 工具兼容 pattern/keyword 别名，并且可以直接搜索单文件路径", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_grep_pattern_alias", {
      id: "session_grep_pattern_alias",
      workspaceId: "workspace_1",
      title: "grep pattern alias session",
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

    const filePath = path.join(workspaceRoot, "notes", "grep-file.ts");
    await writeFile(
      filePath,
      [
        "export function fromFile(path: string) {",
        "  return path;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const grepResult = await executor.execute<any, { query: string; matches: Array<{ path: string; line: number; content: string }> }>({
      sessionId: "session_grep_pattern_alias",
      name: "grep",
      input: {
        root: workspaceRoot,
        path: "notes/grep-file.ts",
        pattern: "fromFile",
      },
    });

    assert.equal(grepResult.ok, true);
    assert.equal(grepResult.output?.query, "fromFile");
    assert.equal(grepResult.output?.matches.length, 1);
    assert.equal(grepResult.output?.matches[0]?.path, "notes/grep-file.ts");
    assert.equal(grepResult.output?.matches[0]?.line, 1);
    assert.match(grepResult.output?.matches[0]?.content ?? "", /fromFile/);

    const grepByKeyword = await executor.execute<any, { query: string; matches: Array<{ path: string }> }>({
      sessionId: "session_grep_pattern_alias",
      name: "grep",
      input: {
        root: workspaceRoot,
        path: "notes",
        keyword: "fromFile",
      },
    });

    assert.equal(grepByKeyword.ok, true);
    assert.equal(grepByKeyword.output?.query, "fromFile");
    assert.equal(grepByKeyword.output?.matches[0]?.path, "notes/grep-file.ts");
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

  test("build 模式的 bash 工具兼容 cmd / working_directory / timeout_ms 这类外部参数风格", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_bash_aliases", {
      id: "session_bash_aliases",
      workspaceId: "workspace_1",
      title: "bash alias session",
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
    const bashResult = await executor.execute<any, { stdout: string; cwd: string }>({
      sessionId: "session_bash_aliases",
      name: "bash",
      approvalGranted: true,
      input: {
        root: workspaceRoot,
        cmd: "pwd",
        working_directory: ".",
        timeout_ms: 5_000,
      },
    });

    assert.equal(bashResult.ok, true);
    assert.equal(bashResult.output?.cwd, ".");
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

  test("build 模式的 edit 工具兼容 oldText/newText 这类另一组外部 agent 参数风格", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_edit_text_aliases", {
      id: "session_edit_text_aliases",
      workspaceId: "workspace_1",
      title: "edit text alias session",
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

    const filePath = path.join(workspaceRoot, "notes", "alias-text-test.ts");
    await writeFile(
      filePath,
      [
        "export const DEFAULT_LOG_FORMAT = \"%(filename)-25s %(lineno)4d %(levelname)-8s %(message)s\";",
        "",
      ].join("\n"),
      "utf8",
    );

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const result = await executor.execute({
      sessionId: "session_edit_text_aliases",
      name: "edit",
      input: {
        root: workspaceRoot,
        file_path: "notes/alias-text-test.ts",
        oldText: "\"%(filename)-25s %(lineno)4d %(levelname)-8s %(message)s\"",
        newText: "\"%(levelname)-8s %(name)s:%(filename)s:%(lineno)d %(message)s\"",
      },
    });

    assert.equal(result.ok, true);

    const updatedContent = await readFile(filePath, "utf8");
    assert.match(updatedContent, /%\((name)\)s:%\((filename)\)s:%\((lineno)\)d/);
  });

  test("build 模式的 edit 工具兼容 search_replace/new_content 这类 benchmark 风格参数", async () => {
    const store = new InMemoryRuntimeStore();
    store.sessionMap.set("session_edit_benchmark_aliases", {
      id: "session_edit_benchmark_aliases",
      workspaceId: "workspace_1",
      title: "edit benchmark alias session",
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

    const filePath = path.join(workspaceRoot, "notes", "alias-benchmark-test.ts");
    await writeFile(
      filePath,
      [
        "from .packages.urllib3.exceptions import ResponseError",
        "",
      ].join("\n"),
      "utf8",
    );

    const executor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
    const result = await executor.execute({
      sessionId: "session_edit_benchmark_aliases",
      name: "edit",
      input: {
        root: workspaceRoot,
        path: "notes/alias-benchmark-test.ts",
        search_replace: "from .packages.urllib3.exceptions import ResponseError",
        new_content:
          "from .packages.urllib3.exceptions import ResponseError\nfrom .packages.urllib3.exceptions import ClosedPoolError",
      },
    });

    assert.equal(result.ok, true);

    const updatedContent = await readFile(filePath, "utf8");
    assert.match(updatedContent, /ClosedPoolError/);
  });
});
