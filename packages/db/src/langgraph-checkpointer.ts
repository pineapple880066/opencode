import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type {
  LangGraphCheckpointRow,
  LangGraphCheckpointWriteRow,
} from "./contracts.js";

type LangGraphCheckpointRecord = LangGraphCheckpointRow & RowDataPacket;
type LangGraphCheckpointWriteRecord = LangGraphCheckpointWriteRow & RowDataPacket;

export interface SerializedCheckpointRecord {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpointPayload: Uint8Array;
  metadataPayload: Uint8Array;
  createdAt: string;
}

export interface SerializedCheckpointWriteRecord {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  writeIdx: number;
  channelName: string;
  valuePayload: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

export interface LangGraphCheckpointRepository {
  getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId?: string,
  ): Promise<SerializedCheckpointRecord | null>;
  listCheckpoints(filter?: {
    threadId?: string;
    checkpointNs?: string;
    checkpointId?: string;
    beforeCheckpointId?: string;
    limit?: number;
  }): Promise<SerializedCheckpointRecord[]>;
  putCheckpoint(record: SerializedCheckpointRecord): Promise<void>;
  listWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<SerializedCheckpointWriteRecord[]>;
  putWrite(record: SerializedCheckpointWriteRecord, overwrite: boolean): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
}

function normalizeCheckpointNamespace(value: string | undefined): string {
  return value ?? "";
}

function requireThreadId(config: RunnableConfig, operation: string): string {
  const threadId = config.configurable?.thread_id;
  if (!threadId) {
    throw new Error(
      `Failed to ${operation}. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.`,
    );
  }

  return threadId;
}

