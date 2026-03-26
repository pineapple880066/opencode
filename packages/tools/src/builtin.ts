import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import type { ToolDefinition } from "./contracts.js";
import { ToolRegistry } from "./registry.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceBoundInput {
  root: string;
  path?: string;
}

export interface ListInput extends WorkspaceBoundInput {
  recursive?: boolean;
  maxEntries?: number;
  includeHidden?: boolean;
}

export interface ListEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
}

export interface ListOutput {
  root: string;
  basePath: string;
  entries: ListEntry[];
}

export interface ViewInput extends WorkspaceBoundInput {
  startLine?: number;
  endLine?: number;
  offset?: number;
  limit?: number;
}

export interface ViewOutput {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  kind?: "file" | "directory";
}

export interface GrepInput extends WorkspaceBoundInput {
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
  includeHidden?: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  content: string;
}

export interface GrepOutput {
  query: string;
  matches: GrepMatch[];
  truncated: boolean;
}

export interface WriteInput extends WorkspaceBoundInput {
  path: string;
  content: string;
  createDirectories?: boolean;
}

export interface WriteOutput {
  path: string;
  bytesWritten: number;
}

export interface EditInput extends WorkspaceBoundInput {
  path: string;
  search: string;
  replace: string;
  replaceAll?: boolean;
}

export interface EditOutput {
  path: string;
  replacements: number;
}

export interface BashInput {
  root: string;
  cwd?: string;
  command: string;
  timeoutMs?: number;
}

export interface BashOutput {
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickStringAlias(
  value: unknown,
  aliases: string[],
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const alias of aliases) {
    const candidate = value[alias];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
}

function pickBooleanAlias(
  value: unknown,
  aliases: string[],
): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const alias of aliases) {
    const candidate = value[alias];
    if (typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      return candidate !== 0;
    }
  }

  return undefined;
}

function pickNumberAlias(
  value: unknown,
  aliases: string[],
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const alias of aliases) {
    const candidate = value[alias];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function normalizeWorkspacePathInput(input: WorkspaceBoundInput): string {
  const aliasedPath = pickStringAlias(input, ["path", "file_path", "filePath"]);
  return aliasedPath ?? ".";
}

// 这次 mixed explain + edit bug 暴露出另一个很现实的问题：
// 模型会把“按行读取”写成 lineRange: "1-70" 这种字符串，
// 但我们原来的 view 工具只认 startLine / endLine。
//
// 结果就是：
// - 模型以为自己在缩小范围重读
// - 工具层实际上没有真正理解这个字段
// - runtime 又只看到“又来了一次新的 view”
//
// 所以这里专门补一个 lineRange 解析层，把常见的 "start-end" 形式转成内部标准字段。
function parseLineRangeAlias(value: unknown): { startLine?: number; endLine?: number } {
  const lineRange = pickStringAlias(value, ["lineRange", "line_range"]);
  if (!lineRange) {
    return {};
  }

  const matched = lineRange.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!matched) {
    return {};
  }

  const startLine = Number(matched[1]);
  const endLine = Number(matched[2]);

  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return {};
  }

  return {
    startLine,
    endLine,
  };
}

// view 工具现在会先走一层规范化：
// 1. 路径兼容 path / file_path / filePath
// 2. 行范围兼容 startLine/endLine、start_line/end_line、lineRange
//
// 这样做的原因不是“让模型随便输出都行”，
// 而是把常见外部 agent 风格先收敛到统一合同里，
// 减少工具协议阻抗导致的假失败或假循环。
function normalizeViewInput(input: ViewInput): ViewInput {
  const lineRange = parseLineRangeAlias(input);
  const offset = pickNumberAlias(input, ["offset"]);
  const limit = pickNumberAlias(input, ["limit"]);

  return {
    ...input,
    path: normalizeWorkspacePathInput(input),
    startLine:
      pickNumberAlias(input, ["startLine", "start_line"]) ??
      lineRange.startLine ??
      input.startLine,
    endLine:
      pickNumberAlias(input, ["endLine", "end_line"]) ??
      lineRange.endLine ??
      input.endLine,
    offset: offset ?? input.offset,
    limit: limit ?? input.limit,
  };
}

function normalizeWriteInput(input: WriteInput): WriteInput {
  return {
    ...input,
    path: normalizeWorkspacePathInput(input),
    content:
      pickStringAlias(input, ["content", "new_string", "newString", "contents"]) ?? input.content,
    createDirectories:
      pickBooleanAlias(input, ["createDirectories", "create_directories"]) ?? input.createDirectories,
  };
}

