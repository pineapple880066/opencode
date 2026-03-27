/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * 这份 replace-first recovery 逻辑直接参考了 Gemini CLI 的 edit tool 设计，
 * 但保留了本仓库现有的 API（applyEditWithRecovery）。
 *
 * 目标不是继续把失败推给上层 control loop，而是优先在工具层把 edit 做成：
 * - exact
 * - already-applied
 * - line-ending-normalized
 * - flexible
 * - regex
 */

import { createHash } from "node:crypto";

export type EditRecoveryStrategy =
  | "exact"
  | "already-applied"
  | "line-ending-normalized"
  | "flexible"
  | "regex";

export interface EditRecoveryResult {
  after: string;
  replacements: number;
  strategy: EditRecoveryStrategy;
  recoveredSearch?: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  return haystack.split(needle).length - 1;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function restoreLineEndings(text: string, originalContent: string): string {
  if (originalContent.includes("\r\n")) {
    return text.replace(/\n/g, "\r\n");
  }

  return text;
}

function restoreTrailingNewline(originalContent: string, modifiedContent: string): string {
  const hadTrailingNewline = originalContent.endsWith("\n");
  if (hadTrailingNewline && !modifiedContent.endsWith("\n")) {
    return `${modifiedContent}\n`;
  }

  if (!hadTrailingNewline && modifiedContent.endsWith("\n")) {
    return modifiedContent.replace(/\n$/, "");
  }

  return modifiedContent;
}

function applyIndentation(lines: string[], indentation: string): string[] {
  return lines.map((line) => {
    if (line.length === 0) {
      return line;
    }

    return `${indentation}${line.trimStart()}`;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tryExactReplacement(
  before: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): EditRecoveryResult | null {
  const occurrences = countOccurrences(before, search);
  if (occurrences === 0) {
    return null;
  }

  return {
    after: replaceAll ? before.split(search).join(replace) : before.replace(search, replace),
    replacements: replaceAll ? occurrences : 1,
    strategy: "exact",
  };
}

function tryAlreadyApplied(
  before: string,
  search: string,
  replace: string,
): EditRecoveryResult | null {
  if (countOccurrences(before, search) > 0) {
    return null;
  }

  if (replace.length === 0 || !before.includes(replace)) {
    return null;
  }

  return {
    after: before,
    replacements: 0,
    strategy: "already-applied",
  };
}

function tryLineEndingNormalizedReplacement(
  before: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): EditRecoveryResult | null {
  const normalizedBefore = normalizeLineEndings(before);
  const normalizedSearch = normalizeLineEndings(search);
  const normalizedReplace = normalizeLineEndings(replace);
  const occurrences = countOccurrences(normalizedBefore, normalizedSearch);

  if (occurrences === 0) {
    return null;
  }

  const updatedNormalized = replaceAll
    ? normalizedBefore.split(normalizedSearch).join(normalizedReplace)
    : normalizedBefore.replace(normalizedSearch, normalizedReplace);

  return {
    after: restoreLineEndings(restoreTrailingNewline(normalizedBefore, updatedNormalized), before),
    replacements: replaceAll ? occurrences : 1,
    strategy: "line-ending-normalized",
    recoveredSearch: normalizedSearch,
  };
}

function tryFlexibleReplacement(
  before: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): EditRecoveryResult | null {
  const normalizedBefore = normalizeLineEndings(before);
  const sourceLines = normalizedBefore.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const searchLinesStripped = normalizeLineEndings(search)
    .split("\n")
    .map((line) => line.trim());
  const replaceLines = normalizeLineEndings(replace).split("\n");

  if (searchLinesStripped.length === 0 || sourceLines.length < searchLinesStripped.length) {
    return null;
  }

  let occurrences = 0;
  let cursor = 0;

  while (cursor <= sourceLines.length - searchLinesStripped.length) {
    const window = sourceLines.slice(cursor, cursor + searchLinesStripped.length);
    const strippedWindow = window.map((line) => line.trim());
    const matched = strippedWindow.every((line, index) => line === searchLinesStripped[index]);
    if (!matched) {
      cursor += 1;
      continue;
    }

    occurrences += 1;
    const indentation = window[0]?.match(/^([ \t]*)/)?.[1] ?? "";
    const replacementBlock = applyIndentation(replaceLines, indentation).join("\n");
    sourceLines.splice(cursor, searchLinesStripped.length, replacementBlock);
    cursor += replaceLines.length;

    if (!replaceAll) {
      break;
    }
  }

  if (occurrences === 0) {
    return null;
  }

  const updated = restoreTrailingNewline(normalizedBefore, sourceLines.join(""));
  return {
    after: restoreLineEndings(updated, before),
    replacements: occurrences,
    strategy: "flexible",
    recoveredSearch: searchLinesStripped.join("\n"),
  };
}

function tryRegexReplacement(
  before: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): EditRecoveryResult | null {
  const normalizedBefore = normalizeLineEndings(before);
  const normalizedSearch = normalizeLineEndings(search);
  const normalizedReplace = normalizeLineEndings(replace);

  let processed = normalizedSearch;
  for (const delimiter of ["(", ")", ":", "[", "]", "{", "}", ">", "<", "="]) {
    processed = processed.split(delimiter).join(` ${delimiter} `);
  }

  const tokens = processed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const pattern = tokens.map((token) => escapeRegex(token)).join("\\s*");
  const finalPattern = `^([ \\t]*)${pattern}`;
  const globalRegex = new RegExp(finalPattern, "gm");
  const matches = normalizedBefore.match(globalRegex);
  if (!matches) {
    return null;
  }

  const replacementRegex = new RegExp(finalPattern, replaceAll ? "gm" : "m");
  const replacementLines = normalizedReplace.split("\n");
  const updated = normalizedBefore.replace(
    replacementRegex,
    (_matched, indentation) => applyIndentation(replacementLines, indentation || "").join("\n"),
  );

  return {
    after: restoreLineEndings(restoreTrailingNewline(normalizedBefore, updated), before),
    replacements: matches.length,
    strategy: "regex",
    recoveredSearch: normalizedSearch,
  };
}

export function applyEditWithRecovery(
  before: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): EditRecoveryResult {
  const exact = tryExactReplacement(before, search, replace, replaceAll);
  if (exact) {
    return exact;
  }

  const alreadyApplied = tryAlreadyApplied(before, search, replace);
  if (alreadyApplied) {
    return alreadyApplied;
  }

  const lineEndingNormalized = tryLineEndingNormalizedReplacement(before, search, replace, replaceAll);
  if (lineEndingNormalized) {
    return lineEndingNormalized;
  }

  const flexible = tryFlexibleReplacement(before, search, replace, replaceAll);
  if (flexible) {
    return flexible;
  }

  const regex = tryRegexReplacement(before, search, replace, replaceAll);
  if (regex) {
    return regex;
  }

  throw new Error(
    [
      `未找到要替换的内容: ${search}`,
      `search_hash=${createHash("sha256").update(search).digest("hex").slice(0, 12)}`,
      "edit recovery 已尝试 exact / already-applied / line-ending-normalized / flexible / regex，仍未命中。",
    ].join("\n"),
  );
}
