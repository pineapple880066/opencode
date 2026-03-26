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

/**
 * LangGraph 工作流节点类型定义。
 * 
 * 这些节点描述了 runtime 主循环的骨架。以后 graph 可以变复杂，
 * 但新增节点也应该落在这条 goal-driven 的执行链路里。
 * 
 * 节点含义：
 * - intake: 吸收用户初始请求，建立基本语境
 * - clarify: 澄清用户意图，补充必要信息（如成功标准）
 * - plan: 根据 goal 生成执行计划（plan + steps）
 * - delegate: 决定是否需要委托给 subagent，创建 child session
 * - execute: 执行工具调用、文件读写等实际任务
 * - review: 评估当前执行是否满足 goal 的成功标准
 * - summarize: 生成会话摘要、总结主要发现
 * - continue-or-close: 决定继续迭代还是关闭会话
 */
export type WorkflowNode =
  | "intake"
  | "clarify"
  | "plan"
  | "delegate"
  | "execute"
  | "review"
  | "summarize"
  | "continue-or-close";

/**
 * LangGraph 执行流中的消息结构。
 * 
 * 这是 runtime 视角下的消息结构，与数据库 message 表分开。
 * 好处：graph 的状态设计不会被存储表结构反向绑死，可以独立演进。
 * 
 * 消息包含所有执行中的交互痕迹：
 * - role: 消息发表者身份（user/assistant/system/tool）
 * - content: 消息内容（可能很长）
 * - 时间戳：用于排序和追溯
 * 
 * 注意：这里的 GraphMessage 作为运行时状态的一部分，
 * 与持久化到数据库的 ToolInvocationLog、Message 是不同层次的抽象。
 */
