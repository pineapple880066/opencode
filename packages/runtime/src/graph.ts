import type {
  AgentMode,
  Goal,
  Identifier,
  MemoryRecord,
  Plan,
  ReviewReport,
  Session,
  SubagentRun,
  Task,
  ToolPolicy,
} from "@agent-ide/core";

// 这些节点描述了 runtime 主循环的骨架。以后 graph 可以变复杂，
// 但新增节点也应该落在这条 goal-driven 的执行链路里。
export type WorkflowNode =
  | "intake"
  | "clarify"
  | "plan"
  | "delegate"
  | "execute"
  | "review"
  | "summarize"
  | "continue-or-close";

// GraphMessage 是 runtime 视角下的消息结构。它和数据库行分开，
// 这样 graph 的状态设计不会被存储表结构反向绑死。
export interface GraphMessage {
  id: Identifier;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

// Checkpoint 是 session 的可恢复落点。后面做重启恢复、回放、fork session，
// 都会以它为基础。
export interface GraphCheckpoint {
  id: Identifier;
  sessionId: Identifier;
  node: WorkflowNode;
  createdAt: string;
  summary: string;
}

// 最近的工具调用同样属于 runtime state。
// execute 节点是否已经读过某个文件、是否正在重复同一个工具动作，
// 都要靠这组痕迹来判断。
export interface GraphToolInvocation {
  id: Identifier;
  sessionId: Identifier;
  taskId?: Identifier;
  subagentRunId?: Identifier;
  toolName: string;
  status: "started" | "completed" | "failed";
  inputJson: string;
  outputJson?: string;
  createdAt: string;
  updatedAt: string;
}

// AgentGraphState 是运行中的状态快照，后面会自然映射到 LangGraph state。
// 只要某个东西会影响执行，就应该在这里能看到，而不是藏在零散局部变量里。
export interface AgentGraphState {
  workspaceId: Identifier;
  session: Session;
  activeGoal: Goal;
  currentPlan?: Plan;
  tasks: Task[];
  messages: GraphMessage[];
  toolInvocations: GraphToolInvocation[];
  memory: MemoryRecord[];
  activeAgent: AgentMode;
  activePolicy: ToolPolicy;
  subagentRuns: SubagentRun[];
  pendingReview?: ReviewReport;
  checkpoints: GraphCheckpoint[];
}

// 这是当前最简洁的 runtime 解释方式：
// 先理解请求，再制定计划，接着执行、复盘，最后总结。
export const CORE_WORKFLOW: WorkflowNode[] = [
  "intake",
  "clarify",
  "plan",
  "delegate",
  "execute",
  "review",
  "summarize",
  "continue-or-close",
];

// 允许的状态跳转用来约束流程，避免 runtime 从 intake 直接跳到“完成”，
// 中间完全没有 plan 或 review。
//
// 这里还要分清“设计合同”和“真实运行时”：
// - 这里的 ALLOWED_TRANSITIONS 是 workflow contract，定义理论上允许怎么跳
// - packages/runtime/src/langgraph.ts 里的 .addEdge(...) 才是当前这版 LangGraph 真正会怎么跑
//
// 所以它现在已经很适合做：
// - 阅读时理解状态机
// - 后续接条件路由
// - 测试里校验某次跳转是否合法
//
// 但还不能说“当前运行时已经完全由这张表动态驱动”。
const ALLOWED_TRANSITIONS: Record<WorkflowNode, WorkflowNode[]> = {
  intake: ["clarify", "plan"],
  clarify: ["plan", "continue-or-close"],
  plan: ["delegate", "execute", "continue-or-close"],
  delegate: ["execute", "review"],
  execute: ["delegate", "review", "summarize"],
  review: ["plan", "execute", "summarize", "continue-or-close"],
  summarize: ["continue-or-close"],
  "continue-or-close": ["clarify", "plan"],
};

export function canTransitionTo(from: WorkflowNode, to: WorkflowNode): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// graph 至少要拿到 session、goal 和 activePolicy，才算进入可执行状态。
// 这个函数的作用，就是把“半成品状态”收窄成“可以运行的状态”。
export function requiresGoal(state: Partial<AgentGraphState>): state is AgentGraphState {
  return Boolean(state.session && state.activeGoal && state.activePolicy);
}
