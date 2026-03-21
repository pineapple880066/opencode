// 这些是我们认为“必须存在”的场景测试套件。它们直接对应文档里定义的
// 核心能力门槛，不是可有可无的锦上添花。
export const REQUIRED_SCENARIO_SUITES = [
  "memory-persists-across-restart",
  "multi-session-create-resume-archive",
  "subagent-parent-child-linkage",
  "planning-mode-blocks-side-effects",
  "goal-flow-plan-execute-review",
] as const;

export function describeEvaluationExpectation(): string {
  return [
    "每个关键能力都至少要有一个场景化验证。",
    "对核心 runtime 来说，只靠人工感觉测试过了还不够。",
  ].join(" ");
}
