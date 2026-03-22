import { randomUUID } from "node:crypto";

import type { RowDataPacket } from "mysql2/promise";

import { loadWorkspaceEnv } from "@agent-ide/db";
import { createIdeRuntimeEnvironment } from "@agent-ide/ide-web";

// 这不是纯单测，而是拿真实 MySQL / Redis 基础设施做端到端 smoke。
// 它的价值在于把“代码看起来对”推进到“真实环境里确实跑过”。
async function main(): Promise<void> {
  loadWorkspaceEnv();
  const environment = await createIdeRuntimeEnvironment({
    persistence: {
      createDatabaseIfMissing: true,
      applyInitialSchema: true,
    },
    hooks: {
      planner: async (state) => ({
        summary: "为 smoke test 生成最小执行计划",
        status: "in_progress",
        steps: [
          {
            title: "验证持久化 bootstrap",
            description: "确认 MySQL schema、Redis 和 LangGraph checkpointer 都能真实工作",
            status: "in_progress",
            evidence: `goal=${state.activeGoal.id}`,
          },
        ],
      }),
      reviewer: async () => ({
        satisfied: false,
        reasons: ["smoke test 只验证基础设施链路，不宣称功能全部完成"],
        remainingRisks: ["仍需继续扩展完整场景测试"],
        recommendedNextStep: "继续补更复杂的 orchestration 与 UI",
      }),
      summarizer: async (state) => ({
        shortSummary: "smoke test 已跑通 bootstrap 与 durable execution 基链路",
        openLoops: ["等待更完整场景测试"],
        nextActions: ["继续推进 subagent orchestration", "补 IDE UI"],
        importantFacts: [
          `planCount=${state.currentPlan ? 1 : 0}`,
          `taskCount=${state.tasks.length}`,
        ],
      }),
    },
  });

  try {
    const database = environment.config.mysql.database;
    const workspacePath = process.cwd();
    const session = await environment.service.createSession({
      workspacePath,
      title: "Persistence Smoke Session",
      agentMode: "build",
    });

    const goal = await environment.service.createGoal({
      sessionId: session.id,
      title: "验证 bootstrap 与 durable execution",
      description: "确保 MySQL / Redis / LangGraph checkpointer 在真实环境里打通",
      successCriteria: [
        "session 与 goal 能落库",
        "LangGraph invoke 后有 durable checkpoint",
        "Redis summary cache 可读回",
      ],
    });

    await environment.langGraph.invoke({
      sessionId: session.id,
      userMessage: "请执行一次 bootstrap smoke test",
    });

    await environment.service.updateSessionSummary({
      sessionId: session.id,
      shortSummary: "smoke summary",
      openLoops: ["待补完整场景测试"],
      nextActions: ["继续做 orchestration"],
      importantFacts: [`goal=${goal.id}`],
    });

    const cachedSummary = await environment.summaryCache.get(session.id);
    if (!cachedSummary || cachedSummary.shortSummary !== "smoke summary") {
      throw new Error("Redis session summary cache 未通过验证");
    }

    const [checkpointRows] = await environment.pool.query<Array<RowDataPacket & { count: number }>>(
      `
        SELECT COUNT(*) AS count
        FROM langgraph_checkpoints
        WHERE thread_id = ?
      `,
      [session.id],
    );
    const [writeRows] = await environment.pool.query<Array<RowDataPacket & { count: number }>>(
      `
        SELECT COUNT(*) AS count
        FROM langgraph_checkpoint_writes
        WHERE thread_id = ?
      `,
      [session.id],
    );

    if (checkpointRows[0]?.count === 0) {
      throw new Error("LangGraph durable checkpoints 未落库");
    }

    const threadState = await environment.langGraph.getThreadState(session.id);
    const output = {
      verifiedAt: new Date().toISOString(),
      database,
      smokeRunId: randomUUID(),
      sessionId: session.id,
      goalId: goal.id,
      mysql: environment.health.mysql,
      redis: environment.health.redis,
      durableExecution: {
        checkpointCount: checkpointRows[0]?.count ?? 0,
        checkpointWriteCount: writeRows[0]?.count ?? 0,
        latestThreadCheckpointId:
          threadState.config.configurable?.checkpoint_id ?? null,
      },
      tooling: {
        registeredTools: environment.toolRegistry.list().map((tool) => tool.name),
      },
      cache: {
        summaryShortText: cachedSummary.shortSummary,
      },
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await environment.dispose();
  }
}

main().catch((error) => {
  console.error("[persistence-smoke] failed");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
