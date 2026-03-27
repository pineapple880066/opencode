import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface MutationCheckpointRecord {
  id: string;
  toolName: "write" | "edit";
  relativePath: string;
  createdAt: string;
  existed: boolean;
  beforeContent: string | null;
  beforeContentSha256: string | null;
}

export interface MutationCheckpoint {
  id: string;
  file: string;
}

export interface RestoredMutationCheckpoint {
  id: string;
  relativePath: string;
  restoredPath: string;
  existed: boolean;
}

function createCheckpointId(targetPath: string, toolName: "write" | "edit", createdAt: string): string {
  const safeTimestamp = createdAt.replace(/:/g, "-").replace(/\./g, "_");
  const fileName = path.basename(targetPath);
  return `${safeTimestamp}-${fileName}-${toolName}-${randomUUID().slice(0, 8)}`;
}

function toRelative(root: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(root), absolutePath);
  return relative || ".";
}

export async function writeMutationCheckpoint(options: {
  root: string;
  targetPath: string;
  toolName: "write" | "edit";
  beforeContent: string | null;
  existed: boolean;
  now?: () => string;
}): Promise<MutationCheckpoint> {
  const createdAt = options.now?.() ?? new Date().toISOString();
  const checkpointId = createCheckpointId(options.targetPath, options.toolName, createdAt);
  const checkpointDir = path.join(path.resolve(options.root), ".agent-ide", "checkpoints");
  await mkdir(checkpointDir, { recursive: true });

  const payload: MutationCheckpointRecord = {
    id: checkpointId,
    toolName: options.toolName,
    relativePath: toRelative(options.root, options.targetPath),
    createdAt,
    existed: options.existed,
    beforeContent: options.beforeContent,
    beforeContentSha256:
      options.beforeContent === null
        ? null
        : createHash("sha256").update(options.beforeContent).digest("hex"),
  };

  const fileName = `${checkpointId}.json`;
  await writeFile(path.join(checkpointDir, fileName), JSON.stringify(payload, null, 2), "utf8");

  return {
    id: checkpointId,
    file: path.join(".agent-ide", "checkpoints", fileName),
  };
}

export async function readMutationCheckpoint(options: {
  root: string;
  checkpointFile: string;
}): Promise<MutationCheckpointRecord> {
  const root = path.resolve(options.root);
  const checkpointPath = path.resolve(root, options.checkpointFile);
  const raw = await readFile(checkpointPath, "utf8");
  return JSON.parse(raw) as MutationCheckpointRecord;
}

export async function restoreMutationCheckpoint(options: {
  root: string;
  checkpointFile: string;
}): Promise<RestoredMutationCheckpoint> {
  const root = path.resolve(options.root);
  const record = await readMutationCheckpoint(options);
  const targetPath = path.resolve(root, record.relativePath);

  if (!record.existed) {
    await rm(targetPath, { force: true });
  } else {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, record.beforeContent ?? "", "utf8");
  }

  return {
    id: record.id,
    relativePath: record.relativePath,
    restoredPath: targetPath,
    existed: record.existed,
  };
}
