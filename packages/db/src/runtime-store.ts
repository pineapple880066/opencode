import type { Pool } from "mysql2/promise";

import type { RuntimeStore } from "@agent-ide/runtime";

import type { SessionSummaryCache } from "./cache.js";
import {
  MySqlCheckpointRepository,
  MySqlGoalRepository,
  MySqlMemoryRepository,
  MySqlMessageRepository,
  MySqlPlanRepository,
  MySqlSessionRepository,
  MySqlSubagentRunRepository,
  MySqlTaskRepository,
  MySqlToolInvocationRepository,
  MySqlWorkspaceRepository,
} from "./repositories.js";

// 面试点：runtime 只依赖 RuntimeStore 抽象，不直接依赖 MySQL 实现。
// 这样可以把业务层和基础设施层拆开，后面无论接 LangGraph、测内存版 store，
// 还是切换持久化实现，代价都会低很多。
// 这个适配器把 db 包里的具体 MySQL/Redis 实现，拼成 runtime 可消费的 RuntimeStore。
export function createMySqlRuntimeStore(
  pool: Pool,
  options?: {
    summaryCache?: SessionSummaryCache;
  },
): RuntimeStore {
  return {
    workspaces: new MySqlWorkspaceRepository(pool),
    sessions: new MySqlSessionRepository(pool, options?.summaryCache),
    goals: new MySqlGoalRepository(pool),
    plans: new MySqlPlanRepository(pool),
    tasks: new MySqlTaskRepository(pool),
    memory: new MySqlMemoryRepository(pool),
    messages: new MySqlMessageRepository(pool),
    checkpoints: new MySqlCheckpointRepository(pool),
    subagentRuns: new MySqlSubagentRunRepository(pool),
    toolInvocations: new MySqlToolInvocationRepository(pool),
  };
}
