export type Identifier = string;

// 这些联合类型定义了系统里的稳定术语。后面的代码都应该复用这些词，
// 而不是在各个模块里再发明一套相近但不一致的名字。
export type AgentMode = "build" | "plan" | "explore" | "review" | "general";
export type SessionStatus = "active" | "archived";
export type GoalStatus = "draft" | "active" | "blocked" | "completed" | "abandoned";
export type PlanStatus = "draft" | "ready" | "in_progress" | "completed" | "failed";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "canceled";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type MemoryScope = "session" | "workspace" | "user";
export type MemorySource = "user" | "assistant" | "system" | "tool" | "review";
export type PermissionScope =
  | "read"
  | "write"
  | "edit"
  | "patch"
  | "bash"
  | "web"
  | "mcp"
  | "lsp"
  | "git";

// Workspace 是最外层边界。session、goal、memory，以及后续的工具执行，
// 都应该明确归属于某个 workspace。
export interface Workspace {
  id: Identifier;
  path: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

// Goal 是 “goal-driven” 工作流的核心锚点。成功标准直接挂在 goal 上，
// 这样 review 阶段才能真正判断任务是否完成，而不是凭感觉结束。
export interface Goal {
  id: Identifier;
  workspaceId: Identifier;
  sessionId: Identifier;
  title: string;
  description: string;
  successCriteria: string[];
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// PlanStep 和 Task 很像，但更轻。Plan 负责描述“应该做什么”，
// Task 负责记录“谁在执行什么具体工作”。
export interface PlanStep {
  id: Identifier;
  title: string;
  description: string;
  status: TaskStatus;
  evidence?: string;
}

// Plan 表示某个 goal 当前采用的策略。后面即使 plan 被重写或修订，
// 底层 goal 还是同一个，不会因为计划变化而丢失目标身份。
export interface Plan {
  id: Identifier;
  goalId: Identifier;
  sessionId: Identifier;
  status: PlanStatus;
  summary: string;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}

// Task 是执行层的最小工作单元。后面主 agent 或 subagent 接任务时，
// 真正被分配和追踪的就是它。
export interface Task {
  id: Identifier;
  goalId: Identifier;
  planId?: Identifier;
  sessionId: Identifier;
  ownerAgent: AgentMode;
  title: string;
  status: TaskStatus;
  inputSummary: string;
  outputSummary?: string;
  createdAt: string;
  updatedAt: string;
}

// SessionSummary 是 multi-session 可用的关键。如果没有它，恢复旧 session
// 时就只能把完整历史重新读一遍，体验会非常差。
export interface SessionSummary {
  shortSummary: string;
  openLoops: string[];
  nextActions: string[];
  importantFacts: string[];
}

// Session 是持久化的线程容器。parentSessionId 的存在，是为了从第一天起
// 就支持 fork / child-session，而不是后面再硬补。
export interface Session {
  id: Identifier;
  workspaceId: Identifier;
  parentSessionId?: Identifier;
  title: string;
  status: SessionStatus;
  activeAgentMode: AgentMode;
  activeGoalId?: Identifier;
  summary: SessionSummary;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// MemoryRecord 故意和消息历史分开。否则 memory 就会退化成“聊天记录里有提过”，
// 无法很好支持重启恢复、检索和跨 session 复用。
export interface MemoryRecord {
  id: Identifier;
  workspaceId: Identifier;
  sessionId?: Identifier;
  scope: MemoryScope;
  key: string;
  value: string;
  source: MemorySource;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

// ToolPolicy 是 mode 行为的真实约束面。比如 plan mode 是否只读，
// 不是看 prompt 怎么写，而是看这里的 allow / deny 是否真的被执行层尊重。
export interface ToolPolicy {
  mode: AgentMode;
  allowed: PermissionScope[];
  denied: PermissionScope[];
  requiresApproval: PermissionScope[];
}

// AgentProfile 把一个 agent mode 和它的职责、权限策略绑在一起。
export interface AgentProfile {
  id: AgentMode;
  label: string;
  description: string;
  policy: ToolPolicy;
}

// ReviewReport 是对“当前 goal 到底有没有完成”的结构化回答。
export interface ReviewReport {
  goalId: Identifier;
  satisfied: boolean;
  reasons: string[];
  remainingRisks: string[];
  recommendedNextStep?: string;
}

// SubagentRun 把 delegation 记录成一等事件。只有把 child session
// 和 parent 关系都记下来，“subagent” 才不是一句 prompt 里的角色扮演。
export interface SubagentRun {
  id: Identifier;
  parentSessionId: Identifier;
  childSessionId: Identifier;
  parentTaskId?: Identifier;
  agentMode: AgentMode;
  status: RunStatus;
  reason: string;
  inputSummary: string;
  resultSummary?: string;
  createdAt: string;
  updatedAt: string;
}

// 这是整个项目的底线清单。只要里面有一项没有真正实现，
// 就不能因为 UI 好看或者 demo 能跑就说项目完成了。
export const REQUIRED_CAPABILITIES = [
  "memory",
  "multi-session",
  "subagent",
  "planning-mode",
  "goal-driven",
] as const;

// 默认策略把不同 agent mode 的差异写死在配置里。
// 其中最关键的是 plan：它必须在权限层面保持只读。
export const DEFAULT_TOOL_POLICIES: Record<AgentMode, ToolPolicy> = {
  build: {
    mode: "build",
    allowed: ["read", "write", "edit", "patch", "bash", "web", "git", "lsp", "mcp"],
    denied: [],
    requiresApproval: ["bash", "patch", "git"],
  },
  plan: {
    mode: "plan",
    allowed: ["read", "web", "lsp", "mcp"],
    denied: ["write", "edit", "patch", "bash", "git"],
    requiresApproval: [],
  },
  explore: {
    mode: "explore",
    allowed: ["read", "web", "git", "lsp", "mcp"],
    denied: ["write", "edit", "patch", "bash"],
    requiresApproval: [],
  },
  review: {
    mode: "review",
    allowed: ["read", "git", "lsp", "mcp"],
    denied: ["write", "edit", "patch", "bash", "web"],
    requiresApproval: [],
  },
  general: {
    mode: "general",
    allowed: ["read", "write", "edit", "patch", "bash", "web", "git", "lsp", "mcp"],
    denied: [],
    requiresApproval: ["bash", "patch", "git"],
  },
};

// 这些 profile 是系统准备暴露给 runtime 和 IDE 的内置 agent 定义。
export const DEFAULT_AGENT_PROFILES: Record<AgentMode, AgentProfile> = {
  build: {
    id: "build",
    label: "Build",
    description: "Default execution agent with full build-oriented tool access.",
    policy: DEFAULT_TOOL_POLICIES.build,
  },
  plan: {
    id: "plan",
    label: "Plan",
    description: "Planning-only agent with real side-effect restrictions.",
    policy: DEFAULT_TOOL_POLICIES.plan,
  },
  explore: {
    id: "explore",
    label: "Explore",
    description: "Read-only context gathering agent for bounded discovery work.",
    policy: DEFAULT_TOOL_POLICIES.explore,
  },
  review: {
    id: "review",
    label: "Review",
    description: "Read-only critique agent for goal and code quality review.",
    policy: DEFAULT_TOOL_POLICIES.review,
  },
  general: {
    id: "general",
    label: "General",
    description: "Fallback general-purpose execution agent.",
    policy: DEFAULT_TOOL_POLICIES.general,
  },
};
