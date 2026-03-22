import { pathToFileURL } from "node:url";

import { loadWorkspaceEnv } from "@agent-ide/db";
import { createIdeRuntimeEnvironment, createMiniMaxHooks } from "@agent-ide/ide-web";

export interface MiniMaxSmokeInvocation {
  prompt: string;
  sessionId?: string;
  reuseLatest: boolean;
}

export function readSmokeInvocation(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): MiniMaxSmokeInvocation {
  const args = [...argv];
  let sessionId: string | undefined;
  let reuseLatest = false;
  const promptParts: string[] = [];

  while (args.length > 0) {
    const current = args.shift();
    if (!current) {
      continue;
    }

    if (current === "--session") {
      sessionId = args.shift()?.trim();
      continue;
    }

    if (current === "--latest") {
      reuseLatest = true;
      continue;
    }

    promptParts.push(current);
  }

  const prompt =
    promptParts.join(" ").trim() ||
    env.MINIMAX_SMOKE_PROMPT?.trim() ||
    "请为这个 agent IDE 创建一个 goal，并生成一份可执行计划。";

  return {
    prompt,
    sessionId: sessionId || env.MINIMAX_SMOKE_SESSION_ID?.trim() || undefined,
    reuseLatest,
  };
}

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const workspacePath = process.env.IDE_WORKSPACE_PATH ?? process.cwd();
  const invocation = readSmokeInvocation();
  const hooks = createMiniMaxHooks({
    env: process.env,
  });
  const runtime = await createIdeRuntimeEnvironment({
    hooks,
  });

  try {
    let session;
    let reusedSession = false;

    if (invocation.sessionId) {
      session = await runtime.service.getSession(invocation.sessionId);
      reusedSession = true;
    } else if (invocation.reuseLatest) {
      const sessions = await runtime.service.listSessionsByWorkspacePath(workspacePath);
      session = [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      reusedSession = Boolean(session);
    }

    if (!session) {
      session = await runtime.service.createSession({
        workspacePath,
        title: `MiniMax smoke ${new Date().toISOString()}`,
        agentMode: "build",
      });
    }

    const result = await runtime.langGraph.invoke({
      sessionId: session.id,
      userMessage: invocation.prompt,
    });

    console.log(
      JSON.stringify(
        {
          sessionId: session.id,
          reusedSession,
          workspacePath,
          activeGoal: result.runtimeState?.activeGoal
            ? {
                id: result.runtimeState.activeGoal.id,
                title: result.runtimeState.activeGoal.title,
                status: result.runtimeState.activeGoal.status,
              }
            : null,
          currentPlan: result.runtimeState?.currentPlan
            ? {
                id: result.runtimeState.currentPlan.id,
                summary: result.runtimeState.currentPlan.summary,
                status: result.runtimeState.currentPlan.status,
              }
            : null,
          taskCount: result.runtimeState?.tasks.length ?? 0,
          subagentRunCount: result.runtimeState?.subagentRuns.length ?? 0,
          executionLog: result.executionLog,
        },
        null,
        2,
      ),
    );
    console.log("");
    console.log("如果你想在浏览器里检查这个 session，可以启动：");
    console.log("  pnpm dev:ide-web");
    console.log("然后打开：");
    console.log(
      `  http://127.0.0.1:3440/?workspacePath=${encodeURIComponent(workspacePath)}&selectedSessionId=${encodeURIComponent(session.id)}`,
    );
    console.log("");
    console.log("如果你想继续追问同一个 session，可以复用：");
    console.log(
      `  pnpm smoke:minimax --session ${session.id} "继续基于当前 goal / plan 往下执行"`,
    );
  } finally {
    await runtime.dispose();
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl && import.meta.url === entryUrl) {
  void main().catch((error) => {
    console.error("[agent-ide] MiniMax smoke failed", error);
    process.exit(1);
  });
}
