import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  buildSweBenchTaskPrompt,
  createDefaultSweBenchRunId,
  parseSweBenchInstancesContent,
  readSweBenchLiteInvocation,
} from "./swebench-lite.js";

describe("SWE-bench Lite runner helpers", () => {
  test("会解析 CLI 参数并生成稳定的默认目录", () => {
    const invocation = readSweBenchLiteInvocation(
      [
        "--instances-file",
        "fixtures/instances.json",
        "--instance",
        "sympy__sympy-20590",
        "--limit",
        "5",
        "--fail-fast",
      ],
      {},
    );

    assert.match(invocation.instancesFile, /fixtures\/instances\.json$/);
    assert.equal(invocation.instanceIds[0], "sympy__sympy-20590");
    assert.equal(invocation.limit, 5);
    assert.equal(invocation.continueOnError, false);
    assert.match(invocation.outputDir, /\.benchmarks\/swebench-lite\/runs\//);
    assert.match(invocation.workspaceRoot, /\.benchmarks\/swebench-lite\/runs\/.*\/workspaces$/);
  });

  test("会解析 JSON 和 JSONL 两种实例文件格式", () => {
    const jsonInstances = parseSweBenchInstancesContent(
      JSON.stringify([
        {
          instance_id: "sympy__sympy-20590",
          repo: "sympy/sympy",
          base_commit: "abc123",
          problem_statement: "Fix sympify issue.",
        },
      ]),
      "instances.json",
    );

    const jsonlInstances = parseSweBenchInstancesContent(
      [
        JSON.stringify({
          instance_id: "sphinx-doc__sphinx-11445",
          repo: "sphinx-doc/sphinx",
          base_commit: "def456",
          problem_statement: "Fix sphinx issue.",
        }),
      ].join("\n"),
      "instances.jsonl",
    );

    assert.equal(jsonInstances.length, 1);
    assert.equal(jsonInstances[0]?.repo, "sympy/sympy");
    assert.equal(jsonlInstances.length, 1);
    assert.equal(jsonlInstances[0]?.repo, "sphinx-doc/sphinx");
  });

  test("benchmark prompt 会显式要求真实改动和 patch 输出", () => {
    const prompt = buildSweBenchTaskPrompt({
      instance_id: "sympy__sympy-20590",
      repo: "sympy/sympy",
      base_commit: "abc123",
      problem_statement: "Fix the sympify bug.",
      hints_text: "Prefer the smallest patch.",
      FAIL_TO_PASS: ["tests/test_sympify.py::test_a", "tests/test_sympify.py::test_b"],
    });

    assert.match(prompt, /SWE-bench Lite/);
    assert.match(prompt, /真实可评测的 patch/);
    assert.match(prompt, /bash 工具/);
    assert.match(prompt, /每个测试都当成独立验收项/);
    assert.match(prompt, /公开 API 的无效输入/);
    assert.match(prompt, /同模块里紧邻的同类校验/);
    assert.match(prompt, /下一轮必须进入 modify phase/);
    assert.match(prompt, /空 patch 视为失败/);
    assert.match(prompt, /sympy__sympy-20590/);
    assert.match(prompt, /Prefer the smallest patch/);
  });

  test("特定问题文本会触发同类校验镜像提示", () => {
    const prompt = buildSweBenchTaskPrompt({
      instance_id: "pallets__flask-4045",
      repo: "pallets/flask",
      base_commit: "abc123",
      problem_statement:
        "Raise error when blueprint name contains a dot. An error was already added for endpoint names in 1.0, but should have been added for this as well.",
    });

    assert.match(prompt, /endpoint name 的 dot 校验/);
    assert.match(prompt, /endpoint \/ view_func dot 校验/);
    assert.match(prompt, /统一成同一异常语义/);
  });

  test("默认 runId 带固定前缀和 UTC 时间", () => {
    const runId = createDefaultSweBenchRunId(new Date("2026-03-25T08:09:10.000Z"));
    assert.equal(runId, "swebench-lite-20260325T080910Z");
  });
});
