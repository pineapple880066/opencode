import { CORE_WORKFLOW } from "@agent-ide/runtime";

// 这里暂时只是未来 IDE shell 的启动占位配置。
// 它表达的是第一版 Web IDE 最应该围绕哪些面板来组织。
export const ideBootstrapState = {
  surface: "ide-web",
  firstFocus: "session-list",
  requiredPanels: ["sessions", "goal", "plan", "activity-log"],
  workflow: CORE_WORKFLOW,
} as const;
