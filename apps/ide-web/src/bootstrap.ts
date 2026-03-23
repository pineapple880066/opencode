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
  // ============================================================================
  // 阶段1: 配置加载
  // ============================================================================
  // 从环境变量读取 MySQL 和 Redis 的连接配置。这里不做任何 I/O，只是解析环境变量。
  // 如果配置缺失或格式错误，readPersistenceConfig 会抛出错误。
  const config = readPersistenceConfig(options?.env);

  // ============================================================================
  // 阶段2: MySQL 持久化初始化
  // ============================================================================
  // 创建 MySQL 连接池，建立数据库（如果不存在），执行初始化 SQL schema。
  // 这一步是必须的，即使 Redis 失败也要先完成，所以它不在 try-catch 里。
  // 返回值包含：pool(连接池)、schema(表信息)、createdDatabase / appliedInitialSchema(初始化标志)
  const mysql = await bootstrapMySqlPersistence(config.mysql, options?.persistence);

  // Redis 连接暂不初始化，但声明变量以便 try-catch 中使用。
  // 这样 finally 块（通过下面的 catch）可以保证清理它。
  let redis: AgentRedisClient | undefined;

  try {
    // ========================================================================
    // 阶段3: Redis 缓存层初始化
    // ========================================================================
    // 连接到 Redis，为会话摘要缓存预热。
    // 如果 Redis 连接失败会抛错，整个启动过程失败（没有 fallback）。
    // 这是有意为之：我们认为 Redis 作为一个关键基础设施组件是必须可用的。
    const redisBootstrap = await connectRedisPersistence(config.redis);
    redis = redisBootstrap.client;

    // ========================================================================
    // 阶段4: 构建会话摘要缓存
    // ========================================================================
    // SessionSummaryCache 包装了 Redis，提供会话摘要的缓存逻辑。
    // TTL(time-to-live) 配置控制缓存条目多久后过期。
    // 这个缓存是后续 RuntimeStore 知道如何查询长对话的关键：
    // 不是每次都从数据库加载整个对话历史，而是从缓存快速获取摘要。
    const summaryCache = new SessionSummaryCache(redis, {
      sessionSummaryTtlSeconds: config.redis.sessionSummaryTtlSeconds,
    });

    // ========================================================================
    // 阶段5: 创建 RuntimeStore（数据访问层）
    // ========================================================================
    // RuntimeStore 是 MySQL 和缓存之间的抽象层。它实现了：
    // - 从数据库加载/保存 Agent 运行时状态
    // - Session 管理及其对应的会话摘要缓存查询
    // - 以及其他持久化相关的逻辑
    //
    // 注意：summaryCache 被传入 store，这样 store 可以在需要时查询或更新摘要。
    // 这是缓存和数据库之间的一次有意的紧耦合——权衡点是：
    // 我们把会话摘要缓存看作是数据库的一个补充，而非独立的系统。
    const store = createMySqlRuntimeStore(mysql.pool, {
      summaryCache,
    });

    // ========================================================================
    // 阶段6: 创建核心业务服务（GoalDrivenRuntimeService）
    // ========================================================================
    // 这是 Agent 执行流程的"大脑"。它知道：
    // - 如何从 store 加载一个目标驱动的运行会话
    // - 如何管理 Agent 在执行过程中的状态转移
    // - 如何与外部系统（如工具调用）交互
    //
    // 注意：service 拥有对 store 的引用，可以在执行时随时读写持久化状态。
    // runtimeServiceOptions 允许调用者定制服务的行为（如超时、并发限制等）。
    const service = new GoalDrivenRuntimeService(store, options?.runtimeServiceOptions);

    // ========================================================================
    // 阶段7: 创建工具系统
    // ========================================================================
    // 工具系统有两个主要部分：
    //
    // 7.1: ToolRegistry
    // ---- 这是一个注册表，存储所有可用的工具的定义和元数据。
    // ---- builtin 工具是系统预装的（如查询目录、读文件等）。
    // ---- 调用者也可以通过 options.registry 传递自定义工具集。
    const toolRegistry = options?.registry ?? createBuiltinToolRegistry();

    // 7.2: RuntimeToolExecutor
    // ---- 这个对象负责执行工具。它将：
    //   - 从 toolRegistry 查找工具定义
    //   - 调用对应的处理函数
    //   - 把结果写回到 store（这样 Agent 可以在下一步看到执行结果）
    //
    // ---- 注意：store 被传入 executor，所以执行工具的结果能落地到数据库。
    const toolExecutor = new RuntimeToolExecutor(store, toolRegistry);

    // ========================================================================
    // 阶段8: 创建 LangGraph 运行时（AI 执行引擎）
    // ========================================================================
    // LangGraph 是 Agent 的执行引擎。它定义了 Agent 的执行流图：
    // 哪些节点要执行、节点之间的条件跳转、以及循环逻辑。
    //
    // 在这一步，我们为 LangGraph 配置三个关键组件：
    //
    // 8.1: checkpointer（checkpoint 保存器）
    // ---- 允许 LangGraph 定期保存执行过程中的中间状态，用于恢复和容错。
    // ---- 我们用 MySQL 作为后端存储这些 checkpoints。
    const checkpointer = createMySqlLangGraphCheckpointSaver(mysql.pool);

    // 8.2: service, toolExecutor, hooks
    // ---- service        = 运行时业务逻辑
    // ---- toolExecutor   = 工具执行委托
    // ---- hooks          = 执行期的生命周期回调（如出现错误、完成一个步骤时调用）
    const langGraph = createAgentLangGraph(service, {
      hooks: options?.hooks,
      checkpointer,
      toolExecutor,
    });

    // ========================================================================
    // 阶段9: 执行系统健康检查
    // ========================================================================
    // 在返回运行时环境之前，通过与 Redis 进行一次健康检查来确认它是可用的。
    // 返回的 redisHealth report 会被包含在最终的 IdeRuntimeEnvironment 对象中。
    const redisHealth = await inspectRedisHealth(redis);

    // ========================================================================
    // 返回完整的运行时环境对象
    // ========================================================================
    // 这个对象汇聚了上面所有的组件，内容如下：
    //
    // - config:        持久化层配置（数据库连接参数等）
    // - pool:          MySQL 连接池，用于直接数据库查询
    // - redis:         Redis 客户端，用于缓存操作
    // - summaryCache:  会话摘要缓存；注意这是个高级接口，应该通过 store 来使用，
    //                  直接操作它是不推荐的
    // - store:         RuntimeStore，所有持久化操作的入口
    // - service:       GoalDrivenRuntimeService，Agent 业务逻辑的核心
    // - toolRegistry:  工具注册表，查询可用工具的地方
    // - toolExecutor:  工具执行器，当 Agent 需要调用工具时通过这个来执行
    // - langGraph:     LangGraph 运行时，Agent 的执行引擎
    // - health:        健康状态报告（MySQL 和 Redis）
    // - dispose:       异步清理函数，关闭所有连接；调用者必须在不需要运行时时执行这个
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
    // ========================================================================
    // 错误恢复
    // ========================================================================
    // 如果在任何一个初始化步骤中出错（通常是 Redis 连接失败），
    // 我们需要清理已经创建的资源以避免泄漏：
    // - 关闭 Redis（如果已连接）
    // - 关闭 MySQL 连接池
    // 然后重新抛出错误，让调用者处理初始化失败的情况
    await disposeRedisClient(redis);
    await mysql.pool.end();
    throw error;
  }
}
