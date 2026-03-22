import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  buildIdeShellState,
  reduceIdeShellNavigation,
  renderIdeShellDocument,
} from "./shell.js";
import { seedIdeShellService } from "./testing.js";

describe("ide shell", () => {
  test("默认会把 replay 和 delegation 接成可见 shell 状态", async () => {
    const service = await seedIdeShellService();

    const shell = await buildIdeShellState(service, {
      workspacePath: "/tmp/project",
    });

    assert.equal(shell.sessions.length, 2);
    assert.equal(shell.selectedSessionId, "session_parent");
    assert.equal(shell.selectedSessionTitle, "main build session");
    assert.equal(shell.selectedGoalTitle, "修复 delegation");
    assert.equal(shell.selectedRunId, "subagent_run_1");
    assert.equal(shell.selectedParentTaskId, "task_parent");
    assert.equal(shell.focusedPanel, "workbench");
    assert.equal(shell.messages.length, 2);
    assert.ok(shell.goalPanel);
    assert.ok(shell.planPanel);
    assert.ok(shell.activityLog.length >= 3);
    assert.equal(shell.replayPanel?.timeline.length, 3);
    assert.equal(shell.delegationPanel?.delegatedRuns.length, 1);
  });

  test("可以通过导航动作切到 inspector，并检查 timeline 详情", async () => {
    const service = await seedIdeShellService();
    const initial = await buildIdeShellState(service, {
      workspacePath: "/tmp/project",
    });

    const inspectNav = reduceIdeShellNavigation(initial, {
      type: "inspect-timeline",
      index: 0,
    });
    const inspected = await buildIdeShellState(service, inspectNav);

    assert.equal(inspected.focusedPanel, "inspector");
    assert.equal(inspected.selectedTimelineIndex, 0);
    assert.match(inspected.inspector?.detail ?? "", /两个风险点|执行阶段完成/);
  });

  test("会渲染出可点击、可提交 prompt 的 IDE 文档", async () => {
    const service = await seedIdeShellService();
    const initial = await buildIdeShellState(service, {
      workspacePath: "/tmp/project",
    });
    const html = renderIdeShellDocument(initial);

    assert.match(html, /data-action="select-session"/);
    assert.match(html, /data-action="open-replay"/);
    assert.match(html, /data-ide-submit="invoke"/);
    assert.match(html, /data-panel="workbench"/);
    assert.match(html, /data-panel="goal"/);
    assert.match(html, /data-panel="plan"/);
    assert.match(html, /data-panel="activity-log"/);
    assert.match(html, /main-panel is-visible/);
    assert.match(html, /workbench-header/);
    assert.match(html, /Workspace Command Runner/);
    assert.doesNotMatch(html, /Session Context/);
    assert.doesNotMatch(html, /<aside class="sidebar">/);
    assert.match(html, /帮我追踪 delegation 的执行情况/);
  });

  test("当选中文件时，会渲染可保存的编辑器表单", async () => {
    const service = await seedIdeShellService();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-editor-"));

    try {
      await writeFile(path.join(tempRoot, "notes.md"), "# draft\nline two\n");

      const shell = await buildIdeShellState(service, {
        workspacePath: tempRoot,
        focusedPanel: "workbench",
        selectedFilePath: "notes.md",
      });
      const html = renderIdeShellDocument(shell);

      assert.match(html, /data-ide-submit="save-file"/);
      assert.match(html, /name="filePath" value="notes\.md"/);
      assert.match(html, /Save File/);
      assert.match(html, /File Content/);
      assert.match(html, /# draft/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("即使当前没有 session，也可以展示 workspace 文件预览", async () => {
    const service = await seedIdeShellService();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-shell-"));

    try {
      await writeFile(path.join(tempRoot, "README.md"), "# hello\nthis is a file preview test\n");

      const shell = await buildIdeShellState(service, {
        workspacePath: tempRoot,
        focusedPanel: "workbench",
      });

      assert.equal(shell.sessions.length, 0);
      assert.equal(shell.focusedPanel, "workbench");
      assert.equal(shell.workspaceEntries.some((entry) => entry.path === "README.md"), true);
      assert.equal(shell.filePreview?.path, "README.md");
      assert.match(shell.filePreview?.content ?? "", /file preview test/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