// 这次 Flask benchmark 暴露出 grep 合同还有两处阻抗：
// 1. 模型更常输出 pattern，而不是 query
// 2. 模型会直接把单文件路径传给 grep，希望只在这个文件里查
//
// 如果工具层不先收敛这些差异，runtime 再强的 control loop 也只是在围着错误协议打转。
function normalizeGrepInput(input: GrepInput): GrepInput {
  return {
    ...input,
    path: normalizeWorkspacePathInput(input),
    query: pickStringAlias(input, ["query", "pattern", "keyword"]) ?? input.query,
    caseSensitive:
      pickBooleanAlias(input, ["caseSensitive", "case_sensitive"]) ?? input.caseSensitive,
    maxResults:
      pickNumberAlias(input, ["maxResults", "max_results"]) ?? input.maxResults,
    includeHidden:
      pickBooleanAlias(input, ["includeHidden", "include_hidden"]) ?? input.includeHidden,
  };
}

function normalizeEditInput(input: EditInput): EditInput {
  const expectedReplacements = pickNumberAlias(input, ["expected_replacements", "expectedReplacements"]);

  return {
    ...input,
    path: normalizeWorkspacePathInput(input),
    search:
      pickStringAlias(
        input,
        ["search", "search_replace", "searchReplace", "old_string", "oldString", "old_text", "oldText"],
      ) ?? input.search,
    replace:
      pickStringAlias(
        input,
        ["replace", "new_content", "newContent", "new_string", "newString", "new_text", "newText"],
      ) ?? input.replace,
    replaceAll:
      pickBooleanAlias(input, ["replaceAll", "replace_all"]) ??
      (expectedReplacements !== undefined ? expectedReplacements > 1 : input.replaceAll),
  };
}

// benchmark / headless runner 这类场景里，模型经常会把 bash 参数写成：
// - cmd
// - script
// - working_directory / workingDirectory
// - timeout_ms
//
// 如果这些最常见的别名不先在工具层收敛，验证阶段本身就会因为协议阻抗失败，
// 然后 runtime 会误以为“模型不会验证”，其实只是 bash 合同没对齐。
function normalizeBashInput(input: BashInput): BashInput {
  return {
    ...input,
    cwd: pickStringAlias(input, ["cwd", "working_directory", "workingDirectory", "dir"]) ?? input.cwd,
    command: pickStringAlias(input, ["command", "cmd", "script"]) ?? input.command,
    timeoutMs: pickNumberAlias(input, ["timeoutMs", "timeout_ms", "timeout"]) ?? input.timeoutMs,
  };
}

function resolveWithinRoot(root: string, inputPath = "."): string {
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, inputPath);

  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`路径越界: ${inputPath}`);
  }

  return target;
}

function toRelative(root: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(root), absolutePath);
  return relative || ".";
}

async function collectListEntries(
  root: string,
  currentPath: string,
  options: Required<Pick<ListInput, "recursive" | "maxEntries" | "includeHidden">>,
  output: ListEntry[],
): Promise<void> {
  if (output.length >= options.maxEntries) {
    return;
  }

  const directoryEntries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of directoryEntries) {
    if (!options.includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    if (output.length >= options.maxEntries) {
      return;
    }

    const absolutePath = path.join(currentPath, entry.name);
    const entryStat = await stat(absolutePath);
    const kind = entry.isDirectory() ? "directory" : "file";

    output.push({
      path: toRelative(root, absolutePath),
      name: entry.name,
      kind,
      size: entryStat.size,
    });

    if (options.recursive && entry.isDirectory()) {
      await collectListEntries(root, absolutePath, options, output);
    }
  }
}

async function listTool(input: ListInput): Promise<ListOutput> {
  const root = path.resolve(input.root);
  const basePath = resolveWithinRoot(root, normalizeWorkspacePathInput(input));
  const entries: ListEntry[] = [];

  await collectListEntries(root, basePath, {
    recursive: input.recursive ?? false,
    maxEntries: input.maxEntries ?? 200,
    includeHidden: input.includeHidden ?? false,
  }, entries);

  return {
    root,
    basePath: toRelative(root, basePath),
    entries,
  };
}