function requireCheckpointId(config: RunnableConfig, operation: string): string {
  const checkpointId = config.configurable?.checkpoint_id;
  if (!checkpointId) {
    throw new Error(
      `Failed to ${operation}. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.`,
    );
  }

  return checkpointId;
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

function toMySqlDateTime(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无法转换 LangGraph checkpoint 时间: ${value}`);
  }

  return date.toISOString().replace("T", " ").replace("Z", "");
}

function fromMySqlDateTime(value: string | Date | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString();
}

function mapCheckpointRow(row: LangGraphCheckpointRow): SerializedCheckpointRecord {
  return {
    threadId: row.thread_id,
    checkpointNs: row.checkpoint_ns,
    checkpointId: row.checkpoint_id,
    parentCheckpointId: row.parent_checkpoint_id,
    checkpointPayload: fromBase64(row.checkpoint_b64),
    metadataPayload: fromBase64(row.metadata_b64),
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
  };
}

function mapCheckpointWriteRow(row: LangGraphCheckpointWriteRow): SerializedCheckpointWriteRecord {
  return {
    threadId: row.thread_id,
    checkpointNs: row.checkpoint_ns,
    checkpointId: row.checkpoint_id,
    taskId: row.task_id,
    writeIdx: row.write_idx,
    channelName: row.channel_name,
    valuePayload: fromBase64(row.value_b64),
    createdAt: fromMySqlDateTime(row.created_at) ?? row.created_at,
    updatedAt: fromMySqlDateTime(row.updated_at) ?? row.updated_at,
  };
}

function matchesMetadataFilter(
  metadata: CheckpointMetadata | undefined,
  filter?: Record<string, unknown>,
): boolean {
  if (!filter) {
    return true;
  }

  return Object.entries(filter).every(([key, value]) => metadata?.[key as keyof CheckpointMetadata] === value);
}

// 面试点：官方 JS 版 LangGraph 没有现成 MySQL saver，
// 所以这里补的是“自定义持久化 adapter”，而不是把系统架构改去迎合现成存储。
export class PersistentLangGraphCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly repository: LangGraphCheckpointRepository) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      return undefined;
    }

    const checkpointNs = normalizeCheckpointNamespace(config.configurable?.checkpoint_ns);
    const checkpointId = getCheckpointId(config) || undefined;
    const record = await this.repository.getCheckpoint(threadId, checkpointNs, checkpointId);
    if (!record) {
      return undefined;
    }

    const [checkpoint, metadata, pendingWrites] = await Promise.all([
      this.serde.loadsTyped("json", record.checkpointPayload) as Promise<Checkpoint>,
      this.serde.loadsTyped("json", record.metadataPayload) as Promise<CheckpointMetadata>,
      this.loadPendingWrites(record.threadId, record.checkpointNs, record.checkpointId),
    ]);

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: record.checkpointNs,
          checkpoint_id: record.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };

    if (record.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: record.checkpointNs,
          checkpoint_id: record.parentCheckpointId,
        },
      };
    }

    return tuple;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const rows = await this.repository.listCheckpoints({
      threadId: config.configurable?.thread_id,
      checkpointNs: config.configurable?.checkpoint_ns,
      checkpointId: config.configurable?.checkpoint_id,
      beforeCheckpointId: options?.before?.configurable?.checkpoint_id,
    });

    let remaining = options?.limit;
    for (const row of rows) {
      const metadata = (await this.serde.loadsTyped("json", row.metadataPayload)) as CheckpointMetadata;
      if (!matchesMetadataFilter(metadata, options?.filter)) {
        continue;
      }

      const checkpoint = (await this.serde.loadsTyped("json", row.checkpointPayload)) as Checkpoint;
      const pendingWrites = await this.loadPendingWrites(row.threadId, row.checkpointNs, row.checkpointId);

      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: row.threadId,
            checkpoint_ns: row.checkpointNs,
            checkpoint_id: row.checkpointId,
          },
        },
        checkpoint,
        metadata,
        pendingWrites,
      };

      if (row.parentCheckpointId) {
        tuple.parentConfig = {
          configurable: {
            thread_id: row.threadId,
            checkpoint_ns: row.checkpointNs,
            checkpoint_id: row.parentCheckpointId,
          },
        };
      }

      yield tuple;

      if (remaining !== undefined) {
        remaining -= 1;
        if (remaining <= 0) {
          return;
        }
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config, "put checkpoint");
    const checkpointNs = normalizeCheckpointNamespace(config.configurable?.checkpoint_ns);
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[, checkpointPayload], [, metadataPayload]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);

    await this.repository.putCheckpoint({
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: config.configurable?.checkpoint_id,
      checkpointPayload,
      metadataPayload,
      createdAt: checkpoint.ts,
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = requireThreadId(config, "put writes");
    const checkpointNs = normalizeCheckpointNamespace(config.configurable?.checkpoint_ns);
    const checkpointId = requireCheckpointId(config, "put writes");
    const now = new Date().toISOString();

    await Promise.all(
      writes.map(async ([channel, value], index) => {
        const writeIdx = WRITES_IDX_MAP[channel] ?? index;
        const [, valuePayload] = await this.serde.dumpsTyped(value);
        await this.repository.putWrite(
          {
            threadId,
            checkpointNs,
            checkpointId,
            taskId,
            writeIdx,
            channelName: channel,
            valuePayload,
            createdAt: now,
            updatedAt: now,
          },
          writeIdx < 0,
        );
      }),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.repository.deleteThread(threadId);
  }

  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    const rows = await this.repository.listWrites(threadId, checkpointNs, checkpointId);
    return Promise.all(
      rows.map(async (row) => {
        const value = await this.serde.loadsTyped("json", row.valuePayload);
        return [row.taskId, row.channelName, value] as CheckpointPendingWrite;
      }),
    );
  }
}

export class MySqlLangGraphCheckpointRepository implements LangGraphCheckpointRepository {
  constructor(private readonly pool: Pool) {}

  async getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId?: string,
  ): Promise<SerializedCheckpointRecord | null> {
    const [rows] = checkpointId
      ? await this.pool.query<LangGraphCheckpointRecord[]>(
          `
            SELECT * FROM langgraph_checkpoints
            WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
            LIMIT 1
          `,
          [threadId, checkpointNs, checkpointId],
        )
      : await this.pool.query<LangGraphCheckpointRecord[]>(
          `
            SELECT * FROM langgraph_checkpoints
            WHERE thread_id = ? AND checkpoint_ns = ?
            ORDER BY checkpoint_id DESC
            LIMIT 1
          `,
          [threadId, checkpointNs],
        );

    return rows[0] ? mapCheckpointRow(rows[0]) : null;
  }

  async listCheckpoints(filter?: {
    threadId?: string;
    checkpointNs?: string;
    checkpointId?: string;
    beforeCheckpointId?: string;
    limit?: number;
  }): Promise<SerializedCheckpointRecord[]> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter?.threadId) {
      conditions.push("thread_id = ?");
      params.push(filter.threadId);
    }

    if (filter?.checkpointNs !== undefined) {
      conditions.push("checkpoint_ns = ?");
      params.push(filter.checkpointNs);
    }

    if (filter?.checkpointId) {
      conditions.push("checkpoint_id = ?");
      params.push(filter.checkpointId);
    }

    if (filter?.beforeCheckpointId) {
      conditions.push("checkpoint_id < ?");
      params.push(filter.beforeCheckpointId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filter?.limit !== undefined ? "LIMIT ?" : "";
    if (filter?.limit !== undefined) {
      params.push(filter.limit);
    }

    const [rows] = await this.pool.query<LangGraphCheckpointRecord[]>(
      `
        SELECT * FROM langgraph_checkpoints
        ${whereClause}
        ORDER BY checkpoint_id DESC
        ${limitClause}
      `,
      params,
    );

    return rows.map((row) => mapCheckpointRow(row));
  }

  async putCheckpoint(record: SerializedCheckpointRecord): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `
        INSERT INTO langgraph_checkpoints (
          thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          checkpoint_b64, metadata_b64, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          parent_checkpoint_id = VALUES(parent_checkpoint_id),
          checkpoint_b64 = VALUES(checkpoint_b64),
          metadata_b64 = VALUES(metadata_b64),
          created_at = VALUES(created_at)
      `,
      [
        record.threadId,
        record.checkpointNs,
        record.checkpointId,
        record.parentCheckpointId ?? null,
        toBase64(record.checkpointPayload),
        toBase64(record.metadataPayload),
        toMySqlDateTime(record.createdAt),
      ],
    );
  }

  async listWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<SerializedCheckpointWriteRecord[]> {
    const [rows] = await this.pool.query<LangGraphCheckpointWriteRecord[]>(
      `
        SELECT * FROM langgraph_checkpoint_writes
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
        ORDER BY task_id ASC, write_idx ASC
      `,
      [threadId, checkpointNs, checkpointId],
    );

    return rows.map((row) => mapCheckpointWriteRow(row));
  }

  async putWrite(record: SerializedCheckpointWriteRecord, overwrite: boolean): Promise<void> {
    if (overwrite) {
      await this.pool.execute<ResultSetHeader>(
        `
          INSERT INTO langgraph_checkpoint_writes (
            thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx,
            channel_name, value_b64, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            channel_name = VALUES(channel_name),
            value_b64 = VALUES(value_b64),
            updated_at = VALUES(updated_at)
        `,
        [
          record.threadId,
          record.checkpointNs,
          record.checkpointId,
          record.taskId,
          record.writeIdx,
          record.channelName,
          toBase64(record.valuePayload),
          toMySqlDateTime(record.createdAt),
          toMySqlDateTime(record.updatedAt),
        ],
      );
      return;
    }

    await this.pool.execute<ResultSetHeader>(
      `
        INSERT IGNORE INTO langgraph_checkpoint_writes (
          thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx,
          channel_name, value_b64, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.threadId,
        record.checkpointNs,
        record.checkpointId,
        record.taskId,
        record.writeIdx,
        record.channelName,
        toBase64(record.valuePayload),
        toMySqlDateTime(record.createdAt),
        toMySqlDateTime(record.updatedAt),
      ],
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ?`,
      [threadId],
    );
    await this.pool.execute<ResultSetHeader>(
      `DELETE FROM langgraph_checkpoints WHERE thread_id = ?`,
      [threadId],
    );
  }
}

export function createMySqlLangGraphCheckpointSaver(pool: Pool): PersistentLangGraphCheckpointSaver {
  return new PersistentLangGraphCheckpointSaver(new MySqlLangGraphCheckpointRepository(pool));
}
