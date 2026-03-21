import type { Pool } from "mysql2/promise";

import type { RuntimeStore } from "@agent-ide/runtime";

import type { SessionSummaryCache } from "./cache.js";
import {
  MySqlGoalRepository,
  MySqlMemoryRepository,
  MySqlPlanRepository,
  MySqlSessionRepository,
  MySqlTaskRepository,
  MySqlWorkspaceRepository,
} from "./repositories.js";

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
  };
}

