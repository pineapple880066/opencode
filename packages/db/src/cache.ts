import type { SessionSummary } from "@agent-ide/core";

import type { RedisConfig } from "./config.js";
import { REDIS_KEYS, type AgentRedisClient } from "./redis.js";

export class SessionSummaryCache {
  constructor(
    private readonly client: AgentRedisClient,
    private readonly config: Pick<RedisConfig, "sessionSummaryTtlSeconds">,
  ) {}

  async get(sessionId: string): Promise<SessionSummary | null> {
    const raw = await this.client.get(REDIS_KEYS.sessionSummary(sessionId));
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as SessionSummary;
  }

  async set(sessionId: string, summary: SessionSummary): Promise<void> {
    await this.client.set(REDIS_KEYS.sessionSummary(sessionId), JSON.stringify(summary), {
      EX: this.config.sessionSummaryTtlSeconds,
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.client.del(REDIS_KEYS.sessionSummary(sessionId));
  }
}

