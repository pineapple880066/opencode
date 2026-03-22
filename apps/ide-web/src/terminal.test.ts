import assert from "node:assert/strict";
import { describe, test } from "node:test";
import os from "node:os";

import { createInMemoryWorkbenchTerminalBackend } from "./terminal.js";

describe("workbench terminal backend", () => {
  test("会在指定 workspace 内执行命令并保留最近输出", async () => {
    const terminal = createInMemoryWorkbenchTerminalBackend({
      shell: process.env.SHELL ?? "/bin/zsh",
      timeoutMs: 10_000,
    });
    const workspacePath = os.tmpdir();

    const result = await terminal.runCommand({
      workspacePath,
      command: "printf 'agent-ide-terminal\\n'",
    });
    const history = await terminal.listEntries(workspacePath);

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.match(result.combinedOutput, /agent-ide-terminal/);
    assert.equal(history[0]?.id, result.id);
  });
});
