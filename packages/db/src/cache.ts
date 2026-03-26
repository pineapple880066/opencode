import type { SessionSummary } from "@agent-ide/core";

import type { RedisConfig } from "./config.js";
import { REDIS_KEYS, type AgentRedisClient } from "./redis.js";

/**
 * SessionSummaryCache - Redis 缓存封装
 *
 * 简短说明：该类封装了对会话摘要（`SessionSummary`）的 Redis 缓存访问，
 * 将 key 的构造委托给 `REDIS_KEYS.sessionSummary(sessionId)`，并统一处理
 * JSON 序列化/反序列化与 TTL（通过构造函数注入的配置）。
 *
 * 设计要点：
 * - 不直接暴露底层 Redis client API，便于未来替换实现或添加度量/监控
 * - `get` 返回值为 `SessionSummary | null`，调用方可据此判断缓存未命中
 */
export class SessionSummaryCache {
  constructor(
    private readonly client: AgentRedisClient,
    private readonly config: Pick<RedisConfig, "sessionSummaryTtlSeconds">,
  ) { }

  /**
   * 从 Redis 中读取 session summary。
   * - 成功时返回解析后的 `SessionSummary` 对象
   * - 缓存未命中或 key 不存在时返回 `null`
   *
   * @param sessionId 会话 ID，用于构造 Redis key
   */
  async get(sessionId: string): Promise<SessionSummary | null> {
    const raw = await this.client.get(REDIS_KEYS.sessionSummary(sessionId));
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as SessionSummary;
  }

  /**
   * 将 session summary 写入 Redis，并设置过期时间（TTL）。
   * 使用 JSON.stringify 做序列化，写入时应用 `sessionSummaryTtlSeconds`。
   *
   * @param sessionId 会话 ID，用于构造 Redis key
   * @param summary 要缓存的会话摘要对象
   */
  async set(sessionId: string, summary: SessionSummary): Promise<void> {
    await this.client.set(REDIS_KEYS.sessionSummary(sessionId), JSON.stringify(summary), {
      EX: this.config.sessionSummaryTtlSeconds,
    });
  }

  /**
   * 删除指定会话的缓存条目。
   * 常用于在会话更新后使缓存失效，保证下次读取获得最新数据。
   *
   * @param sessionId 会话 ID，用于构造 Redis key
   */
  async delete(sessionId: string): Promise<void> {
    await this.client.del(REDIS_KEYS.sessionSummary(sessionId));
  }
}