async function viewTool(input: ViewInput): Promise<ViewOutput> {
  const normalizedInput = normalizeViewInput(input);
  const root = path.resolve(normalizedInput.root);
  const targetPath = resolveWithinRoot(root, normalizedInput.path);
  const targetStat = await stat(targetPath);

  if (targetStat.isDirectory()) {
    const directoryEntries = await readdir(targetPath, { withFileTypes: true });
    const sortedEntries = directoryEntries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));

    const startLine =
      normalizedInput.startLine ??
      (normalizedInput.offset !== undefined ? Math.max(1, normalizedInput.offset + 1) : 1);
    const derivedEndLine =
      normalizedInput.endLine ??
      (normalizedInput.limit !== undefined
        ? startLine + Math.max(0, normalizedInput.limit) - 1
        : sortedEntries.length);
    const endLine = Math.min(sortedEntries.length, Math.max(startLine, derivedEndLine));
    const slicedEntries = sortedEntries.slice(startLine - 1, endLine);
    const rendered = slicedEntries.map((entry) =>
      `${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`,
    );

    return {
      path: toRelative(root, targetPath),
      content: rendered.join("\n"),
      startLine,
      endLine: sortedEntries.length === 0 ? 0 : endLine,
      totalLines: sortedEntries.length,
      kind: "directory",
    };
  }

  const content = await readFile(targetPath, "utf8");
  const lines = content.split(/\r?\n/);

  // 显式分页合同：
  // - 首选 startLine/endLine（1-based，最适合源码阅读）
  // - 兼容 offset/limit（offset 为 0-based 行偏移，limit 为读取行数）
  //
  // 这样 executor 可以更明确地表达“整文件读取”或“局部精读”，
  // 不需要再把 lineRange 这种字符串别名当成主要合同。
  const derivedStartLine =
    normalizedInput.startLine ??
    (normalizedInput.offset !== undefined ? Math.max(1, normalizedInput.offset + 1) : 1);
  const startLine = Math.max(1, derivedStartLine);
  const derivedEndLine =
    normalizedInput.endLine ??
    (normalizedInput.limit !== undefined ? startLine + Math.max(0, normalizedInput.limit) - 1 : lines.length);
  const endLine = Math.min(lines.length, Math.max(startLine, derivedEndLine));
  const sliced = lines.slice(startLine - 1, endLine).join("\n");

  return {
    path: toRelative(root, targetPath),
    content: sliced,
    startLine,
    endLine,
    totalLines: lines.length,
    kind: "file",
  };
}

async function walkFilesForGrep(
  root: string,
  currentPath: string,
  includeHidden: boolean,
  files: string[],
): Promise<void> {
  const directoryEntries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of directoryEntries) {
    if (!includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walkFilesForGrep(root, absolutePath, includeHidden, files);
      continue;
    }

    files.push(absolutePath);
  }
}

async function grepTool(input: GrepInput): Promise<GrepOutput> {
  const normalizedInput = normalizeGrepInput(input);
  const root = path.resolve(normalizedInput.root);
  const basePath = resolveWithinRoot(root, normalizedInput.path);
  const baseStat = await stat(basePath);
  const maxResults = normalizedInput.maxResults ?? 100;
  const includeHidden = normalizedInput.includeHidden ?? false;
  const caseSensitive = normalizedInput.caseSensitive ?? false;
  const matches: GrepMatch[] = [];

  if (typeof normalizedInput.query !== "string" || normalizedInput.query.trim().length === 0) {
    throw new Error("grep.query 不能为空；兼容字段可使用 query 或 pattern");
  }

  try {
    const args = [
      "--line-number",
      "--with-filename",
      "--color",
      "never",
      "--max-count",
      String(maxResults),
      normalizedInput.query,
      basePath,
    ];
    if (!caseSensitive) {
      args.unshift("-i");
    }

    const { stdout } = await execFileAsync("rg", args, { cwd: root });
    const lines = stdout.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);
      if (firstColon === -1 || secondColon === -1) {
        continue;
      }

      const filePath = line.slice(0, firstColon);
      const lineNumber = Number(line.slice(firstColon + 1, secondColon));
      const content = line.slice(secondColon + 1);
      matches.push({
        path: toRelative(root, path.resolve(root, filePath)),
        line: lineNumber,
        content,
      });
    }

    return {
      query: normalizedInput.query,
      matches,
      truncated: matches.length >= maxResults,
    };
  } catch {
    const files: string[] = [];
    if (baseStat.isDirectory()) {
      await walkFilesForGrep(root, basePath, includeHidden, files);
    } else {
      files.push(basePath);
    }

    const normalizedQuery = caseSensitive ? normalizedInput.query : normalizedInput.query.toLowerCase();
    for (const filePath of files) {
      if (matches.length >= maxResults) {
        break;
      }

      const fileContent = await readFile(filePath, "utf8").catch(() => null);
      if (fileContent === null) {
        continue;
      }

      const lines = fileContent.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(normalizedQuery)) {
          continue;
        }

        matches.push({
          path: toRelative(root, filePath),
          line: index + 1,
          content: line,
        });

        if (matches.length >= maxResults) {
          break;
        }
      }
    }

    return {
      query: normalizedInput.query,
      matches,
      truncated: matches.length >= maxResults,
    };
  }
}

