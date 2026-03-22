// Add two comment lines as requested
// This is a simple test modification
import type { Pool } from "mysql2/promise";

import {
  SessionSummaryCache,
  bootstrapMySqlPersistence,
  connectRedisPersistence,
  createMySqlLangGraphCheckpointSaver,
  createMySqlRuntimeStore,
  disposeRedisClient,
  inspectRedisHealth,
  readPersistenceConfig,
  type AgentRedisClient,
  type MySqlBootstrapOptions,
  type MySqlSchemaInspection,
  type PersistenceConfig,
  type RedisHealthReport,
} from "@agent-ide/db";
import {
  createAgentLangGraph,
  GoalDrivenRuntimeService,
  RuntimeToolExecutor,
  type AgentLangGraphRuntime,
  type LangGraphHooks,
  type RuntimeServiceOptions,
  type RuntimeStore,
} from "@agent-ide/runtime";
import { createBuiltinToolRegistry, type ToolRegistry } from "@agent-ide/tools";

export interface IdeRuntimeHealthReport {
  mysql: MySqlSchemaInspection & {
    createdDatabase: boolean;
    appliedInitialSchema: boolean;
  };
  redis: RedisHealthReport;
}

export interface IdeRuntimeBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  persistence?: MySqlBootstrapOptions;
  hooks?: LangGraphHooks;
  registry?: ToolRegistry;
  runtimeServiceOptions?: Partial<RuntimeServiceOptions>;
}

export interface IdeRuntimeEnvironment {
  config: PersistenceConfig;
  pool: Pool;
  redis: AgentRedisClient;
  summaryCache: SessionSummaryCache;
  store: RuntimeStore;
  service: GoalDrivenRuntimeService;
  toolRegistry: ToolRegistry;
  toolExecutor: RuntimeToolExecutor;
  langGraph: AgentLangGraphRuntime;
  health: IdeRuntimeHealthReport;
  dispose: () => Promise<void>;
}

// 面试点：这里是组合根，不是业务层。
// 真正的 runtime 规则仍然在 service / graph / store 合同里，
// 这个文件只负责把 MySQL、Redis、tool registry 和 LangGraph 接成一条启动链路。
export async function createIdeRuntimeEnvironment(
  options?: IdeRuntimeBootstrapOptions,
): Promise<IdeRuntimeEnvironment> {
  const config = readPersistenceConfig(options?.env);
  const mysql = await bootstrapMySqlPersistence(config.mysql, options?.persistence);
  let redis: AgentRedisClient | undefined;

  try {
    const redisBootstrap = await connectRedisPersistence(config.redis);
    redis = redisBootstrap.client;

    const summaryCache = new SessionSummaryCache(redis, {
      sessionSummaryTtlSeconds: config.redis.sessionSummaryTtlSeconds,
    });
    const store = createMySqlRuntimeStore(mysql.pool, {
      summaryCache,
    });
    const service = new GoalDrivenRuntimeService(store, options?.runtimeServiceOptions);
    const toolRegistry = options?.registry ?? createBuiltinToolRegistry();
    const toolExecutor = new RuntimeToolExecutor(store, toolRegistry);
    const checkpointer = createMySqlLangGraphCheckpointSaver(mysql.pool);
    const langGraph = createAgentLangGraph(service, {
      hooks: options?.hooks,
      checkpointer,
      toolExecutor,
    });
    const redisHealth = await inspectRedisHealth(redis);

    return {
      config,
      pool: mysql.pool,
      redis,
      summaryCache,
      store,
      service,
      toolRegistry,
      toolExecutor,
      langGraph,
      health: {
        mysql: {
          ...mysql.schema,
          createdDatabase: mysql.createdDatabase,
          appliedInitialSchema: mysql.appliedInitialSchema,
        },
        redis: redisHealth,
      },
      dispose: async () => {
        await disposeRedisClient(redis);
        await mysql.pool.end();
      },
    };
  } catch (error) {
    await disposeRedisClient(redis);
    await mysql.pool.end();
    throw error;
  }
}
