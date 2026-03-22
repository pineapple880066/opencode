import { CORE_WORKFLOW } from "@agent-ide/runtime";

// 这里暂时只是未来 IDE shell 的启动占位配置。
// 它表达的是第一版 Web IDE 最应该围绕哪些面板来组织。
export const ideBootstrapState = {
  surface: "ide-web",
  firstFocus: "workbench",
  requiredPanels: ["workbench", "goal", "plan", "activity-log", "subagent-replay", "parent-task-delegation", "inspector"],
  workflow: CORE_WORKFLOW,
} as const;

export * from "./bootstrap.js";
export * from "./browser.js";
export * from "./minimax.js";
export * from "./panels.js";
export * from "./server.js";
export * from "./shell.js";
export * from "./terminal.js";
