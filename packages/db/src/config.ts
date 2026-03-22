import { z } from "zod";

import { loadWorkspaceEnv } from "./env.js";

const persistenceEnvSchema = z.object({
  MYSQL_HOST: z.string().min(1).default("127.0.0.1"),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_DATABASE: z.string().min(1).default("agent_ide"),
  MYSQL_USER: z.string().min(1).default("root"),
  MYSQL_PASSWORD: z.string().default(""),
  MYSQL_POOL_MIN: z.coerce.number().int().nonnegative().default(0),
  MYSQL_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_HOST: z.string().min(1).default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  SESSION_SUMMARY_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SESSION_LEASE_TTL_MS: z.coerce.number().int().positive().default(30000),
});

export interface MySqlConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMin: number;
  poolMax: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  sessionSummaryTtlSeconds: number;
  sessionLeaseTtlMs: number;
}

export interface PersistenceConfig {
  mysql: MySqlConfig;
  redis: RedisConfig;
}

export function readPersistenceConfig(env: NodeJS.ProcessEnv = process.env): PersistenceConfig {
  const sourceEnv = env === process.env ? loadWorkspaceEnv() : env;
  const parsed = persistenceEnvSchema.parse(sourceEnv);

  return {
    mysql: {
      host: parsed.MYSQL_HOST,
      port: parsed.MYSQL_PORT,
      database: parsed.MYSQL_DATABASE,
      user: parsed.MYSQL_USER,
      password: parsed.MYSQL_PASSWORD,
      poolMin: parsed.MYSQL_POOL_MIN,
      poolMax: parsed.MYSQL_POOL_MAX,
    },
    redis: {
      host: parsed.REDIS_HOST,
      port: parsed.REDIS_PORT,
      username: parsed.REDIS_USERNAME || undefined,
      password: parsed.REDIS_PASSWORD || undefined,
      db: parsed.REDIS_DB,
      sessionSummaryTtlSeconds: parsed.SESSION_SUMMARY_TTL_SECONDS,
      sessionLeaseTtlMs: parsed.SESSION_LEASE_TTL_MS,
    },
  };
}
