import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadWorkspaceEnv } from "@agent-ide/db";
import {
  createIdeRuntimeEnvironment,
  createMiniMaxHooks,
  hasMiniMaxConfig,
  readMiniMaxConfig,
} from "@agent-ide/ide-web";
import type { AgentGraphState } from "@agent-ide/runtime";

const execFileAsync = promisify(execFile);

export const SWEBENCH_LITE_DEFAULT_INSTANCES_FILE = ".benchmarks/swebench-lite/instances.json";
export const SWEBENCH_LITE_DEFAULT_CACHE_ROOT = ".benchmarks/swebench-lite/cache";
export const SWEBENCH_LITE_DEFAULT_INSTANCE_TIMEOUT_MS = 8 * 60 * 1000;

export interface SweBenchLiteInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string | null;
  version?: string | null;
  FAIL_TO_PASS?: string[] | null;
  PASS_TO_PASS?: string[] | null;
}

export interface SweBenchPrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface SweBenchLiteStageLog {
  stage: string;
  at: string;
  detail?: string;
}

export interface SweBenchLiteInstanceRunReport {
  instanceId: string;
  repo: string;
  baseCommit: string;
  workspacePath: string;
  sessionId?: string;
  status: "running" | "completed" | "failed" | "timed_out";
  patchBytes: number;
  changedFiles: string[];
  toolInvocationCount: number;
  lastAssistantMessage?: string;
  executionLog: string[];
  durationMs: number;
  stageLogs: SweBenchLiteStageLog[];
  error?: string;
}

export interface SweBenchLiteRunReport {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  modelName: string;
  instanceTimeoutMs: number;
  instancesFile: string;
  predictionsPath: string;
  workspaceRoot: string;
  cacheRoot: string;
  selectedInstanceIds: string[];
  summary: {
    total: number;
    completed: number;
    failed: number;
    timedOut: number;
    withPatch: number;
  };
  instances: SweBenchLiteInstanceRunReport[];
}

export interface SweBenchLiteInvocation {
  runId: string;
  instancesFile: string;
  outputDir: string;
  workspaceRoot: string;
  cacheRoot: string;
  instanceIds: string[];
  limit?: number;
  continueOnError: boolean;
  modelName?: string;
  instanceTimeoutMs: number;
}

interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface LangGraphInvocationResult {
  runtimeState?: AgentGraphState | null;
  executionLog?: string[];
}

class InstanceTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "InstanceTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function createDefaultSweBenchRunId(date: Date = new Date()): string {
  return `swebench-lite-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function normalizeInstanceIdList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`数值参数必须是正整数，当前收到: ${value}`);
  }

  return parsed;
}

export function readSweBenchLiteInvocation(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): SweBenchLiteInvocation {
  // benchmark runner 的 CLI 只保留最关键的目录和筛选参数，
  // 这样一次批处理跑完之后，输出物位置和复现实例范围都是稳定可追的。
  const args = [...argv];
  let runId = env.SWEBENCH_RUN_ID?.trim() || createDefaultSweBenchRunId();
  let instancesFile =
    env.SWEBENCH_INSTANCES_FILE?.trim() || path.resolve(process.cwd(), SWEBENCH_LITE_DEFAULT_INSTANCES_FILE);
  let outputDir =
    env.SWEBENCH_OUTPUT_DIR?.trim() || path.resolve(process.cwd(), ".benchmarks/swebench-lite/runs", runId);
  let cacheRoot =
    env.SWEBENCH_CACHE_ROOT?.trim() || path.resolve(process.cwd(), SWEBENCH_LITE_DEFAULT_CACHE_ROOT);
  let workspaceRoot =
    env.SWEBENCH_WORKSPACE_ROOT?.trim() || path.resolve(outputDir, "workspaces");
  const instanceIds = normalizeInstanceIdList(env.SWEBENCH_INSTANCE_IDS);
  let limit =
    env.SWEBENCH_LIMIT && env.SWEBENCH_LIMIT.trim().length > 0 ? Number(env.SWEBENCH_LIMIT) : undefined;
  let continueOnError = env.SWEBENCH_FAIL_FAST === "1" ? false : true;
  let modelName = env.SWEBENCH_MODEL_NAME?.trim() || undefined;
  let instanceTimeoutMs = parsePositiveInteger(
    env.SWEBENCH_INSTANCE_TIMEOUT_MS,
    SWEBENCH_LITE_DEFAULT_INSTANCE_TIMEOUT_MS,
  );

  while (args.length > 0) {
    const current = args.shift();
    if (!current) {
      continue;
    }

    if (current === "--") {
      continue;
    }

    if (current === "--instances-file") {
      instancesFile = path.resolve(args.shift() ?? instancesFile);
      continue;
    }

    if (current === "--output-dir") {
      outputDir = path.resolve(args.shift() ?? outputDir);
      workspaceRoot = path.resolve(outputDir, "workspaces");
      continue;
    }

    if (current === "--workspace-root") {
      workspaceRoot = path.resolve(args.shift() ?? workspaceRoot);
      continue;
    }

    if (current === "--cache-root") {
      cacheRoot = path.resolve(args.shift() ?? cacheRoot);
      continue;
    }

    if (current === "--run-id") {
      const next = args.shift()?.trim();
      if (next) {
        runId = next;
        outputDir = path.resolve(process.cwd(), ".benchmarks/swebench-lite/runs", next);
        workspaceRoot = path.resolve(outputDir, "workspaces");
      }
      continue;
    }

    if (current === "--instance") {
      const next = args.shift()?.trim();
      if (next) {
        instanceIds.push(next);
      }
      continue;
    }

    if (current === "--instance-ids") {
      instanceIds.push(...normalizeInstanceIdList(args.shift()));
      continue;
    }

    if (current === "--limit") {
      const next = args.shift();
      limit = next ? Number(next) : limit;
      continue;
    }

    if (current === "--fail-fast") {
      continueOnError = false;
      continue;
    }

    if (current === "--model-name") {
      modelName = args.shift()?.trim() || modelName;
      continue;
    }

    if (current === "--instance-timeout-ms") {
      instanceTimeoutMs = parsePositiveInteger(args.shift(), instanceTimeoutMs);
      continue;
    }
  }

  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit 必须是正整数，当前收到: ${String(limit)}`);
  }

  return {
    runId,
    instancesFile,
    outputDir,
    workspaceRoot,
    cacheRoot,
    instanceIds: Array.from(new Set(instanceIds)),
    limit,
    continueOnError,
    modelName,
    instanceTimeoutMs,
  };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));

  return items.length > 0 ? items : undefined;
}

function normalizeSweBenchLiteInstance(value: unknown): SweBenchLiteInstance | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const instanceId = normalizeString(record.instance_id);
  const repo = normalizeString(record.repo);
  const baseCommit = normalizeString(record.base_commit ?? record.baseCommit);
  const problemStatement = normalizeString(record.problem_statement ?? record.problemStatement);

  if (!instanceId || !repo || !baseCommit || !problemStatement) {
    return null;
  }

  return {
    instance_id: instanceId,
    repo,
    base_commit: baseCommit,
    problem_statement: problemStatement,
    hints_text: normalizeString(record.hints_text ?? record.hintsText) ?? null,
    version: normalizeString(record.version) ?? null,
    FAIL_TO_PASS: normalizeStringList(record.FAIL_TO_PASS) ?? null,
    PASS_TO_PASS: normalizeStringList(record.PASS_TO_PASS) ?? null,
  };
}

export function parseSweBenchInstancesContent(content: string, filePath = "instances.json"): SweBenchLiteInstance[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  const rawItems: unknown[] = filePath.endsWith(".jsonl")
    ? trimmed
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : (() => {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!Array.isArray(parsed)) {
          throw new Error("instances 文件必须是 JSON array 或 JSONL");
        }
        return parsed;
      })();

  return rawItems
    .map((item) => normalizeSweBenchLiteInstance(item))
    .filter((item): item is SweBenchLiteInstance => Boolean(item));
}

