import { createPool, type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";

import type { MySqlConfig } from "./config.js";

export function toMySqlPoolOptions(config: MySqlConfig): PoolOptions {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: config.poolMax,
    maxIdle: config.poolMax,
    idleTimeout: 60_000,
    queueLimit: 0,
    decimalNumbers: true,
    namedPlaceholders: true,
    timezone: "Z",
    charset: "utf8mb4",
  };
}

export function createMySqlPool(config: MySqlConfig): Pool {
  return createPool(toMySqlPoolOptions(config));
}

export async function withTransaction<T>(
  pool: Pool,
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

