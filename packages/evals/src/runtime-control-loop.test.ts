import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { MemorySaver } from "@langchain/langgraph";
import { createBuiltinToolRegistry } from "@agent-ide/tools";
import { createAgentLangGraph, GoalDrivenRuntimeService, RuntimeToolExecutor } from "@agent-ide/runtime";

import { InMemoryIdeRuntimeStore } from "../../../apps/ide-web/src/testing.js";

describe("runtime control loop eval", () => {
  test("行为修复任务里，superficial patch 会被继续推进到真实修改和目标验证", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ide-runtime-eval-"));

    try {
      await writeFile(
        path.join(tempRoot, "streaming.py"),
        [
          "import socket",
          "",
          "def wrap_stream(raw):",
          "    try:",
          "        return list(raw.stream(1))",
          "    except socket.error as error:",
          "        raise RuntimeError(\"socket failed\") from error",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(tempRoot, "tests"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "tests", "test_streaming.py"),
        [
          "import unittest",
          "",
          "from streaming import wrap_stream",
          "",
          "class Raw:",
          "    def stream(self, _chunk_size):",
          "        import socket",
          "        raise socket.error(\"boom\")",
          "",
          "class StreamingTests(unittest.TestCase):",
          "    def test_wrap_stream_handles_socket_error(self):",
          "        with self.assertRaises(ConnectionError):",
          "            wrap_stream(Raw())",
          "",
          "if __name__ == '__main__':",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8",
      );

      const store = new InMemoryIdeRuntimeStore();
      const service = new GoalDrivenRuntimeService(store);
      const session = await service.createSession({
        workspacePath: tempRoot,
        title: "runtime eval",
        agentMode: "build",
      });
      const toolExecutor = new RuntimeToolExecutor(store, createBuiltinToolRegistry());
      let executorCallCount = 0;

      const runtime = createAgentLangGraph(service, {
        checkpointer: new MemorySaver(),
        toolExecutor,
        maxToolRounds: 8,
        toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash",
        hooks: {
          goalFactory: async () => ({
            title: "修复 socket.error 包装",
            description: "行为修复必须命中真实函数体并通过目标测试。",
            successCriteria: ["wrap_stream 把 socket.error 包成 ConnectionError", "目标测试通过"],
          }),
          planner: async () => ({
            summary: "先尝试修改，再跑目标测试验证。",
            steps: [
              { id: "step_modify", title: "修改 wrap_stream", description: "命中真实函数体", status: "todo" },
              { id: "step_verify", title: "运行目标测试", description: "验证 socket.error 包装", status: "todo" },
            ],
            tasks: [
              {
                id: "task_modify",
                ownerAgent: "build",
                title: "修改 wrap_stream",
                status: "todo",
                inputSummary: "不能停在 superficial patch",
              },
            ],
          }),
          delegate: async () => null,
          executor: async (_state, context) => {
            executorCallCount += 1;
            const messages = store.messagesMap.get(context.sessionId) ?? [];
            const toolMessages = messages.filter((message) => message.role === "tool");
            const systemMessages = messages.filter((message) => message.role === "system");
            const sawSuperficialPolicy = systemMessages.some((message) =>
              message.content.includes("当前 edit 只在目标文件上做 import/comment/表层整理"),
            );
            const currentContent = await readFile(path.join(tempRoot, "streaming.py"), "utf8");
            const hasBehaviorFix = currentContent.includes('raise ConnectionError("socket failed") from error');
            const editCount = toolMessages.filter((message) => message.content.includes("tool=edit")).length;
            const sawVerify = toolMessages.some((message) => message.content.includes("tool=bash"));

            if (!sawSuperficialPolicy && editCount === 0) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "step_modify",
                    reasoning: "先试一个表层 import patch，验证 runtime 会继续追真实行为修改。",
                    input: {
                      root: tempRoot,
                      path: "streaming.py",
                      search: "import socket",
                      replace: "import socket\nfrom typing import Any",
                    },
                  },
                ],
              };
            }

            if (!hasBehaviorFix && (editCount === 0 || sawSuperficialPolicy)) {
              return {
                executionPhase: "modify",
                toolCalls: [
                  {
                    name: "edit",
                    taskId: "step_modify",
                    reasoning: "命中真实函数体，把 socket.error 包成 ConnectionError。",
                    input: {
                      root: tempRoot,
                      path: "streaming.py",
                      search: [
                        "    try:",
                        "        return list(raw.stream(1))",
                        "    except socket.error as error:",
                        "        raise RuntimeError(\"socket failed\") from error",
                      ].join("\n"),
                      replace: [
                        "    try:",
                        "        return list(raw.stream(1))",
                        "    except socket.error as error:",
                        "        raise ConnectionError(\"socket failed\") from error",
                      ].join("\n"),
                    },
                  },
                ],
              };
            }

            if (!sawVerify) {
              return {
                executionPhase: "verify",
                toolCalls: [
                  {
                    name: "bash",
                    taskId: "step_verify",
                    reasoning: "运行目标测试。",
                    input: {
                      root: tempRoot,
                      command: "python3 -m unittest tests.test_streaming",
                      cwd: ".",
                    },
                  },
                ],
              };
            }

            return {
              executionPhase: "finalize",
              assistantMessage: "已经命中真实行为路径并通过目标测试。",
              tasks: [
                {
                  id: "task_modify",
                  title: "修改 wrap_stream",
                  inputSummary: "行为修复",
                  outputSummary: "wrap_stream 现在会把 socket.error 包成 ConnectionError。",
                  status: "done",
                },
              ],
            };
          },
          reviewer: async () => ({
            satisfied: true,
            reasons: ["已命中真实行为路径并完成目标验证。"],
            remainingRisks: [],
          }),
          summarizer: async () => ({
            shortSummary: "runtime eval 已完成",
            openLoops: [],
            nextActions: [],
            importantFacts: ["superficial patch 不会直接收尾"],
          }),
        },
      });

      await runtime.invoke({
        sessionId: session.id,
        userMessage: "修复 streaming.py，让 socket.error 被包装成 ConnectionError，并验证测试通过。",
      });

      const finalContent = await readFile(path.join(tempRoot, "streaming.py"), "utf8");
      assert.match(finalContent, /raise ConnectionError\("socket failed"\) from error/);
      assert.doesNotMatch(finalContent, /from typing import Any/);
      assert.ok(executorCallCount >= 4);

      const toolLogs = Array.from(store.toolInvocationsMap.values());
      assert.equal(toolLogs.some((log) => log.toolName === "bash" && log.status === "completed"), true);
      assert.equal(toolLogs.some((log) => log.toolName === "edit" && log.status === "completed"), true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
