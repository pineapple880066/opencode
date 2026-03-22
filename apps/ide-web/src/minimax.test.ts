import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_TOOL_POLICIES } from "@agent-ide/core";
import type { AgentGraphState } from "@agent-ide/runtime";

import { createMiniMaxHooks, readMiniMaxConfig } from "./minimax.js";
import { seedIdeShellService } from "./testing.js";

function createMockFetch(responses: string[]): typeof fetch {
  let index = 0;

  return async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      reasoning_split?: boolean;
    };

    assert.equal(requestBody.model, "MiniMax-M2.7");
    assert.equal(requestBody.reasoning_split, true);

    const content = responses[index++];
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content,
            },
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

function createRecordingMockFetch(
  responses: string[],
  onRequest?: (requestBody: Record<string, unknown>, index: number) => void,
): typeof fetch {
  let index = 0;

  return async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    assert.equal(requestBody.model, "MiniMax-M2.7");
    assert.equal(requestBody.reasoning_split, true);
    onRequest?.(requestBody, index);

    const content = responses[index++];
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content,
            },
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

describe("MiniMax hooks", () => {
  test("会读取 MiniMax 配置并应用默认值", () => {
    const config = readMiniMaxConfig({
      MINIMAX_API_KEY: "test-key",
    });

    assert.equal(config.baseUrl, "https://api.minimax.io/v1");
    assert.equal(config.model, "MiniMax-M2.7");
    assert.equal(config.temperature, 0.2);
    assert.equal(config.timeoutMs, 60000);
  });

  test("可以通过 MiniMax 结构化响应构造完整 LangGraph hooks，并归一化常见枚举别名", async () => {
    const service = await seedIdeShellService();
    const state = await service.buildGraphState("session_parent");
    assert.ok(state);

    const hooks = createMiniMaxHooks({
      env: {
        MINIMAX_API_KEY: "test-key",
      },
      fetchImpl: createMockFetch([
        JSON.stringify({
          title: "接入 MiniMax",
          description: "把 MiniMax hooks 接到 agent runtime 上",
          successCriteria: ["能创建 goal", "能生成 plan"],
        }),
        JSON.stringify({
          summary: "先接模型，再跑 smoke",
          status: "planned",
          steps: [
            {
              title: "写 hooks",
              description: "把 MiniMax 适配成 LangGraph hooks",
              status: "pending",
            },
            {
              title: "跑 smoke",
              description: "确认真实返回能被 runtime 吸收",
              status: "进行中",
            },
          ],
        }),
        JSON.stringify({
          shouldDelegate: "true",
          agentMode: "research",
          title: "explore child",
          reason: "先只读分析当前 runtime 状态",
          inputSummary: "检查当前 session 和 subagent 情况",
          inheritActiveGoal: "true",
        }),
        JSON.stringify({
          assistantMessage: "MiniMax executor 已给出结构化执行结果。",
          tasks: [
            {
              id: "task_parent",
              title: "追踪 delegation",
              status: "completed",
              inputSummary: "继续观察当前 orchestration",
              outputSummary: "模型已返回第一版执行判断",
            },
          ],
          memory: [
            {
              scope: "project",
              key: "model_provider",
              value: "MiniMax hooks 已接入",
              source: "model",
              confidence: 0.8,
            },
          ],
        }),
        JSON.stringify({
          satisfied: "false",
          reasons: ["还没有真实 API 跑通证据"],
          remainingRisks: ["等待真实调用验证"],
          recommendedNextStep: "运行 smoke 脚本检查真实返回",
        }),
        JSON.stringify({
          shortSummary: "MiniMax hooks 已准备好",
          openLoops: ["等待真实 API 验证"],
          nextActions: ["运行 minimax smoke"],
          importantFacts: ["当前 LangGraph hooks 已可注入"],
        }),
      ]),
    });

    const goal = await hooks.goalFactory?.({
      sessionId: "session_parent",
      userMessage: "帮我把 MiniMax 接进这个 agent IDE",
    });
    const plan = await hooks.planner?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 MiniMax 接进这个 agent IDE",
    });
    const delegation = await hooks.delegate?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 MiniMax 接进这个 agent IDE",
    });
    const execution = await hooks.executor?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 MiniMax 接进这个 agent IDE",
    });
    const review = await hooks.reviewer?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 MiniMax 接进这个 agent IDE",
    });
    const summary = await hooks.summarizer?.(state, {
      sessionId: "session_parent",
      userMessage: "帮我把 MiniMax 接进这个 agent IDE",
    });

    assert.equal(goal?.title, "接入 MiniMax");
    assert.equal(plan?.status, "ready");
    assert.equal(plan?.steps[0]?.status, "todo");
    assert.equal(plan?.steps[1]?.status, "in_progress");
    assert.equal(delegation?.agentMode, "explore");
    assert.equal(delegation?.inheritActiveGoal, true);
    assert.equal(execution?.tasks?.[0]?.id, "task_parent");
    assert.equal(execution?.tasks?.[0]?.status, "done");
    assert.equal(execution?.memory?.[0]?.scope, "workspace");
    assert.equal(execution?.memory?.[0]?.source, "assistant");
    assert.equal(review?.satisfied, false);
    assert.equal(summary?.shortSummary, "MiniMax hooks 已准备好");
  });

  test("goalFactory 会本地裁剪超限 successCriteria，而不是直接因为数组过长失败", async () => {
    const hooks = createMiniMaxHooks({
      env: {
        MINIMAX_API_KEY: "test-key",
      },
      fetchImpl: createMockFetch([
        JSON.stringify({
          title: "创建 Agent IDE Goal 系统",
          description: "设计一个结构化 goal 生成系统。",
          successCriteria: [
            "解析用户输入",
            "生成 goal JSON",
            "校验 title",
            "校验 description",
            "校验 successCriteria",
            "支持自动化验证",
            "输出可被 runtime 使用",
            "适配不同复杂度请求",
          ],
        }),
      ]),
    });

    const goal = await hooks.goalFactory?.({
      sessionId: "session_parent",
      userMessage: "请为这个 agent IDE 创建一个 goal，并生成一份可执行计划",
    });

    assert.ok(goal);
    assert.equal(goal.successCriteria.length, 6);
    assert.deepEqual(goal.successCriteria, [
      "解析用户输入",
      "生成 goal JSON",
      "校验 title",
      "校验 description",
      "校验 successCriteria",
      "支持自动化验证",
    ]);
  });

  test("本地 sanitizer 仍无法修复时，会触发一次 JSON repair 重试", async () => {
    let requestCount = 0;
    let repairPromptSeen = false;

    const hooks = createMiniMaxHooks({
      env: {
        MINIMAX_API_KEY: "test-key",
      },
      fetchImpl: createRecordingMockFetch(
        [
          JSON.stringify({
            title: 123,
            description: "第一版返回仍然不合法",
            successCriteria: [],
          }),
          JSON.stringify({
            title: "创建 Agent IDE Goal",
            description: "修复后返回合法的 goal。",
            successCriteria: ["结构合法", "可执行", "可验证"],
          }),
        ],
        (requestBody, index) => {
          requestCount += 1;
          const messages = Array.isArray(requestBody.messages)
            ? (requestBody.messages as Array<{ role?: string; content?: string }>)
            : [];
          const userContent = messages.find((message) => message.role === "user")?.content ?? "";
          if (index === 1 && typeof userContent === "string" && userContent.includes("validationErrors:")) {
            repairPromptSeen = true;
          }
        },
      ),
    });

    const goal = await hooks.goalFactory?.({
      sessionId: "session_parent",
      userMessage: "请生成一个结构化 goal",
    });

    assert.equal(requestCount, 2);
    assert.equal(repairPromptSeen, true);
    assert.equal(goal?.title, "创建 Agent IDE Goal");
    assert.deepEqual(goal?.successCriteria, ["结构合法", "可执行", "可验证"]);
  });

  test("语法损坏的 JSON 会触发一次 syntax repair 重试", async () => {
    let requestCount = 0;
    let syntaxRepairSeen = false;

    const hooks = createMiniMaxHooks({
      env: {
        MINIMAX_API_KEY: "test-key",
      },
      fetchImpl: createRecordingMockFetch(
        [
          "{\"title\":\"创建 Agent IDE Goal\",\"description\":\"第一版 JSON 缺了数组逗号\",\"successCriteria\":[\"先创建 goal\" \"再生成计划\"]}",
          JSON.stringify({
            title: "创建 Agent IDE Goal",
            description: "修复语法后返回合法的 goal。",
            successCriteria: ["先创建 goal", "再生成计划"],
          }),
        ],
        (requestBody, index) => {
          requestCount += 1;
          const messages = Array.isArray(requestBody.messages)
            ? (requestBody.messages as Array<{ role?: string; content?: string }>)
            : [];
          const userContent = messages.find((message) => message.role === "user")?.content ?? "";
          if (index === 1 && typeof userContent === "string" && userContent.includes("syntaxError:")) {
            syntaxRepairSeen = true;
          }
        },
      ),
    });

    const goal = await hooks.goalFactory?.({
      sessionId: "session_parent",
      userMessage: "请创建一个 goal",
    });

    assert.equal(requestCount, 2);
    assert.equal(syntaxRepairSeen, true);
    assert.equal(goal?.title, "创建 Agent IDE Goal");
    assert.deepEqual(goal?.successCriteria, ["先创建 goal", "再生成计划"]);
  });

  test("executor 会用当前 state 补全缺失的 task 字段，并丢弃空 memory 项", async () => {
    const state: AgentGraphState = {
      workspaceId: "workspace_1",
      session: {
        id: "session_parent",
        workspaceId: "workspace_1",
        title: "main build session",
        status: "active",
        activeAgentMode: "build",
        activeGoalId: "goal_parent",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: "2026-03-21T10:00:00.000Z",
        updatedAt: "2026-03-21T10:00:00.000Z",
      },
      activeGoal: {
        id: "goal_parent",
        workspaceId: "workspace_1",
        sessionId: "session_parent",
        title: "修复 MiniMax executor 健壮性",
        description: "让 executor 阶段更能吸收不完整 JSON",
        successCriteria: ["能补全已有 step 信息"],
        status: "active",
        createdAt: "2026-03-21T10:00:00.000Z",
        updatedAt: "2026-03-21T10:00:00.000Z",
      },
      currentPlan: {
        id: "plan_1",
        goalId: "goal_parent",
        sessionId: "session_parent",
        status: "ready",
        summary: "执行当前计划",
        steps: [
          {
            id: "plan_step_1",
            title: "检查现有 plan",
            description: "确认上一轮 plan 还在不在",
            status: "todo",
          },
        ],
        createdAt: "2026-03-21T10:00:00.000Z",
        updatedAt: "2026-03-21T10:00:00.000Z",
      },
      tasks: [],
      memory: [],
      messages: [],
      toolInvocations: [],
      subagentRuns: [],
      checkpoints: [],
      activeAgent: "build",
      activePolicy: DEFAULT_TOOL_POLICIES.build,
    };

    const hooks = createMiniMaxHooks({
      env: {
        MINIMAX_API_KEY: "test-key",
      },
      fetchImpl: createMockFetch([
        JSON.stringify({
          tasks: [
            {
              id: "plan_step_1",
              status: "doing",
              title: "",
              inputSummary: "",
            },
          ],
          memory: [
            {
              scope: "workspace",
              key: "empty_fact",
              value: "",
              source: "assistant",
              confidence: 1,
            },
          ],
        }),
      ]),
    });

    const execution = await hooks.executor?.(state, {
      sessionId: "session_parent",
      userMessage: "你刚才生成的 goal 计划去哪了",
    });

    assert.equal(execution?.tasks?.length, 1);
    assert.equal(execution?.tasks?.[0]?.id, "plan_step_1");
    assert.equal(execution?.tasks?.[0]?.title, "检查现有 plan");
    assert.equal(execution?.tasks?.[0]?.inputSummary, "确认上一轮 plan 还在不在");
    assert.equal(execution?.tasks?.[0]?.status, "in_progress");
    assert.equal(execution?.memory?.length ?? 0, 0);
  });

  test("executor 可以返回 toolCalls，请求 runtime 走真实工具循环", async () => {
    const state: AgentGraphState = {
      workspaceId: "workspace_1",
      session: {
        id: "session_parent",
        workspaceId: "workspace_1",
        title: "main build session",
        status: "active",
        activeAgentMode: "build",
        activeGoalId: "goal_parent",
        summary: {
          shortSummary: "",
          openLoops: [],
          nextActions: [],
          importantFacts: [],
        },
        createdAt: "2026-03-21T10:00:00.000Z",
        updatedAt: "2026-03-21T10:00:00.000Z",
      },
      activeGoal: {
        id: "goal_parent",
        workspaceId: "workspace_1",
        sessionId: "session_parent",
        title: "修改 bootstrap.ts",
        description: "通过工具循环给 bootstrap.ts 加注释",
        successCriteria: ["先 view 再 edit"],
        status: "active",
        createdAt: "2026-03-21T10:00:00.000Z",
        updatedAt: "2026-03-21T10:00:00.000Z",
      },
      currentPlan: {
        id: "plan_1",
        goalId: "goal_parent",
        sessionId: "session_parent",
        status: "ready",
        summary: "先读取文件，再修改文件",
        steps: [],
        createdAt: "2026-03-21T10:00:00.000Z",
        updatedAt: "2026-03-21T10:00:00.000Z",
      },
      tasks: [],
      memory: [],
      messages: [],
      toolInvocations: [],
      subagentRuns: [],
      checkpoints: [],
      activeAgent: "build",
      activePolicy: DEFAULT_TOOL_POLICIES.build,
    };

    const hooks = createMiniMaxHooks({
      env: {
        MINIMAX_API_KEY: "test-key",
      },
      fetchImpl: createMockFetch([
        JSON.stringify({
          executionPhase: "analysis",
          assistantMessage: "先读取 bootstrap.ts。",
          toolCalls: [
            {
              name: "view",
              taskId: "plan_step_view",
              reasoning: "先读取文件，避免盲改。",
              input: {
                path: "apps/ide-web/src/bootstrap.ts",
              },
            },
            {
              name: "edit",
              taskId: "plan_step_edit",
              reasoning: "读取后再做局部修改。",
              input: {
                path: "apps/ide-web/src/bootstrap.ts",
                search: "const config = readPersistenceConfig(options?.env);",
                replace: "// 注释\\nconst config = readPersistenceConfig(options?.env);",
              },
            },
          ],
        }),
      ]),
    });

    const execution = await hooks.executor?.(state, {
      sessionId: "session_parent",
      userMessage: "在 bootstrap.ts 里加两行注释",
    });

    assert.equal(execution?.executionPhase, "explain");
    assert.equal(execution?.toolCalls?.length, 2);
    assert.equal(execution?.toolCalls?.[0]?.name, "view");
    assert.equal(execution?.toolCalls?.[0]?.input.path, "apps/ide-web/src/bootstrap.ts");
    assert.equal(execution?.toolCalls?.[1]?.name, "edit");
  });
});
