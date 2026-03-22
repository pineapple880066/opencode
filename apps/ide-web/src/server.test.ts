import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { createIdeShellServer } from "./server.js";
import { seedIdeShellService } from "./testing.js";

describe("ide shell server", () => {
  test("会提供可交互的 shell HTML 文档", async () => {
    const service = await seedIdeShellService();
    const server = createIdeShellServer(service, {
      defaultWorkspacePath: "/tmp/project",
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server address is not available");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /data-browser-runtime="ide-shell"/);
      assert.match(html, /id="ide-shell-navigation"/);
      assert.match(html, /data-ide-submit="invoke"/);
      assert.match(html, /<h2>Goal<\/h2>|<p class="eyebrow">Goal<\/p>/);
      assert.match(html, /data-action="inspect-timeline"/);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("会暴露 shell state JSON，并支持基于 query 的导航更新", async () => {
    const service = await seedIdeShellService();
    const server = createIdeShellServer(service, {
      defaultWorkspacePath: "/tmp/project",
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server address is not available");
      }

      const stateResponse = await fetch(`http://127.0.0.1:${address.port}/__ide__/state`);
      const payload = (await stateResponse.json()) as {
        navigation: { workspacePath: string };
        state: { selectedSessionId?: string; focusedPanel: string };
      };

      assert.equal(stateResponse.status, 200);
      assert.equal(payload.navigation.workspacePath, "/tmp/project");
      assert.equal(payload.state.selectedSessionId, "session_parent");
      assert.equal(payload.state.focusedPanel, "workbench");

      const inspectorResponse = await fetch(
        `http://127.0.0.1:${address.port}/?workspacePath=${encodeURIComponent("/tmp/project")}&selectedTimelineIndex=0&focusedPanel=inspector`,
      );
      const inspectorHtml = await inspectorResponse.text();

      assert.equal(inspectorResponse.status, 200);
      assert.match(inspectorHtml, /<p class="eyebrow">Inspector<\/p>/);
      assert.match(inspectorHtml, /已经总结出两个风险点|执行阶段完成/);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("会接收 prompt 提交，并返回下一次导航目标", async () => {
    const service = await seedIdeShellService();
    let captured: { workspacePath: string; sessionId?: string; prompt: string } | undefined;
    const server = createIdeShellServer(service, {
      defaultWorkspacePath: "/tmp/project",
      invoke: async (input) => {
        captured = input;
        return {
          sessionId: input.sessionId ?? "session_parent",
        };
      },
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server address is not available");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/__ide__/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspacePath: "/tmp/project",
          sessionId: "session_parent",
          prompt: "继续追踪当前 delegation",
        }),
      });
      const payload = (await response.json()) as {
        sessionId: string;
        navigation: {
          workspacePath: string;
          selectedSessionId: string;
          focusedPanel: string;
        };
      };

      assert.equal(response.status, 200);
      assert.deepEqual(captured, {
        workspacePath: "/tmp/project",
        sessionId: "session_parent",
        prompt: "继续追踪当前 delegation",
        selectedFilePath: undefined,
      });
      assert.equal(payload.sessionId, "session_parent");
      assert.equal(payload.navigation.workspacePath, "/tmp/project");
      assert.equal(payload.navigation.selectedSessionId, "session_parent");
      assert.equal(payload.navigation.focusedPanel, "workbench");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("会接收文件保存请求，并返回 files 面板导航", async () => {
    const service = await seedIdeShellService();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-server-"));
    let captured:
      | { workspacePath: string; sessionId?: string; filePath: string; content: string }
      | undefined;
    const server = createIdeShellServer(service, {
      defaultWorkspacePath: tempRoot,
      saveFile: async (input) => {
        captured = input;
        return {
          filePath: input.filePath,
          sessionId: input.sessionId,
        };
      },
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server address is not available");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/__ide__/save-file`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspacePath: tempRoot,
          sessionId: "session_parent",
          filePath: "notes.md",
          content: "# updated\n",
        }),
      });
      const payload = (await response.json()) as {
        filePath: string;
        navigation: {
          workspacePath: string;
          selectedSessionId?: string;
          selectedFilePath?: string;
          focusedPanel: string;
        };
      };

      assert.equal(response.status, 200);
      assert.deepEqual(captured, {
        workspacePath: tempRoot,
        sessionId: "session_parent",
        filePath: "notes.md",
        content: "# updated\n",
      });
      assert.equal(payload.filePath, "notes.md");
      assert.equal(payload.navigation.workspacePath, tempRoot);
      assert.equal(payload.navigation.selectedSessionId, "session_parent");
      assert.equal(payload.navigation.selectedFilePath, "notes.md");
      assert.equal(payload.navigation.focusedPanel, "workbench");
    } finally {
      server.close();
      await once(server, "close");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("会接收终端命令请求，并返回 workbench 导航", async () => {
    const service = await seedIdeShellService();
    let captured:
      | { workspacePath: string; sessionId?: string; selectedFilePath?: string; command: string }
      | undefined;
    const server = createIdeShellServer(service, {
      defaultWorkspacePath: "/tmp/project",
      runTerminal: async (input) => {
        captured = input;
        return {
          sessionId: input.sessionId,
          selectedFilePath: input.selectedFilePath,
        };
      },
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server address is not available");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/__ide__/terminal/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspacePath: "/tmp/project",
          sessionId: "session_parent",
          selectedFilePath: "apps/ide-web/src/browser.ts",
          command: "pwd",
        }),
      });
      const payload = (await response.json()) as {
        navigation: {
          workspacePath: string;
          selectedSessionId?: string;
          selectedFilePath?: string;
          focusedPanel: string;
        };
      };

      assert.equal(response.status, 200);
      assert.deepEqual(captured, {
        workspacePath: "/tmp/project",
        sessionId: "session_parent",
        selectedFilePath: "apps/ide-web/src/browser.ts",
        command: "pwd",
      });
      assert.equal(payload.navigation.workspacePath, "/tmp/project");
      assert.equal(payload.navigation.selectedSessionId, "session_parent");
      assert.equal(payload.navigation.selectedFilePath, "apps/ide-web/src/browser.ts");
      assert.equal(payload.navigation.focusedPanel, "workbench");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