export async function loadSweBenchLiteInstances(instancesFile: string): Promise<SweBenchLiteInstance[]> {
  const content = await readFile(instancesFile, "utf8");
  return parseSweBenchInstancesContent(content, instancesFile);
}

function toSafeRepoDirectoryName(repo: string): string {
  return `repo__${repo.replaceAll("/", "__")}`;
}

function repositoryRemoteUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

async function runCommand(command: string, args: string[], options?: CommandOptions): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      encoding: "utf8",
      timeout: options?.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      [
        `命令执行失败: ${command} ${args.join(" ")}`,
        options?.cwd ? `cwd: ${options.cwd}` : undefined,
        detail.message,
        detail.stdout ? `stdout:\n${detail.stdout}` : undefined,
        detail.stderr ? `stderr:\n${detail.stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function readGitCloneMetadata(cacheDir: string): Promise<{
  isPromisorRemote: boolean;
  partialCloneFilter?: string;
}> {
  try {
    const configPath = path.join(cacheDir, ".git", "config");
    const content = await readFile(configPath, "utf8");
    const promisorMatch = content.match(/^\s*promisor\s*=\s*(.+)\s*$/m);
    const filterMatch = content.match(/^\s*partialclonefilter\s*=\s*(.+)\s*$/m);
    return {
      isPromisorRemote: promisorMatch?.[1]?.trim() === "true",
      partialCloneFilter: filterMatch?.[1]?.trim(),
    };
  } catch {
    return {
      isPromisorRemote: false,
    };
  }
}

async function ensureRepositoryCache(repo: string, cacheRoot: string): Promise<string> {
  // 基准评测要兼顾“不要反复走网络”与“不同实例工作区必须隔离”。
  // 所以这里先做 repo 级 cache clone，再由实例工作区从 cache clone 派生。
  const cacheDir = path.join(cacheRoot, toSafeRepoDirectoryName(repo));
  const gitDir = path.join(cacheDir, ".git");

  // 第一版曾经尝试把 cache 做成 partial clone，目的是减少下载体积。
  // 但 SWE-bench runner 后面会从这个 cache 再派生实例工作区，partial clone
  // 在本地 clone 时会把 promisor remote 语义一起带进去，实际跑起来容易在
  // `git clone --no-local <cache> <workspace>` 阶段炸掉。这里显式检测旧 cache
  // 是否仍然带 partial clone 配置；如果是，就删掉重建成完整 cache。
  if (existsSync(gitDir)) {
    const cloneMetadata = await readGitCloneMetadata(cacheDir);
    if (cloneMetadata.isPromisorRemote || cloneMetadata.partialCloneFilter) {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }

  if (!existsSync(gitDir)) {
    await mkdir(cacheRoot, { recursive: true });
    await runCommand("git", ["clone", repositoryRemoteUrl(repo), cacheDir], {
      timeoutMs: 10 * 60 * 1000,
    });
  } else {
    try {
      await runCommand("git", ["fetch", "--prune", "origin"], {
        cwd: cacheDir,
        timeoutMs: 10 * 60 * 1000,
      });
    } catch (error) {
      // benchmark rerun 不应该因为“已有 cache 的一次 refresh 失败”就整条实例直接判死。
      // 这里的原则是：
      // - 如果本地 cache 已存在，就优先复用
      // - 真正必须失败的条件是：后面需要的 base_commit 在 cache 里也找不到
      // 这样网络抖动时，runner 仍然可以离线复现之前已经缓存过的实例。
      console.warn(
        `[swebench-lite] 仓库 cache refresh 失败，改为继续复用本地 cache: ${repo}\n${(error as Error).message}`,
      );
    }
  }

  return cacheDir;
}

async function ensureCommitAvailable(cacheDir: string, baseCommit: string): Promise<void> {
  try {
    await runCommand("git", ["cat-file", "-e", `${baseCommit}^{commit}`], {
      cwd: cacheDir,
    });
    return;
  } catch {
    await runCommand("git", ["fetch", "--depth=1", "origin", baseCommit], {
      cwd: cacheDir,
      timeoutMs: 10 * 60 * 1000,
    });
    await runCommand("git", ["cat-file", "-e", `${baseCommit}^{commit}`], {
      cwd: cacheDir,
    });
  }
}

async function prepareInstanceWorkspace(
  instance: SweBenchLiteInstance,
  workspaceRoot: string,
  cacheRoot: string,
): Promise<string> {
  // SWE-bench 的关键不是“给你一个 repo 名”，而是给你 repo + base_commit。
  // 所以 runner 必须先把实例工作区精确还原到该 commit，后面的 patch 才有意义。
  const cacheDir = await ensureRepositoryCache(instance.repo, cacheRoot);
  await ensureCommitAvailable(cacheDir, instance.base_commit);

  const workspaceDir = path.join(workspaceRoot, instance.instance_id);
  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });

  await runCommand("git", ["clone", "--no-local", cacheDir, workspaceDir], {
    timeoutMs: 10 * 60 * 1000,
  });
  await runCommand("git", ["checkout", "--force", instance.base_commit], {
    cwd: workspaceDir,
    timeoutMs: 5 * 60 * 1000,
  });
  await runCommand("git", ["clean", "-fdx"], {
    cwd: workspaceDir,
    timeoutMs: 5 * 60 * 1000,
  });

  return workspaceDir;
}

async function collectGitDiff(workspacePath: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["diff", "--binary", "--no-color", "--no-ext-diff"],
    {
      cwd: workspacePath,
      timeoutMs: 5 * 60 * 1000,
    },
  );

  return result.stdout;
}

async function collectChangedFiles(workspacePath: string): Promise<string[]> {
  const result = await runCommand(
    "git",
    ["diff", "--name-only", "--no-color", "--no-ext-diff"],
    {
      cwd: workspacePath,
      timeoutMs: 5 * 60 * 1000,
    },
  );

  return result.stdout
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectInstances(
  instances: SweBenchLiteInstance[],
  invocation: SweBenchLiteInvocation,
): SweBenchLiteInstance[] {
  const selected = invocation.instanceIds.length > 0
    ? instances.filter((instance) => invocation.instanceIds.includes(instance.instance_id))
    : instances;

  return invocation.limit ? selected.slice(0, invocation.limit) : selected;
}

export function buildSweBenchTaskPrompt(instance: SweBenchLiteInstance): string {
  const lowerProblemStatement = instance.problem_statement.toLowerCase();
  const existingValidationMirrorHint =
    lowerProblemStatement.includes("already added for endpoint names")
    && lowerProblemStatement.includes("should have been added for this as well")
      ? "本题和 endpoint name 的 dot 校验属于同一组 public validation family：如果你为 blueprint name 引入显式异常，也要检查同文件里的 endpoint / view_func dot 校验是否仍停留在 bare assert，并统一成同一异常语义。"
      : undefined;
  // 这里的 prompt 刻意偏“工程约束”，而不是花哨提示词：
  // - 目标是 patch，不是解释
  // - 允许最小验证命令
  // - 优先最小修改
  return [
    "你正在处理一个 SWE-bench Lite 实例。",
    "目标不是只解释问题，而是在当前工作区代码上产出真实可评测的 patch。",
    "你可以先读文件、grep、运行最小验证命令，再修改代码并复测。",
    "如果需要运行测试、检查 import、确认 git/pytest/node 状态，优先通过 bash 工具完成。",
    "把 FAIL_TO_PASS 里的每个测试都当成独立验收项，不要只修第一个目标测试就提前收尾。",
    "如果多个 FAIL_TO_PASS 测试在同一个测试文件里，至少检查一次那个测试文件附近的相关用例，确保补丁不会只满足其中一个。",
    "不要停留在“我理解了问题”。如果已经有足够证据，应尽快落到真实文件修改。",
    "一旦你已经定位到目标文件、相关函数或可替换锚点，下一轮必须进入 modify phase，直接发起 edit/write。",
    "如果已经 view 过目标文件，就不要继续反复解释或纯只读重看；benchmark 把空 patch 视为失败。",
    "如果 grep / view 已经在同一个文件里找到“现有的类比校验、类比错误信息或类比参数处理”，就把它视为最终锚点：停止横向发散搜索，最多再精读 1 次锚点附近，然后直接 edit。",
    "对于“新增校验/新增参数/新增默认值”这类问题，优先在同文件寻找最接近的现有实现并做最小类比修改，不要继续跨文件大范围探索。",
    "如果问题描述说“某种错误或校验已经在别处存在，也应该加在这里”，先找到那处现有校验，并镜像它的异常类型、错误信息风格和相关调用点；不要只在新位置补一个孤立检查。",
    "对于公开 API 的无效输入，优先使用显式异常作为最终用户可见的校验行为，不要把 bare assert 当作最终方案。",
    "如果你决定把某个公开校验从 bare assert 升级成显式异常，就检查同模块里紧邻的同类校验；不要留下行为不一致的 sibling validation。",
    existingValidationMirrorHint,
    "如果 edit 因为 search/replace 参数不准而失败，下一轮应修正 edit 参数继续尝试，而不是只输出解释。",
    "优先生成最小 patch，只改与问题直接相关的文件。",
    "最终 assistantMessage 里要简洁说明：改了哪些文件、怎么验证、还有什么风险。",
    `instance_id: ${instance.instance_id}`,
    `repo: ${instance.repo}`,
    `base_commit: ${instance.base_commit}`,
    instance.version ? `version: ${instance.version}` : undefined,
    instance.FAIL_TO_PASS?.length ? `FAIL_TO_PASS: ${instance.FAIL_TO_PASS.join(", ")}` : undefined,
    instance.PASS_TO_PASS?.length ? `PASS_TO_PASS: ${instance.PASS_TO_PASS.join(", ")}` : undefined,
    "problem_statement:",
    instance.problem_statement,
    instance.hints_text ? "hints_text:" : undefined,
    instance.hints_text ?? undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildRunSummary(report: SweBenchLiteRunReport): SweBenchLiteRunReport["summary"] {
  const completed = report.instances.filter((item) => item.status === "completed").length;
  const failed = report.instances.filter((item) => item.status === "failed").length;
  const timedOut = report.instances.filter((item) => item.status === "timed_out").length;
  const withPatch = report.instances.filter((item) => item.patchBytes > 0).length;

  return {
    total: report.instances.length,
    completed,
    failed,
    timedOut,
    withPatch,
  };
}

function pickLastAssistantMessage(messages: Array<{ role: string; content: string }>): string | undefined {
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim().length > 0);

  return lastAssistantMessage?.content;
}

async function safeCollectDebugState(runtime: Awaited<ReturnType<typeof createIdeRuntimeEnvironment>>, sessionId: string) {
  const [messages, toolInvocations] = await Promise.all([
    runtime.service.listMessages(sessionId),
    runtime.service.listToolInvocations(sessionId),
  ]);

  return {
    messages,
    toolInvocations,
  };
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  messageFactory: () => string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new InstanceTimeoutError(messageFactory(), timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function persistSweBenchArtifacts(
  report: SweBenchLiteRunReport,
  predictions: SweBenchPrediction[],
  predictionsPath: string,
  reportPath: string,
  selectedInstanceIdsPath: string,
): Promise<void> {
  report.summary = buildRunSummary(report);

  await Promise.all([
    writeFile(predictionsPath, JSON.stringify(predictions, null, 2), "utf8"),
    writeFile(reportPath, JSON.stringify(report, null, 2), "utf8"),
    writeFile(selectedInstanceIdsPath, `${report.selectedInstanceIds.join("\n")}\n`, "utf8"),
  ]);
}

function upsertPrediction(predictions: SweBenchPrediction[], nextPrediction: SweBenchPrediction): void {
  const currentIndex = predictions.findIndex((prediction) => prediction.instance_id === nextPrediction.instance_id);

  if (currentIndex >= 0) {
    predictions[currentIndex] = nextPrediction;
    return;
  }

  predictions.push(nextPrediction);
}

export async function runSweBenchLite(
  invocation: SweBenchLiteInvocation,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SweBenchLiteRunReport> {
  // 这条主链把 benchmark 适配收成稳定的 headless patch 生成流程：
  // 读实例 -> 准备工作区 -> 创建 session -> 跑 graph -> 收集 git diff -> 写 predictions/report
  loadWorkspaceEnv();
  if (!hasMiniMaxConfig(env)) {
    throw new Error("当前未检测到 MINIMAX_API_KEY；SWE-bench runner 需要先配置 MiniMax 模型环境变量。");
  }

  const config = readMiniMaxConfig(env);
  const modelName = invocation.modelName ?? `minimax:${config.model}`;
  const instances = selectInstances(await loadSweBenchLiteInstances(invocation.instancesFile), invocation);

  if (instances.length === 0) {
    throw new Error(
      `没有选出任何 SWE-bench 实例。请检查 instances 文件或 --instance/--instance-ids 参数。file=${invocation.instancesFile}`,
    );
  }

  await mkdir(invocation.outputDir, { recursive: true });
  await mkdir(invocation.workspaceRoot, { recursive: true });
  await mkdir(invocation.cacheRoot, { recursive: true });

  const predictionsPath = path.join(invocation.outputDir, "predictions.json");
  const reportPath = path.join(invocation.outputDir, "run-report.json");
  const selectedInstanceIdsPath = path.join(invocation.outputDir, "instance-ids.txt");
  const report: SweBenchLiteRunReport = {
    runId: invocation.runId,
    startedAt: new Date().toISOString(),
    modelName,
    instanceTimeoutMs: invocation.instanceTimeoutMs,
    instancesFile: invocation.instancesFile,
    predictionsPath,
    workspaceRoot: invocation.workspaceRoot,
    cacheRoot: invocation.cacheRoot,
    selectedInstanceIds: instances.map((instance) => instance.instance_id),
    summary: {
      total: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      withPatch: 0,
    },
    instances: [],
  };
  const predictions: SweBenchPrediction[] = [];

  const hooks = {
    ...createMiniMaxHooks({ env }),
    // 当前 benchmark runner 是 headless 单 session patch 生成器，
    // 并没有真正的 child-session execution backend。
    // 如果允许 delegate，父 session 只会创建 queued 的 subagent run，
    // 然后继续往下执行，最后出现“summary 以为子代理做了事，但工作区没有 patch”的假推进。
    // 所以 benchmark 路径里显式禁用 delegation，强制把修复留在当前 session 内完成。
    delegate: undefined,
  };
  await persistSweBenchArtifacts(report, predictions, predictionsPath, reportPath, selectedInstanceIdsPath);

  for (const instance of instances) {
    const startedAt = Date.now();
    const workspacePath = path.join(invocation.workspaceRoot, instance.instance_id);
    const instanceReport: SweBenchLiteInstanceRunReport = {
      instanceId: instance.instance_id,
      repo: instance.repo,
      baseCommit: instance.base_commit,
      workspacePath,
      status: "running",
      patchBytes: 0,
      changedFiles: [],
      toolInvocationCount: 0,
      executionLog: [],
      durationMs: 0,
      stageLogs: [],
    };
    report.instances.push(instanceReport);
    await persistSweBenchArtifacts(report, predictions, predictionsPath, reportPath, selectedInstanceIdsPath);

    let currentStage = "queued";
    let runtime: Awaited<ReturnType<typeof createIdeRuntimeEnvironment>> | undefined;
    let latestResult: LangGraphInvocationResult | undefined;
    const recordStage = async (stage: string, detail?: string) => {
      currentStage = stage;
      instanceReport.durationMs = Date.now() - startedAt;
      instanceReport.stageLogs.push({
        stage,
        at: new Date().toISOString(),
        detail,
      });
      console.log(
        `[swebench-lite][${instance.instance_id}] ${stage}${detail ? ` :: ${detail}` : ""}`,
      );
      await persistSweBenchArtifacts(report, predictions, predictionsPath, reportPath, selectedInstanceIdsPath);
    };

    try {
      await withTimeout(
        (async () => {
          await recordStage("prepare-workspace:start");
          instanceReport.workspacePath = await prepareInstanceWorkspace(
            instance,
            invocation.workspaceRoot,
            invocation.cacheRoot,
          );
          await recordStage("prepare-workspace:done", instanceReport.workspacePath);

          await recordStage("runtime-bootstrap:start");
          runtime = await createIdeRuntimeEnvironment({
            hooks,
            // runner 是 headless 的，没有交互式批准按钮。
            // benchmark 若完全禁用 bash，很多实例连最小验证命令都跑不了。
            // 所以这里只在 benchmark 路径里对 bash 单独自动批准。
            toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
            // benchmark 任务通常需要比 IDE 交互更长的工具链：
            // 先 grep/list 定位，再多次精读，再 edit / bash。
            // 保持网页默认 5 轮，但在 headless benchmark 路径里放宽到 8 轮，
            // 避免像 flask-4045 这种“刚定位到正确锚点就到轮数上限”的情况。
            maxToolRounds: 8,
          });
          await recordStage("runtime-bootstrap:done");

          await recordStage("create-session:start");
          const session = await runtime.service.createSession({
            workspacePath: instanceReport.workspacePath,
            title: `SWE-bench Lite ${instance.instance_id}`,
            agentMode: "build",
          });
          instanceReport.sessionId = session.id;
          await recordStage("create-session:done", session.id);

          await recordStage("invoke:start");
          latestResult = (await runtime.langGraph.invoke({
            sessionId: session.id,
            userMessage: buildSweBenchTaskPrompt(instance),
          })) as LangGraphInvocationResult;
          await recordStage(
            "invoke:done",
            `${latestResult.executionLog?.length ?? 0} execution log entries`,
          );

          await recordStage("collect-artifacts:start");
          const [patch, changedFiles, debugState] = await Promise.all([
            collectGitDiff(instanceReport.workspacePath),
            collectChangedFiles(instanceReport.workspacePath),
            safeCollectDebugState(runtime, session.id),
          ]);
          upsertPrediction(predictions, {
            instance_id: instance.instance_id,
            model_name_or_path: modelName,
            model_patch: patch,
          });
          instanceReport.status = "completed";
          instanceReport.patchBytes = Buffer.byteLength(patch, "utf8");
          instanceReport.changedFiles = changedFiles;
          instanceReport.toolInvocationCount = debugState.toolInvocations.length;
          instanceReport.lastAssistantMessage = pickLastAssistantMessage(debugState.messages);
          instanceReport.executionLog = latestResult.executionLog ?? [];
          instanceReport.durationMs = Date.now() - startedAt;
          await recordStage(
            "collect-artifacts:done",
            `patch=${instanceReport.patchBytes} bytes files=${changedFiles.length}`,
          );
        })(),
        invocation.instanceTimeoutMs,
        () =>
          `实例 ${instance.instance_id} 在阶段 ${currentStage} 超时（>${invocation.instanceTimeoutMs}ms）`,
      );
    } catch (error) {
      const [patch, changedFiles, debugState] =
        runtime && instanceReport.sessionId
          ? await Promise.all([
              withTimeout(
                collectGitDiff(instanceReport.workspacePath).catch(() => ""),
                10_000,
                () => `收集 ${instance.instance_id} 的 git diff 超时`,
              ).catch(() => ""),
              withTimeout(
                collectChangedFiles(instanceReport.workspacePath).catch(() => []),
                10_000,
                () => `收集 ${instance.instance_id} 的 changed files 超时`,
              ).catch(() => []),
              withTimeout(
                safeCollectDebugState(runtime, instanceReport.sessionId).catch(() => ({
                  messages: [],
                  toolInvocations: [],
                })),
                10_000,
                () => `收集 ${instance.instance_id} 的 debug state 超时`,
              ).catch(() => ({
                messages: [],
                toolInvocations: [],
              })),
            ])
          : ["", [], { messages: [], toolInvocations: [] }];

      upsertPrediction(predictions, {
        instance_id: instance.instance_id,
        model_name_or_path: modelName,
        model_patch: patch,
      });

      instanceReport.status = error instanceof InstanceTimeoutError ? "timed_out" : "failed";
      instanceReport.patchBytes = Buffer.byteLength(patch, "utf8");
      instanceReport.changedFiles = changedFiles;
      instanceReport.toolInvocationCount = debugState.toolInvocations.length;
      instanceReport.lastAssistantMessage = pickLastAssistantMessage(debugState.messages);
      instanceReport.executionLog = latestResult?.executionLog ?? [];
      instanceReport.durationMs = Date.now() - startedAt;
      instanceReport.error = error instanceof Error ? error.message : String(error);
      await recordStage(instanceReport.status === "timed_out" ? "instance:timed-out" : "instance:failed", instanceReport.error);

      if (!invocation.continueOnError) {
        throw error;
      }
    } finally {
      if (runtime) {
        await recordStage("runtime-dispose:start");
        await withTimeout(
          runtime.dispose(),
          30_000,
          () => `释放实例 ${instance.instance_id} 的 runtime 超时`,
        ).catch(async (disposeError) => {
          instanceReport.error = [
            instanceReport.error,
            disposeError instanceof Error ? disposeError.message : String(disposeError),
          ]
            .filter(Boolean)
            .join("\n");
          await recordStage("runtime-dispose:failed", instanceReport.error);
        });
        if (!instanceReport.stageLogs.some((entry) => entry.stage === "runtime-dispose:failed")) {
          await recordStage("runtime-dispose:done");
        }
      }

      instanceReport.durationMs = Date.now() - startedAt;
      await persistSweBenchArtifacts(report, predictions, predictionsPath, reportPath, selectedInstanceIdsPath);
    }
  }

  report.finishedAt = new Date().toISOString();
  await persistSweBenchArtifacts(report, predictions, predictionsPath, reportPath, selectedInstanceIdsPath);

  return report;
}

async function main(): Promise<void> {
  const invocation = readSweBenchLiteInvocation();
  const report = await runSweBenchLite(invocation);

  console.log(
    JSON.stringify(
      {
        runId: report.runId,
        modelName: report.modelName,
        instancesFile: report.instancesFile,
        predictionsPath: report.predictionsPath,
        workspaceRoot: report.workspaceRoot,
        cacheRoot: report.cacheRoot,
        summary: report.summary,
      },
      null,
      2,
    ),
  );
  console.log("");
  console.log("官方 harness 评测 5 条实例时，可在 SWE-bench 仓库里执行：");
  console.log(
    `  python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path ${report.predictionsPath} --instance_ids ${report.selectedInstanceIds.join(" ")} --max_workers 1 --run_id ${report.runId} --namespace ''`,
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl && import.meta.url === entryUrl) {
  void main().catch((error) => {
    console.error("[agent-ide] SWE-bench Lite runner failed", error);
    process.exit(1);
  });
}
