import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readSmokeInvocation } from "./minimax-smoke.js";

describe("MiniMax smoke invocation", () => {
  test("默认读取 prompt，并支持显式指定 session", () => {
    const invocation = readSmokeInvocation(["--session", "session_123", "继续", "执行"], {});

    assert.equal(invocation.sessionId, "session_123");
    assert.equal(invocation.reuseLatest, false);
    assert.equal(invocation.prompt, "继续 执行");
  });

  test("支持复用最新 session，并回退到环境变量 prompt", () => {
    const invocation = readSmokeInvocation(["--latest"], {
      MINIMAX_SMOKE_PROMPT: "继续基于当前计划往下执行",
    });

    assert.equal(invocation.reuseLatest, true);
    assert.equal(invocation.prompt, "继续基于当前计划往下执行");
  });
});
