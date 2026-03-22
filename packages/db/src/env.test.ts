import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadWorkspaceEnv } from "./env.js";

describe("workspace env loader", () => {
  test("会自动读取 .env，并保留 shell 已有变量", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-ide-env-"));

    try {
      writeFileSync(
        join(cwd, ".env"),
        [
          "AGENT_IDE_ENV_TEST_FROM_FILE=from-dotenv",
          "AGENT_IDE_ENV_TEST_SHELL=should-not-override",
        ].join("\n"),
      );

      const targetEnv: NodeJS.ProcessEnv = {
        AGENT_IDE_ENV_TEST_SHELL: "from-shell",
      };

      loadWorkspaceEnv({
        cwd,
        targetEnv,
      });

      assert.equal(targetEnv.AGENT_IDE_ENV_TEST_FROM_FILE, "from-dotenv");
      assert.equal(targetEnv.AGENT_IDE_ENV_TEST_SHELL, "from-shell");
    } finally {
      rmSync(cwd, {
        recursive: true,
        force: true,
      });
    }
  });

  test(".env.local 会覆盖 .env，但不会覆盖已有 shell 变量", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-ide-env-"));

    try {
      writeFileSync(join(cwd, ".env"), "AGENT_IDE_ENV_TEST_LAYER=from-dotenv\n");
      writeFileSync(join(cwd, ".env.local"), "AGENT_IDE_ENV_TEST_LAYER=from-dotenv-local\n");

      const targetEnv: NodeJS.ProcessEnv = {};
      loadWorkspaceEnv({
        cwd,
        targetEnv,
      });
      assert.equal(targetEnv.AGENT_IDE_ENV_TEST_LAYER, "from-dotenv-local");

      const shellEnv: NodeJS.ProcessEnv = {
        AGENT_IDE_ENV_TEST_LAYER: "from-shell",
      };
      loadWorkspaceEnv({
        cwd,
        targetEnv: shellEnv,
      });
      assert.equal(shellEnv.AGENT_IDE_ENV_TEST_LAYER, "from-shell");
    } finally {
      rmSync(cwd, {
        recursive: true,
        force: true,
      });
    }
  });
});
