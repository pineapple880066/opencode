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

// 这是整个 IDE runtime 的组合根。
// 读这个文件时，建议你带着一个问题看：
// “一个用户在浏览器里提交 prompt 之后，底层到底是怎样把数据库、缓存、工具系统和 LangGraph 串起来的？”
//
// 这里故意不承载业务判断。它只做装配：
// 1. 读取 MySQL/Redis 配置
// 2. 启动持久化层
// 3. 组装 RuntimeStore / GoalDrivenRuntimeService
// 4. 注册工具系统
// 5. 创建 LangGraph runtime
//
// 这样做的价值是：组合根只关心“怎么接起来”，不关心“具体怎么执行”。
// 真正的业务规则仍然留在 service / langgraph / tools 这些更稳定的层里。
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
