import { createClient, type RedisClientType } from "redis";

import type { RedisConfig } from "./config.js";

export type AgentRedisClient = RedisClientType;

export const REDIS_KEYS = {
  sessionSummary: (sessionId: string) => `agent-ide:session:${sessionId}:summary`,
  sessionLease: (sessionId: string) => `agent-ide:session:${sessionId}:lease`,
  runtimeEvents: (sessionId: string) => `agent-ide:session:${sessionId}:events`,
} as const;

export function buildRedisUrl(config: RedisConfig): string {
  const credentials = config.username || config.password
    ? `${encodeURIComponent(config.username ?? "")}:${encodeURIComponent(config.password ?? "")}@`
    : "";

  return `redis://${credentials}${config.host}:${config.port}/${config.db}`;
}

export function createRedisClientFromConfig(config: RedisConfig): AgentRedisClient {
  return createClient({
    url: buildRedisUrl(config),
  });
}

export async function tryAcquireSessionLease(
  client: AgentRedisClient,
  sessionId: string,
  ownerId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await client.set(REDIS_KEYS.sessionLease(sessionId), ownerId, {
    PX: ttlMs,
    NX: true,
  });

  return result === "OK";
}

export async function releaseSessionLease(
  client: AgentRedisClient,
  sessionId: string,
  ownerId: string,
): Promise<void> {
  const key = REDIS_KEYS.sessionLease(sessionId);
  const currentOwner = await client.get(key);

  if (currentOwner === ownerId) {
    await client.del(key);
  }
}

