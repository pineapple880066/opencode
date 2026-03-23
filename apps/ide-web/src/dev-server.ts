import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import { loadWorkspaceEnv } from "@agent-ide/db";

import { createIdeRuntimeEnvironment } from "./bootstrap.js";
import { createMiniMaxHooks, hasMiniMaxConfig } from "./minimax.js";
import { createIdeShellServer } from "./server.js";
import { createInMemoryWorkbenchTerminalBackend } from "./terminal.js";

function deriveSessionTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return `Agent session ${new Date().toISOString()}`;
  }

  return normalized.length <= 42 ? normalized : `${normalized.slice(0, 39)}...`;
}

function resolveWithinWorkspace(workspacePath: string, candidatePath: string): string {
  const normalizedRoot = path.resolve(workspacePath);
  const target = path.resolve(normalizedRoot, candidatePath);

  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`路径越界: ${candidatePath}`);
  }

  return target;
}

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const runtime = await createIdeRuntimeEnvironment({
    hooks: hasMiniMaxConfig(process.env)
      ? createMiniMaxHooks({
          env: process.env,
        })
      : undefined,
  });
  const terminal = createInMemoryWorkbenchTerminalBackend();
  const port = Number(process.env.PORT ?? "3440");
  const workspacePath = process.env.IDE_WORKSPACE_PATH ?? process.cwd();
  const server = createIdeShellServer(runtime.service, {
    defaultWorkspacePath: workspacePath,
    terminal,
    invoke: async (input) => {
      const session =
        input.sessionId
          ? await runtime.service.getSession(input.sessionId)
          : await runtime.service.createSession({
              workspacePath: input.workspacePath,
              title: deriveSessionTitle(input.prompt),
              agentMode: "build",
            });

      // 这是浏览器 prompt 真正进入 LangGraph 的位置。
      // server.ts 负责 HTTP 和导航协议；到这里 session 已经准备好，
      // 接下来才正式跑一次 intake -> ... -> continue-or-close 主链。
      await runtime.langGraph.invoke({
        sessionId: session.id,
        userMessage: input.prompt,
      });

      return {
        sessionId: session.id,
      };
    },
    runTerminal: async (input) => {
      await terminal.runCommand({
        workspacePath: input.workspacePath,
        command: input.command,
      });

      return {
        sessionId: input.sessionId,
        selectedFilePath: input.selectedFilePath,
      };
    },
    saveFile: async (input) => {
      const targetPath = resolveWithinWorkspace(input.workspacePath, input.filePath);
      await writeFile(targetPath, input.content, "utf8");

      return {
        filePath: input.filePath,
        sessionId: input.sessionId,
      };
    },
  });

  const shutdown = async (signal: string) => {
    server.close();
    await runtime.dispose();
    console.log(`[agent-ide] ${signal} received, IDE shell server stopped.`);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const host = address?.address ?? "127.0.0.1";
  const actualPort = address?.port ?? port;

  console.log(`[agent-ide] IDE shell browser server ready on http://${host}:${actualPort}`);
  console.log(`[agent-ide] workspacePath=${workspacePath}`);
  if (hasMiniMaxConfig(process.env)) {
    console.log("[agent-ide] MiniMax hooks enabled");
  } else {
    console.log("[agent-ide] MiniMax hooks disabled (MINIMAX_API_KEY not set)");
  }
}

void main().catch((error) => {
  console.error("[agent-ide] failed to start IDE shell browser server", error);
  process.exit(1);
});