export interface GraphMessage {
  id: Identifier;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

/**
 * Checkpoint 是 session 执行的可恢复落点。
 * 
 * 每次执行到重要节点（如 execute 完成、review 完成）时，
 * 系统可以记录当前的完整状态快照（graph state）作为 checkpoint。
 * 
 * 用途：
 * - 恢复执行：系统崩溃后，从最近的 checkpoint 恢复而不是重新开始
 * - 回放分析：分析某个阶段发生了什么
 * - Fork 会话：从某个 checkpoint 创建分支会话，尝试不同的执行路径
 * - 手动干预：用户明确地要求保存某个检查点
 * 
 * GraphCheckpoint 与 AgentGraphState 的关系：
 * - Checkpoint 记录了 state 的完整快照
 * - 后续系统可以从 checkpoint 重建 state
 */
export interface GraphCheckpoint {
  id: Identifier;
  sessionId: Identifier;
  node: WorkflowNode;
  createdAt: string;
  summary: string;
}

/**
 * 最近的工具调用记录，是 runtime state 的关键组成部分。
 * 
 * 这个接口记录了执行中、还活跃的工具调用。execute 节点需要：
 * - 判断某个工具是否已经成功执行过（避免重复）
 * - 检测是否陷入了同一个工具的循环调用
 * - 理解当前的执行状态（某个工具正在进行、已完成或失败）
 * 
 * taskId 和 subagentRunId 的双向链接：
 * - taskId: 这个工具调用属于哪个执行 task
 * - subagentRunId: 这个工具调用是否被某个 subagent 负责
 * 这样系统能精确追溯每个工具调用的归属
 * 
 * inputJson/outputJson：
 * - inputJson: 调用时的参数（必须存在）
 * - outputJson: 执行结果（status=failed 时可能为空）
 */
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

/**
 * Agent 执行的完整状态快照。LangGraph 每次节点执行时都会持有这个状态。
 * 
 * 核心设计原则：
 * 只要某个东西会影响执行，就应该在这里能看到，
 * 而不是藏在零散的局部变量或闭包里。
 * 
 * 状态结构分层：
 * - 会话层（session、activeGoal、currentPlan）：谈话的上下文
 * - 执行层（tasks、toolInvocations）：当前在做什么
 * - 证据层（messages、checkpoints）：已经做过什么
 * - 策略层（activeAgent、activePolicy）：怎样做
 * - 知识层（memory）：之前学到什么
 * - 协作层（subagentRuns）：谁在帮助
 * 
 * pendingReview：
 * - 如果当前卡在 review 节点，这里保存待选择的 review 报告
 * - 允许系统或用户在 review 和其他节点间回溯
 */
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

/**
 * 核心工作流节点序列。
 * 
 * 这是当前 goal-driven runtime 的最简洁解释方式：
 * 1. intake: 吸收用户请求
 * 2. clarify: 澄清意图和成功标准
 * 3. plan: 制定执行计划
 * 4. delegate: 检查是否需要委托
 * 5. execute: 执行任务
 * 6. review: 评估完成度
 * 7. summarize: 总结会话
 * 8. continue-or-close: 决定是否继续循环
 * 
 * 这个序列定义了"理想情况"下的执行流。
 * 实际执行时，根据 ALLOWED_TRANSITIONS 和 LangGraph 路由逻辑，
 * 可能会有条件跳转、回溯、重复等复杂路径。
 */
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

/**
 * 允许的工作流状态转移规则。
 * 
 * 用来约束执行流程，避免出现非法跳转（如从 intake 直接跳到 close，
 * 中间完全没有 plan 或 review）。
 * 
 * 重要区分："设计合同" vs "真实运行时"
 * - ALLOWED_TRANSITIONS: 这是 workflow contract，定义理论上允许的状态转移
 * - packages/runtime/src/langgraph.ts 里的 .addEdge(...): 当前 LangGraph 的真实路由
 * 
 * 当前的用途：
 * - 文档：帮助理解状态机的合法转移
 * - 测试：在单元测试中校验某次跳转是否符合工作流规则
 * - 验证：在路由前检查转移的合法性
 * 
 * 未来可能的演进方向：
 * - 动态路由：根据这个表的定义自动生成 LangGraph 的边
 * - 条件路由：每个转移可以关联条件判断
 * 
 * 转移规则说明：
 * - intake → clarify/plan: 初始请求进入澄清或直接规划
 * - clarify → plan/close: 澄清后可规划或关闭
 * - plan → delegate/execute/close: 可以委托、执行或关闭
 * - execute → delegate/review/summarize: 执行后可更多委托、复盘或总结
 * - review → plan/execute/summarize/close: 复盘结果决定下一步
 */
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

/**
 * 验证从一个节点到另一个节点的转移是否合法。
 * 
 * 使用 ALLOWED_TRANSITIONS 表来检查：当前节点是否允许跳转到目标节点。
 * 
 * 常见用途：
 * - LangGraph 的路由函数中调用，判断边是否有效
 * - 测试中验证某个场景的转移合法性
 * - 调试时追踪是否出现了非法转移
 * 
 * @param from 当前节点
 * @param to 目标节点
 * @returns true 表示转移合法，false 表示非法
 */
export function canTransitionTo(from: WorkflowNode, to: WorkflowNode): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 类型守卫：检查 state 是否已经准备好可以执行。
 * 
 * 核心检查项：
 * - session: 必须存在（确定对话上下文）
 * - activeGoal: 必须存在（goal-driven 的根本）
 * - activePolicy: 必须存在（确定工具权限策略）
 * 
 * 设计思想：
 * 很多节点（如 execute）需要完整的 state，而某些节点（如 intake）
 * 可能 state 还不完整。这个函数通过类型守卫把"半成品状态"
 * 收窄成"可以运行的完整状态"。
 * 
 * 使用示例：
 * ```
 * if (requiresGoal(state)) {
 *   // 现在 TypeScript 知道 state 已经是完整的 AgentGraphState
 *   executeNode(state);
 * }
 * ```
 * 
 * @param state 待检查的状态（可能不完整）
 * @returns 如果返回 true，TypeScript 会类型缩小为完整的 AgentGraphState
 */
export function requiresGoal(state: Partial<AgentGraphState>): state is AgentGraphState {
  return Boolean(state.session && state.activeGoal && state.activePolicy);
}
