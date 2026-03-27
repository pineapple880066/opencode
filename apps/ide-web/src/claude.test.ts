import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createClaudeHooks, hasClaudeConfig, readClaudeConfig } from "./claude.js";
import { seedIdeShellService } from "./testing.js";

function createAnthropicMockFetch(
  responses: string[],
  onRequest?: (request: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
    index: number;
  }) => void,
): typeof fetch {
  let index = 0;

  return async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    onRequest?.({
      url,
      headers,
      body,
      index,
    });

    const content = responses[index++];
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: content,
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };
}

describe("Claude hooks", () => {
  test("会读取 Claude 配置并应用默认值", () => {
    const config = readClaudeConfig({
      CLAUDE_API_KEY: "test-key",
      CLAUDE_MODEL: "claude-opus-4-6",
    });

    assert.equal(config.baseUrl, "https://api.anthropic.com");
    assert.equal(config.model, "claude-opus-4-6");
    assert.equal(config.temperature, 0.2);
    assert.equal(config.timeoutMs, 60000);
    assert.equal(config.maxOutputTokens, 1600);
    assert.equal(config.thinkingBudget, 0);
  });

  test("hasClaudeConfig 会按 API key 判断是否启用 Claude provider", () => {
    assert.equal(hasClaudeConfig({}), false);
    assert.equal(hasClaudeConfig({ CLAUDE_API_KEY: "" }), false);
    assert.equal(hasClaudeConfig({ CLAUDE_API_KEY: "test-key" }), true);
  });

  test("可以通过 Anthropic-compatible messages API 构造完整 Claude hooks", async () => {
    const service = await seedIdeShellService();
    const state = await service.buildGraphState("session_parent");
    assert.ok(state);

    const hooks = createClaudeHooks({
      env: {
        CLAUDE_API_KEY: "test-key",
        CLAUDE_BASE_URL: "https://openoneapi.com",
        CLAUDE_MODEL: "claude-opus-4-6",
        CLAUDE_THINKING_BUDGET: "1024",
      },
      fetchImpl: createAnthropicMockFetch(
        [
          JSON.stringify({
            title: "接入 Claude",
            description: "把 Claude hooks 接到 agent runtime 上",
            successCriteria: ["能创建 goal", "能生成 plan"],
          }),
          JSON.stringify({
            summary: "先接模型，再跑 smoke",
            status: "ready",
            steps: [
              {
                title: "写 hooks",
                description: "把 Claude 适配成 LangGraph hooks",
                status: "todo",
              },
            ],
          }),
          JSON.stringify({
            shouldDelegate: true,
            agentMode: "explore",
            title: "explore child",
            reason: "先只读分析当前 runtime 状态",
            inputSummary: "检查当前 session 和 subagent 情况",
            inheritActiveGoal: true,
          }),
          JSON.stringify({
            assistantMessage: "Claude executor 已给出结构化执行结果。",
            tasks: [
              {
                id: "task_parent",
                title: "追踪 delegation",
                status: "done",
                inputSummary: "继续观察当前 orchestration",
                outputSummary: "模型已返回第一版执行判断",
              },
            ],
            memory: [
              {
                scope: "workspace",
                key: "model_provider",
                value: "Claude hooks 已接入",
                source: "assistant",
                confidence: 0.8,
              },
            ],
          }),
          JSON.stringify({
            satisfied: false,
            reasons: ["还没有真实 API 跑通证据"],
            remainingRisks: ["等待真实调用验证"],
            recommendedNextStep: "运行 Claude smoke 脚本检查真实返回",
          }),
          JSON.stringify({
            shortSummary: "Claude hooks 已准备好",
            openLoops: ["等待真实 API 验证"],
            nextActions: ["运行 claude smoke"],
            importantFacts: ["当前 LangGraph hooks 已可注入"],
          }),
        ],
        ({ url, headers, body, index }) => {
          assert.equal(url, "https://openoneapi.com/v1/messages");
          assert.equal(headers.get("x-api-key"), "test-key");
          assert.equal(headers.get("anthropic-version"), "2023-06-01");
          assert.equal(body.model, "claude-opus-4-6");
          assert.equal(body.max_tokens, 1600);
          assert.deepEqual(body.thinking, {
            type: "enabled",
            budget_tokens: 1024,
          });

          if (index === 0) {
            assert.equal(typeof body.system, "string");
            assert.ok(Array.isArray(body.messages));
          }
        },
      ),
    });

    const goal = await hooks.goalFactory?.({
      sessionId: "session_parent",
      userMessage: "帮我把 Claude 接进这个 agent IDE",
    });
    const plan = await hooks.planner?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 Claude 接进这个 agent IDE",
    });
    const delegation = await hooks.delegate?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 Claude 接进这个 agent IDE",
    });
    const execution = await hooks.executor?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 Claude 接进这个 agent IDE",
    });
    const review = await hooks.reviewer?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 Claude 接进这个 agent IDE",
    });
    const summary = await hooks.summarizer?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 Claude 接进这个 agent IDE",
    });

    assert.equal(goal?.title, "接入 Claude");
    assert.equal(plan?.status, "ready");
    assert.equal(delegation?.agentMode, "explore");
    assert.equal(execution?.tasks?.[0]?.id, "task_parent");
    assert.equal(review?.satisfied, false);
    assert.equal(summary?.shortSummary, "Claude hooks 已准备好");
  });
});