async function writeTool(input: WriteInput): Promise<WriteOutput> {
  const normalizedInput = normalizeWriteInput(input);
  const root = path.resolve(normalizedInput.root);
  const targetPath = resolveWithinRoot(root, normalizedInput.path);

  if (normalizedInput.createDirectories) {
    await mkdir(path.dirname(targetPath), { recursive: true });
  }

  if (typeof normalizedInput.content !== "string") {
    throw new Error("write.content 不能为空；兼容字段可使用 content、contents、new_string 或 newString");
  }

  await writeFile(targetPath, normalizedInput.content, "utf8");
  return {
    path: toRelative(root, targetPath),
    bytesWritten: Buffer.byteLength(normalizedInput.content, "utf8"),
  };
}

async function editTool(input: EditInput): Promise<EditOutput> {
  const normalizedInput = normalizeEditInput(input);
  const root = path.resolve(normalizedInput.root);
  const targetPath = resolveWithinRoot(root, normalizedInput.path);
  const before = await readFile(targetPath, "utf8");

  if (typeof normalizedInput.search !== "string" || normalizedInput.search.length === 0) {
    throw new Error(
      "edit.search 不能为空；兼容字段可使用 search、search_replace、searchReplace、old_string、oldString、old_text 或 oldText",
    );
  }

  if (typeof normalizedInput.replace !== "string") {
    throw new Error(
      "edit.replace 不能为空；兼容字段可使用 replace、new_content、newContent、new_string、newString、new_text 或 newText",
    );
  }

  const occurrences = before.split(normalizedInput.search).length - 1;
  if (occurrences === 0) {
    throw new Error(`未找到要替换的内容: ${normalizedInput.search}`);
  }

  const after = normalizedInput.replaceAll
    ? before.split(normalizedInput.search).join(normalizedInput.replace)
    : before.replace(normalizedInput.search, normalizedInput.replace);

  await writeFile(targetPath, after, "utf8");

  return {
    path: toRelative(root, targetPath),
    replacements: normalizedInput.replaceAll ? occurrences : 1,
  };
}

async function bashTool(input: BashInput): Promise<BashOutput> {
  const normalizedInput = normalizeBashInput(input);
  const root = path.resolve(normalizedInput.root);
  const cwd = resolveWithinRoot(root, normalizedInput.cwd);

  if (typeof normalizedInput.command !== "string" || normalizedInput.command.trim().length === 0) {
    throw new Error("bash.command 不能为空；兼容字段可使用 command、cmd 或 script");
  }

  try {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", normalizedInput.command], {
      cwd,
      timeout: normalizedInput.timeoutMs ?? 30_000,
      maxBuffer: 1024 * 1024,
    });

    return {
      cwd: toRelative(root, cwd),
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };

    return {
      cwd: toRelative(root, cwd),
      stdout: typedError.stdout ?? "",
      stderr: typedError.stderr ?? typedError.message,
      exitCode: typeof typedError.code === "number" ? typedError.code : 1,
    };
  }
}

// 面试点：工具本身不保存“当前 session 在哪个目录”，而是显式接收 root/path。
// 这样工具层是可测试、可复用、可做权限边界检查的。
export function createBuiltinToolDefinitions(): Array<ToolDefinition<any, any>> {
  return [
    {
      name: "list",
      permission: "read",
      description: "列出 workspace 内的文件或目录。",
      run: listTool,
    },
    {
      name: "view",
      permission: "read",
      description: "读取文件内容，可按行截取。",
      run: viewTool,
    },
    {
      name: "grep",
      permission: "read",
      description: "在 workspace 内按关键字搜索文本。",
      run: grepTool,
    },
    {
      name: "write",
      permission: "write",
      description: "写入文件内容，可选自动创建目录。",
      run: writeTool,
    },
    {
      name: "edit",
      permission: "edit",
      description: "对文件做一次或多次字符串替换。",
      run: editTool,
    },
    {
      name: "bash",
      permission: "bash",
      description: "在 workspace 内执行 shell 命令。",
      run: bashTool,
    },
  ];
}

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of createBuiltinToolDefinitions()) {
    registry.register(definition);
  }

  return registry;
}
