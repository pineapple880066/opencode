// 这些是我们认为“必须存在”的场景测试套件。它们直接对应文档里定义的
// 核心能力门槛，不是可有可无的锦上添花。
export const REQUIRED_SCENARIO_SUITES = [
  "memory-persists-across-restart",
  "multi-session-create-resume-archive",
  "multi-session-create-rename-child-archive",
  "subagent-parent-child-linkage",
  "subagent-replay-and-cleanup",
  "planning-mode-blocks-side-effects",
  "goal-flow-plan-execute-review",
] as const;

export function describeEvaluationExpectation(): string {
  return [
    "每个关键能力都至少要有一个场景化验证。",
    "对核心 runtime 来说，只靠人工感觉测试过了还不够。",
  ].join(" ");
}

export const PERSISTENCE_SMOKE_EXPECTATIONS = [
  "真实 MySQL 可以创建数据库并应用初始 schema。",
  "真实 Redis 可以连接并服务 session summary cache。",
  "LangGraph invoke 之后会把 durable checkpoint 写入 MySQL。",
] as const;

export * from "./swebench-lite.js";
