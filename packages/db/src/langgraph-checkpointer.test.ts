import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  emptyCheckpoint,
  type CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";

import type {
  LangGraphCheckpointRepository,
  SerializedCheckpointRecord,
  SerializedCheckpointWriteRecord,
} from "./langgraph-checkpointer.js";
import { PersistentLangGraphCheckpointSaver } from "./langgraph-checkpointer.js";

class InMemoryLangGraphCheckpointRepository implements LangGraphCheckpointRepository {
  checkpointRows: SerializedCheckpointRecord[] = [];
  writeRows: SerializedCheckpointWriteRecord[] = [];

  async getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId?: string,
  ): Promise<SerializedCheckpointRecord | null> {
    const rows = this.checkpointRows
      .filter(
        (row) =>
          row.threadId === threadId &&
          row.checkpointNs === checkpointNs &&
          (checkpointId ? row.checkpointId === checkpointId : true),
      )
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));

    return rows[0] ?? null;
  }

  async listCheckpoints(filter?: {
    threadId?: string;
    checkpointNs?: string;
    checkpointId?: string;
    beforeCheckpointId?: string;
    limit?: number;
  }): Promise<SerializedCheckpointRecord[]> {
    const rows = this.checkpointRows
      .filter((row) => {
        if (filter?.threadId && row.threadId !== filter.threadId) {
          return false;
        }

        if (filter?.checkpointNs !== undefined && row.checkpointNs !== filter.checkpointNs) {
          return false;
        }

        if (filter?.checkpointId && row.checkpointId !== filter.checkpointId) {
          return false;
        }

        if (filter?.beforeCheckpointId && row.checkpointId >= filter.beforeCheckpointId) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));

    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async putCheckpoint(record: SerializedCheckpointRecord): Promise<void> {
    this.checkpointRows = this.checkpointRows.filter(
      (row) =>
        !(
          row.threadId === record.threadId &&
          row.checkpointNs === record.checkpointNs &&
          row.checkpointId === record.checkpointId
        ),
    );
    this.checkpointRows.push(record);
  }

  async listWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<SerializedCheckpointWriteRecord[]> {
    return this.writeRows
      .filter(
        (row) =>
          row.threadId === threadId && row.checkpointNs === checkpointNs && row.checkpointId === checkpointId,
      )
      .sort((left, right) => {
        const taskComparison = left.taskId.localeCompare(right.taskId);
        if (taskComparison !== 0) {
          return taskComparison;
        }

        return left.writeIdx - right.writeIdx;
      });
  }

  async putWrite(record: SerializedCheckpointWriteRecord, overwrite: boolean): Promise<void> {
    const existingIndex = this.writeRows.findIndex(
      (row) =>
        row.threadId === record.threadId &&
        row.checkpointNs === record.checkpointNs &&
        row.checkpointId === record.checkpointId &&
        row.taskId === record.taskId &&
        row.writeIdx === record.writeIdx,
    );

    if (existingIndex >= 0) {
      if (overwrite) {
        this.writeRows.splice(existingIndex, 1, record);
      }
      return;
    }

    this.writeRows.push(record);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.checkpointRows = this.checkpointRows.filter((row) => row.threadId !== threadId);
    this.writeRows = this.writeRows.filter((row) => row.threadId !== threadId);
  }
}

describe("PersistentLangGraphCheckpointSaver", () => {
  test("可以持久化 checkpoint、pending writes，并按 thread 恢复最新状态", async () => {
    const repository = new InMemoryLangGraphCheckpointRepository();
    const saver = new PersistentLangGraphCheckpointSaver(repository);
    const baseConfig: RunnableConfig = {
      configurable: {
        thread_id: "session_1",
        checkpoint_ns: "",
      },
    };

    const checkpoint1 = {
      ...emptyCheckpoint(),
      id: "checkpoint_001",
      ts: "2026-03-21T13:00:00.000Z",
    };
    const metadata1: CheckpointMetadata = {
      source: "input",
      step: -1,
      parents: {},
    };
    const checkpoint1Config = await saver.put(baseConfig, checkpoint1, metadata1);
    await saver.putWrites(
      checkpoint1Config,
      [
        ["notes", { value: "first write" }],
        ["memo", "summary-1"],
      ],
      "task_1",
    );

    const checkpoint2 = {
      ...emptyCheckpoint(),
      id: "checkpoint_002",
      ts: "2026-03-21T13:01:00.000Z",
    };
    const metadata2: CheckpointMetadata = {
      source: "loop",
      step: 0,
      parents: {
        "": checkpoint1.id,
      },
    };
    const checkpoint2Config = await saver.put(checkpoint1Config, checkpoint2, metadata2);
    await saver.putWrites(checkpoint2Config, [["notes", { value: "second write" }]], "task_2");

    const latest = await saver.getTuple(baseConfig);
    assert.equal(latest?.checkpoint.id, checkpoint2.id);
    assert.equal(latest?.metadata?.source, "loop");
    assert.equal(latest?.parentConfig?.configurable?.checkpoint_id, checkpoint1.id);

    const firstTuple = await saver.getTuple(checkpoint1Config);
    assert.equal(firstTuple?.checkpoint.id, checkpoint1.id);
    assert.equal(firstTuple?.pendingWrites?.length, 2);
    assert.deepEqual(firstTuple?.pendingWrites?.[0], ["task_1", "notes", { value: "first write" }]);

    const listedInput: string[] = [];
    for await (const tuple of saver.list(baseConfig, { filter: { source: "input" } })) {
      listedInput.push(tuple.checkpoint.id);
    }
    assert.deepEqual(listedInput, [checkpoint1.id]);

    const listedLatest: string[] = [];
    for await (const tuple of saver.list(baseConfig, { limit: 1 })) {
      listedLatest.push(tuple.checkpoint.id);
    }
    assert.deepEqual(listedLatest, [checkpoint2.id]);

    await saver.deleteThread("session_1");
    const deleted = await saver.getTuple(baseConfig);
    assert.equal(deleted, undefined);
  });
});
