import { readFile } from "node:fs/promises";

import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";

import type { MySqlConfig, RedisConfig } from "./config.js";
import { DATABASE_MUST_HAVE_TABLES } from "./contracts.js";
import { createMySqlPool, toMySqlPoolOptions } from "./mysql.js";
import { createRedisClientFromConfig, type AgentRedisClient } from "./redis.js";

export interface MySqlSchemaInspection {
  database: string;
  tables: string[];
  missingTables: string[];
}

export interface MySqlBootstrapOptions {
  createDatabaseIfMissing?: boolean;
  applyInitialSchema?: boolean;
  requiredTables?: readonly string[];
  schemaSql?: string;
}

export interface MySqlBootstrapResult {
  pool: Pool;
  schema: MySqlSchemaInspection;
  createdDatabase: boolean;
  appliedInitialSchema: boolean;
}

export interface RedisBootstrapResult {
  client: AgentRedisClient;
  ping: string;
}

export interface RedisHealthReport {
  isOpen: boolean;
  isReady: boolean;
  ping: string;
}

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

// 这里故意不用复杂 SQL parser。
// 初始 schema 文件保持简单可读，每条 DDL 都以分号收尾，
// bootstrap 只需要稳定地把它拆成单条语句顺序执行。
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";

  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("--")) {
      continue;
    }

    current = `${current}${line}\n`;
    if (trimmed.endsWith(";")) {
      statements.push(current.trim().replace(/;$/, ""));
      current = "";
    }
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail.replace(/;$/, ""));
  }

  return statements;
}

export async function loadInitialSchemaSql(): Promise<string> {
  return readFile(new URL("../sql/001_initial_schema.sql", import.meta.url), "utf8");
}

export async function applySqlStatements(pool: Pool, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await pool.query(statement);
  }
}

export async function applyInitialSchema(
  pool: Pool,
  options?: {
    schemaSql?: string;
  },
): Promise<void> {
  const sql = options?.schemaSql ?? (await loadInitialSchemaSql());
  const statements = splitSqlStatements(sql);
  await applySqlStatements(pool, statements);
}

export async function ensureMySqlDatabaseExists(config: MySqlConfig): Promise<boolean> {
  const adminPool = createPool({
    ...toMySqlPoolOptions(config),
    database: undefined,
    connectionLimit: 1,
    maxIdle: 1,
  });

  try {
    const [rows] = await adminPool.query<RowDataPacket[]>(
      `
        SELECT SCHEMA_NAME
        FROM information_schema.schemata
        WHERE schema_name = ?
      `,
      [config.database],
    );

    await adminPool.query(
      `
        CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(config.database)}
        CHARACTER SET utf8mb4
        COLLATE utf8mb4_unicode_ci
      `,
    );

    return rows.length === 0;
  } finally {
    await adminPool.end();
  }
}

export async function listMySqlTables(pool: Pool, database: string): Promise<string[]> {
  const [rows] = await pool.query<Array<RowDataPacket & { table_name: string }>>(
    `
      SELECT TABLE_NAME AS table_name
      FROM information_schema.tables
      WHERE table_schema = ?
      ORDER BY TABLE_NAME ASC
    `,
    [database],
  );

  return rows.map((row) => row.table_name);
}

export async function inspectMySqlSchema(
  pool: Pool,
  database: string,
  requiredTables: readonly string[] = DATABASE_MUST_HAVE_TABLES,
): Promise<MySqlSchemaInspection> {
  const tables = await listMySqlTables(pool, database);
  const existing = new Set(tables);
  const missingTables = requiredTables.filter((table) => !existing.has(table));

  return {
    database,
    tables,
    missingTables,
  };
}

export async function bootstrapMySqlPersistence(
  config: MySqlConfig,
  options?: MySqlBootstrapOptions,
): Promise<MySqlBootstrapResult> {
  const createDatabaseIfMissing = options?.createDatabaseIfMissing ?? true;
  const applySchema = options?.applyInitialSchema ?? true;
  const requiredTables = options?.requiredTables ?? DATABASE_MUST_HAVE_TABLES;

  let createdDatabase = false;
  if (createDatabaseIfMissing) {
    createdDatabase = await ensureMySqlDatabaseExists(config);
  }

  const pool = createMySqlPool(config);

  try {
    await pool.query("SELECT 1");

    // 先应用初始 schema，再立刻跑最小必需表检查。
    // 这样 bootstrap 不是“连上库就算成功”，而是必须确认 durable state 的表面真的齐了。
    if (applySchema) {
      await applyInitialSchema(pool, {
        schemaSql: options?.schemaSql,
      });
    }

    const schema = await inspectMySqlSchema(pool, config.database, requiredTables);
    if (schema.missingTables.length > 0) {
      throw new Error(`MySQL schema 缺少表: ${schema.missingTables.join(", ")}`);
    }

    return {
      pool,
      schema,
      createdDatabase,
      appliedInitialSchema: applySchema,
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function connectRedisPersistence(config: RedisConfig): Promise<RedisBootstrapResult> {
  const client = createRedisClientFromConfig(config);

  try {
    await client.connect();
    const ping = await client.ping();
    return {
      client,
      ping,
    };
  } catch (error) {
    if (client.isOpen) {
      await client.quit();
    }
    throw error;
  }
}

export async function inspectRedisHealth(client: AgentRedisClient): Promise<RedisHealthReport> {
  return {
    isOpen: client.isOpen,
    isReady: client.isReady,
    ping: await client.ping(),
  };
}

export async function disposeRedisClient(client: AgentRedisClient | undefined): Promise<void> {
  if (!client?.isOpen) {
    return;
  }

  await client.quit();
}
