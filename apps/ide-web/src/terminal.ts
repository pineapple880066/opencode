import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export type WorkbenchTerminalEntryStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out";

export interface WorkbenchTerminalEntry {
  id: string;
  workspacePath: string;
  command: string;
  status: WorkbenchTerminalEntryStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  combinedOutput: string;
}

export interface WorkbenchTerminalRunInput {
  workspacePath: string;
  command: string;
}

export interface WorkbenchTerminalBackend {
  listEntries(workspacePath: string, options?: { limit?: number }): Promise<WorkbenchTerminalEntry[]>;
  runCommand(input: WorkbenchTerminalRunInput): Promise<WorkbenchTerminalEntry>;
}

export interface InMemoryWorkbenchTerminalBackendOptions {
  shell?: string;
  timeoutMs?: number;
  maxEntriesPerWorkspace?: number;
  maxOutputChars?: number;
}

function truncateOutput(value: string, maxOutputChars: number): string {
  if (value.length <= maxOutputChars) {
    return value;
  }

  return `${value.slice(0, maxOutputChars)}\n\n[agent-ide] terminal output truncated`;
}

export class InMemoryWorkbenchTerminalBackend implements WorkbenchTerminalBackend {
  private readonly shell: string;
  private readonly timeoutMs: number;
  private readonly maxEntriesPerWorkspace: number;
  private readonly maxOutputChars: number;
  private readonly entriesByWorkspace = new Map<string, WorkbenchTerminalEntry[]>();

  constructor(options: InMemoryWorkbenchTerminalBackendOptions = {}) {
    this.shell = options.shell ?? process.env.SHELL ?? "/bin/zsh";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxEntriesPerWorkspace = options.maxEntriesPerWorkspace ?? 20;
    this.maxOutputChars = options.maxOutputChars ?? 80_000;
  }

  async listEntries(
    workspacePath: string,
    options: { limit?: number } = {},
  ): Promise<WorkbenchTerminalEntry[]> {
    const entries = this.entriesByWorkspace.get(workspacePath) ?? [];
    const limit = options.limit ?? 8;

    return entries.slice(0, limit).map((entry) => ({ ...entry }));
  }

  async runCommand(input: WorkbenchTerminalRunInput): Promise<WorkbenchTerminalEntry> {
    const startedAt = new Date().toISOString();
    const draft: WorkbenchTerminalEntry = {
      id: `terminal_${randomUUID()}`,
      workspacePath: input.workspacePath,
      command: input.command,
      status: "running",
      startedAt,
      stdout: "",
      stderr: "",
      combinedOutput: "",
    };

    const entries = this.entriesByWorkspace.get(input.workspacePath) ?? [];
    entries.unshift(draft);
    this.entriesByWorkspace.set(input.workspacePath, entries.slice(0, this.maxEntriesPerWorkspace));

    const child = spawn(this.shell, ["-lc", input.command], {
      cwd: input.workspacePath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const appendChunk = (
      target: "stdout" | "stderr",
      chunk: Buffer | string,
    ) => {
      const value = chunk.toString();
      if (target === "stdout") {
        stdout = truncateOutput(stdout + value, this.maxOutputChars);
      } else {
        stderr = truncateOutput(stderr + value, this.maxOutputChars);
      }
    };

    child.stdout.on("data", (chunk) => {
      appendChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendChunk("stderr", chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, this.timeoutMs);

    const settled = await new Promise<WorkbenchTerminalEntry>((resolve, reject) => {
      child.once("error", (error) => {
        clearTimeout(timeout);
        draft.status = "failed";
        draft.finishedAt = new Date().toISOString();
        draft.stderr = truncateOutput(`${stderr}\n${error.message}`.trim(), this.maxOutputChars);
        draft.stdout = stdout;
        draft.combinedOutput = [draft.stdout, draft.stderr].filter(Boolean).join("\n");
        resolve({ ...draft });
      });

      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        draft.finishedAt = new Date().toISOString();
        draft.exitCode = exitCode ?? undefined;
        draft.signal = signal ?? undefined;
        draft.status = timedOut ? "timed_out" : exitCode === 0 ? "completed" : "failed";
        draft.stdout = stdout;
        draft.stderr = stderr;
        draft.combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({ ...draft });
      });
    }).catch((error) => {
      clearTimeout(timeout);
      throw error;
    });

    const currentEntries = this.entriesByWorkspace.get(input.workspacePath) ?? [];
    const index = currentEntries.findIndex((entry) => entry.id === draft.id);
    if (index >= 0) {
      currentEntries[index] = settled;
      this.entriesByWorkspace.set(input.workspacePath, currentEntries);
    }

    return settled;
  }
}

export function createInMemoryWorkbenchTerminalBackend(
  options?: InMemoryWorkbenchTerminalBackendOptions,
): InMemoryWorkbenchTerminalBackend {
  return new InMemoryWorkbenchTerminalBackend(options);
}
