// 本测试文件用于验证同级目录 browser.ts 模块的功能
// 测试范围：URL 参数序列化/反序列化、data-action 数据集解析、导航状态约简
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  parseIdeShellActionDataset,
  parseIdeShellNavigation,
  reduceIdeShellBrowserAction,
  renderIdeShellBrowserDocument,
  serializeIdeShellNavigation,
} from "./browser.js";
import { buildIdeShellState } from "./shell.js";
import { seedIdeShellService } from "./testing.js";

describe("ide browser runtime", () => {
  test("可以序列化和解析 shell 导航参数", () => {
    const search = serializeIdeShellNavigation({
      workspacePath: "/tmp/project",
      selectedSessionId: "session_parent",
      selectedFilePath: "README.md",
      selectedRunId: "subagent_run_1",
      selectedParentTaskId: "task_parent",
      selectedTimelineIndex: 1,
      focusedPanel: "inspector",
      conversationPane: "collapsed",
      terminalPane: "collapsed",
    });
    const parsed = parseIdeShellNavigation(search);

    assert.deepEqual(parsed, {
      workspacePath: "/tmp/project",
      selectedSessionId: "session_parent",
      selectedFilePath: "README.md",
      selectedRunId: "subagent_run_1",
      selectedParentTaskId: "task_parent",
      selectedTimelineIndex: 1,
      focusedPanel: "inspector",
      conversationPane: "collapsed",
      terminalPane: "collapsed",
    });
  });

  test("会把 data-action 数据集还原成导航动作，并生成下一次导航输入", async () => {
    const service = await seedIdeShellService();
    const initial = await buildIdeShellState(service, {
      workspacePath: "/tmp/project",
    });
    const action = parseIdeShellActionDataset({
      action: "inspect-timeline",
      index: "0",
    });

    assert.ok(action);

    const nextNavigation = reduceIdeShellBrowserAction(initial, action);

    assert.equal(nextNavigation.focusedPanel, "inspector");
    assert.equal(nextNavigation.selectedTimelineIndex, 0);
    assert.equal(nextNavigation.selectedRunId, "subagent_run_1");
  });

  test("会把 pane toggle 动作编码回导航参数", async () => {
    const service = await seedIdeShellService();
    const initial = await buildIdeShellState(service, {
      workspacePath: "/tmp/project",
      conversationPane: "open",
      terminalPane: "open",
    });
    const action = parseIdeShellActionDataset({
      action: "toggle-conversation-pane",
    });

    assert.deepEqual(action, {
      type: "toggle-conversation-pane",
    });

    const nextNavigation = reduceIdeShellBrowserAction(initial, action);

    assert.equal(nextNavigation.conversationPane, "collapsed");
    assert.equal(nextNavigation.terminalPane, "open");
    assert.equal(nextNavigation.focusedPanel, "workbench");
  });

  test("会渲染出带浏览器运行时脚本的 IDE 文档", async () => {
    const service = await seedIdeShellService();
    const state = await buildIdeShellState(service, {
      workspacePath: "/tmp/project",
      conversationPane: "collapsed",
      terminalPane: "collapsed",
    });
    const html = renderIdeShellBrowserDocument(state, {
      workspacePath: "/tmp/project",
      conversationPane: "collapsed",
      terminalPane: "collapsed",
    });

    assert.match(html, /data-browser-runtime="ide-shell"/);
    assert.match(html, /id="ide-shell-navigation"/);
    assert.match(html, /id="ide-shell-state"/);
    assert.match(html, /window\.history\.replaceState/);
    assert.match(html, /fetch\(invokePath/);
    assert.match(html, /terminalRunPath/);
    assert.match(html, /data-action="open-replay"/);
    assert.match(html, /Show Agent/);
    assert.match(html, /Show Terminal/);
    assert.match(html, /conversationPane":"collapsed"/);
    assert.match(html, /terminalPane":"collapsed"/);
  });

  test("当文件面板可用时，浏览器文档会包含保存文件表单", async () => {
    const service = await seedIdeShellService();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-browser-"));

    try {
      await writeFile(path.join(tempRoot, "draft.ts"), "export const answer = 42;\n");

      const state = await buildIdeShellState(service, {
        workspacePath: tempRoot,
        focusedPanel: "workbench",
        selectedFilePath: "draft.ts",
      });
      const html = renderIdeShellBrowserDocument(state, {
        workspacePath: tempRoot,
        focusedPanel: "workbench",
        selectedFilePath: "draft.ts",
      });

      assert.match(html, /data-ide-submit="save-file"/);
      assert.match(html, /class="editor-textarea"/);
      assert.match(html, /Save File/);
      assert.match(html, /draft\.ts/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
