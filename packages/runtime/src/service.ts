import { randomUUID } from "node:crypto";

import {
  DEFAULT_TOOL_POLICIES,
  type AgentMode,
  type Goal,
  type MemoryRecord,
  type Plan,
  type PlanStep,
  type ReviewReport,
  type Session,
  type SessionSummary,
  type SubagentRun,
  type Task,
  type Workspace,
} from "@agent-ide/core";

import type { AgentGraphState, GraphMessage, GraphToolInvocation, WorkflowNode } from "./graph.js";
import type { PersistedCheckpoint, RuntimeStore, ToolInvocationLog } from "./store.js";

// ============================================================================
// 核心业务服务的选项和接口定义
// ============================================================================

/**
 * GoalDrivenRuntimeService 的运行时选项。
 * 
 * 这些选项让调用者可以注入自己的时间和 ID 生成逻辑，便于：
 * - 测试（可以控制时间和 ID 的生成）
 * - 多个服务实例的时钟同步
 * - 自定义 ID 生成策略（如使用不同的前缀或格式）
 */
export interface RuntimeServiceOptions {
  now: () => string;      // 返回当前时间的 ISO 8601 字符串
  createId: (prefix: string) => string;  // 根据前缀生成唯一 ID
}

/**
 * 确保工作区存在的输入。
 * 如果工作区不存在则创建它，如果已存在则直接返回。
 */
export interface EnsureWorkspaceInput {
  path: string;        // 工作区的文件系统路径
  label?: string;      // 工作区的逻辑名称，如果不提供则从路径推导
}

/**
 * 创建新会话的输入。
 * 
 * 会话（Session）是用户与 Agent 之间的一个独立对话单元。
 * 同一个工作区可以有多个并行的 session，互相不干扰。
 */
export interface CreateSessionInput {
  workspacePath: string;      // 会话所属的工作区路径
  workspaceLabel?: string;    // 工作区标签，用于创建或更新工作区
  title: string;              // 会话的标题，方便用户识别
  agentMode?: AgentMode;      // Agent 的执行模式（如 build, review 等），默认 build
  parentSessionId?: string;   // 如果是子会话，指向父会话 ID
}

/**
 * 重命名会话的输入。
 */
export interface RenameSessionInput {
  sessionId: string;  // 目标会话 ID
  title: string;      // 新的会话标题
}

/**
 * 归档会话的输入。
 * 归档不是删除，而是将会话标记为已完成，从活跃列表中隐藏。
 * 归档的会话的数据仍然保留在数据库中，可以随时查询或恢复。
 */
export interface ArchiveSessionInput {
  sessionId: string;  // 要归档的会话 ID
}

/**
 * 创建子会话（Subagent Delegation）的输入。
 * 
 * 子会话是当主 Agent 需要委托特定任务给某个专用 Agent 时创建的独立会话。
 * 例如：主 Agent 需要 review 代码时，会创建一个子会话给 reviewer Agent。
 * 
 * 关键设计：子会话是完全独立的执行单元（有自己的 goal/plan/tasks）
 * 而不是仅仅改个角色继续在同一个上下文里执行。
 */
export interface CreateChildSessionInput {
  parentSessionId: string;    // 父会话 ID
  title?: string;             // 子会话标题，默认根据 agentMode 生成
  agentMode: AgentMode;       // 子 Agent 的模式
  initialSummary?: string;    // 子会话的初始摘要，描述委托的背景
  inheritActiveGoal?: boolean; // 是否继承父会话的当前 goal，默认 true
  delegationReason?: string;  // 委托的原因
}

/**
 * 创建目标（Goal）的输入。
 * 
 * Goal 是 Goal-Driven Runtime 的核心概念，代表用户想要 Agent 达成的目标。
 * 一个 Goal 包含：
 * - 目标标题
 * - 详细描述
 * - 成功标准（一个或多个判定条件）
 * 
 * Goal 在系统中的重要性：
 * - 所有 Plan、Task 都依附于某个 Goal
 * - Review 时要判断 Goal 是否满足
 * - Goal 状态（active/completed/blocked）影响 session 的执行流
 */
export interface CreateGoalInput {
  sessionId: string;          // 目标所属的会话 ID
  title: string;              // 目标标题
  description: string;        // 详细的目标描述，告诉 Agent 需要做什么
  successCriteria: string[];  // 成功标准列表，用来评判 Goal 是否完成
}

/**
 * 保存计划（Plan）的输入。
 * 
 * Plan 是 Agent 对"如何完成 Goal"的一个完整规划。
 * 它包含一系列 PlanStep，每个 step 是一个具体的行动项。
 * 
 * Plan 的生命周期：
 * 1. draft: AI 生成了计划草案，还未执行
 * 2. approved: 计划已被用户或系统确认
 * 3. in_progress: 开始执行 plan 中的步骤
 * 4. completed: 所有步骤都完成
 * 5. blocked: 某个步骤遇到阻碍
 */
export interface SavePlanInput {
  sessionId: string;  // Plan 所属的会话
  goalId?: string;    // Plan 关联的 Goal，不提供则使用 session 的 activeGoalId
  summary: string;    // Plan 的摘要说明
  status?: Plan["status"];  // 计划状态
  steps: Array<{
    id?: string;              // 步骤 ID，不提供则自动生成
    title: string;            // 步骤标题
    description: string;      // 步骤的详细说明
    status?: PlanStep["status"];  // 步骤状态
    evidence?: string;        // 完成证据（可选）
  }>;
}

/**
 * 同步任务（Task）的输入。
 * 
 * Task 是执行过程中产生的"工作账本"，记录每一步实际执行的工作。
 * 与 Plan 的区别：
 * - Plan 是"打算做什么"（规划阶段的输出）
 * - Task 是"正在做什么 / 做过什么"（执行阶段的记录）
 * 
 * Task 还有一个关键属性 ownerAgent，记录这个任务由哪个 Agent 负责执行：
 * - 主 Agent 执行的任务 ownerAgent = main agent mode
 * - Subagent 执行的任务 ownerAgent = subagent mode
 * 这样在回放或审计时能清晰看到谁做了什么。
 */
export interface SyncTasksInput {
  sessionId: string;  // 任务所属的会话
  goalId?: string;    // 任务关联的 Goal
  planId?: string;    // 任务来自哪个 Plan（可选）
  tasks: Array<{
    id?: string;              // 任务 ID
    ownerAgent?: AgentMode;   // 执行这个任务的 Agent 模式
    title: string;            // 任务标题
    status?: Task["status"];  // 任务状态
    inputSummary: string;     // 任务的输入摘要
    outputSummary?: string;   // 任务的输出摘要
  }>;
}

/**
 * 记录记忆（Memory）的输入。
 * 
 * Memory 是 Agent 在执行中发现和积累的"可复用的稳定事实"。
 * 与 Message 的区别：
 * - Message 记录交互过程（谁说了什么、执行了什么）
 * - Memory 记录提取出来的知识（这是什么、怎样才能成功等）
 * 
 * Memory 有两个重要的 scope：
 * - "workspace": 跨所有 session 可用的知识（如代码库结构、部署配置等）
 * - "session": 仅在当前 session 内有效的临时笔记
 */
export interface RecordMemoryInput {
  workspaceId?: string;    // 所属工作区，如果提供了 sessionId 则自动推导
  sessionId?: string;      // 所属会话（可选，用于 session-scoped memory）
  scope: MemoryRecord["scope"];  // memory 的作用范围（workspace 或 session）
  key: string;             // 知识的 key（如 "codebase_structure"）
  value: string;           // 知识内容
  source: MemoryRecord["source"];  // 知识来源（如 "model", "user", "tool"）
  confidence?: number;     // 置信度（0-1），默认 0.8
}

/**
 * Review Goal 的输入。
 * 
 * Review 是 goal-driven runtime 的一个关键检查点。
 * 当 Agent 认为它已完成了目标（或无法继续）时，会调用 review，
 * 向系统（或用户）传达：这个 Goal 是否满足了。
 */
export interface ReviewGoalInput {
  sessionId: string;          // 要 review 的会话
  satisfied: boolean;         // Goal 是否满足
  reasons: string[];          // 满足或不满足的原因
  remainingRisks?: string[];  // 如果不满足，剩余的风险或阻碍
  recommendedNextStep?: string;  // 建议的下一步行动
}

/**
 * 更新会话摘要的输入。
 * 
 * Session 摘要是对当前会话状态的一个高层总结。
 * 系统常常需要在不加载完整对话历史的情况下了解会话的进展，
 * 这时就依赖 summary 里的这些信息。
 */
export interface UpdateSessionSummaryInput {
  sessionId: string;          // 要更新的会话
  shortSummary: string;       // 一句话摘要，描述这个会话在做什么
  openLoops?: string[];       // 未解决的问题或需要后续处理的事项
  nextActions?: string[];     // 下一步应该做的事
  importantFacts?: string[];  // 对这个会话很重要的事实或发现
}

/**
 * 追加消息的输入。
 * 
 * Message 是整个系统的"交互日志"。所有关键事件都会被记录成消息：
 * - AI 的回复
 * - 工具的执行结果
 * - 系统的通知
 * - Delegation 的开始和结束
 */
export interface AppendMessageInput {
  sessionId: string;          // 消息所属的会话
  role: GraphMessage["role"];  // 消息角色（user/assistant/system/tool）
  content: string;            // 消息内容
}

/**
 * 创建 Checkpoint 的输入。
 * 
 * Checkpoint 是 LangGraph 执行流中的"存档点"。
 * 如果 Agent 执行中断或出错，可以从最近的 checkpoint 恢复，
 * 避免从头再来。MySQL LangGraph checkpointer 负责把这些状态快照持久化。
 */
export interface CreateCheckpointInput {
  sessionId: string;  // checkpoint 所属的会话
  node: WorkflowNode;  // 执行到了 graph 的哪个节点
  stateJson: string;  // 当前执行状态的 JSON 快照
  summary: string;    // 这次 checkpoint 的摘要说明
}

/**
 * 启动 Subagent Run 的输入。
 * 
 * SubagentRun 记录了一次来自父 session 对子 session 的委托执行。
 * 可以有多个 run 关联同一个 child session（比如重试）。
 */
export interface StartSubagentRunInput {
  parentSessionId: string;  // 父会话 ID
  childSessionId: string;   // 子会话 ID
  parentTaskId?: string;    // 父会话里哪个任务触发了这次委托
  agentMode: AgentMode;     // 子 Agent 的模式
  reason: string;           // 为什么要委托
  inputSummary: string;     // 委托的输入摘要（传给子代理什么信息）
}

/**
 * 完成 Subagent Run 的输入。
 * 
 * 当子 Agent 完成执行后，调用这个方法来记录结果，并触发一系列后续操作：
 * - 更新 child session 的摘要
 * - 更新 parent task 的状态
 * - 向 parent session 追加结果消息
 * - 可选：归档 child session
 * - 可选：根据策略清理其他已完成的 child sessions
 */
export interface CompleteSubagentRunInput {
  id: string;                    // 要完成的 SubagentRun ID
  status?: SubagentRun["status"]; // 最终状态（completed/failed/canceled）
  resultSummary?: string;        // 执行结果的摘要
  appendParentMessage?: boolean; // 是否向父会话追加完成消息，默认 true
  archiveChildSession?: boolean; // 是否同时归档 child session
  updateChildSummary?: boolean;  // 是否更新 child session 的摘要，默认 true
  cleanupPolicy?: SubagentCleanupPolicy | false;  // 清理策略，false 表示不清理
}

/**
 * 委托给 Subagent 的输入。
 * 
 * 这是 parent -> child delegation 的主要入口。
 * 它把上面的多个步骤（createChildSession + startSubagentRun）合成一个便利方法。
 */
export interface DelegateToSubagentInput {
  parentSessionId: string;    // 父会话 ID
  parentTaskId?: string;      // 哪个父任务触发了这次委托
  agentMode: AgentMode;       // 委托给哪个 Agent 模式
  title?: string;             // 子会话的标题
  reason: string;             // 为什么要委托
  inputSummary: string;       // 输入摘要
  inheritActiveGoal?: boolean; // 是否继承父会话的 goal，默认 true
}

export interface DelegateToSubagentResult {
  childSession: Session;
  childGoal?: Goal;
  run: SubagentRun;
}

export interface SubagentRunReplay {
  run: SubagentRun;
  parentSession: Session;
  childSession: Session;
  parentTask?: Task;
  childGoal?: Goal;
  childTasks: Task[];
  childMessages: GraphMessage[];
  childCheckpoints: PersistedCheckpoint[];
  childToolInvocations: ToolInvocationLog[];
}

export interface CleanupChildSessionsInput {
  parentSessionId: string;
  archiveStatuses?: Array<Extract<SubagentRun["status"], "completed" | "failed" | "canceled">>;
  includeAlreadyArchived?: boolean;
  policy?: SubagentCleanupPolicy;
}

export interface CleanupChildSessionsResult {
  parentSessionId: string;
  archivedChildSessionIds: string[];
  skipped: Array<{
    childSessionId: string;
    latestRunId?: string;
    latestRunStatus?: SubagentRun["status"];
    reason: string;
  }>;
}

/**
 * Subagent 清理策略。
 * 
 * 用来自动沿归档已完成的 child sessions，避免堆积成垃圾。
 * 支持多种清理条件的组合，灵活控制保留哪些 child session。
 */
export interface SubagentCleanupPolicy {
  // 哪些状态的 run 可以被清理（只有已结束的 run 才能清理）
  archiveStatuses?: Array<Extract<SubagentRun["status"], "completed" | "failed" | "canceled">>;

  // 最多保留多久的 run 不清理（毫秒）
  maxAgeMs?: number;

  // 最多保留最近 N 个已完成的 child sessions（其余的会被清理）
  retainMostRecentFinishedChildren?: number;

  // 清理前必须有结果摘要
  requireResultSummary?: boolean;
}

export interface CompleteSubagentRunResult {
  run: SubagentRun;
  childSession: Session;
  cleanup?: CleanupChildSessionsResult;
}

export interface ParentTaskExecutionTrace {
  parentTask: Task;
  parentSession: Session;
  directToolInvocations: ToolInvocationLog[];
  delegatedReplays: SubagentRunReplay[];
}

/**
 * 创建一个空的默认会话摘要。
 * 用于新建会话时的初始化。
 */
function createDefaultSessionSummary(): SessionSummary {
  return {
    shortSummary: "",
    openLoops: [],
    nextActions: [],
    importantFacts: [],
  };
}

/**
 * 创建一个带基础摘要的会话摘要。
 * 用于 child session 初始化，包含委托背景信息。
 */
function createSessionSummaryWithBase(shortSummary = ""): SessionSummary {
  return {
    shortSummary,
    openLoops: [],
    nextActions: [],
    importantFacts: [],
  };
}

/**
 * 创建默认的运行时选项。
 * 
 * 默认实现：
 * - 使用系统当前时间
 * - 用 UUID 生成 ID（格式：prefix_uuid）
 * 
 * 调用者可以传递自己的选项来覆盖这些默认值。
 */
function createDefaultRuntimeOptions(): RuntimeServiceOptions {
  return {
    now: () => new Date().toISOString(),
    createId: (prefix: string) => `${prefix}_${randomUUID()}`,
  };
}

/**
 * 将 SubagentRun 的状态映射到 Task 的状态。
 * 
 * 这个映射定义了在父 task 视角下，子代理的执行结果如何反映：
 * - completed -> done: 任务完成
 * - failed -> blocked: 任务失败，父流程被阻碍
 * - canceled -> canceled: 任务被取消
 * - 其他 -> in_progress: 任务仍在进行
 */
function mapRunStatusToTaskStatus(status: SubagentRun["status"]): Task["status"] {
  if (status === "completed") {
    return "done";
  }

  if (status === "failed") {
    return "blocked";
  }

  if (status === "canceled") {
    return "canceled";
  }

  return "in_progress";
}

/**
 * 将 SubagentRun 的状态映射到 Goal 的状态。
 * 
 * 这个映射定义了子代理的执行结果如何影响 goal 的完成度：
 * - completed -> completed: Goal 完成
 * - failed -> blocked: Goal 被阻碍
 * - canceled -> abandoned: Goal 被放弃
 * - 其他 -> active: Goal 仍在进行
 */
function mapRunStatusToGoalStatus(status: SubagentRun["status"]): Goal["status"] {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed") {
    return "blocked";
  }

  if (status === "canceled") {
    return "abandoned";
  }

  return "active";
}

/**
 * 从多个 run 中选出最新的一个（按 updatedAt 排序）。
 * 
 * 用于找到 child session 的"最新执行记录"，判断清理策略是否适用。
 */
function pickLatestRun(runs: SubagentRun[]): SubagentRun | undefined {
  return [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

/**
 * 将 ISO 8601 时间字符串转换为时间戳（毫秒）。
 * 
 * 用于计算时间差（如"这个 run 已经多久了"）。
 */
function toTimestamp(value: string): number {
  return new Date(value).getTime();
}

/**
 * 运行时实体未找到错误。
 * 
 * 当尝试加载一个不存在的 session/goal/task/run 时抛出。
 * 这个错误表示数据库状态有问题，或者调用方传的 ID 有误。
 */
export class RuntimeEntityNotFoundError extends Error {
  constructor(entityName: string, entityId: string) {
    super(`未找到 ${entityName}: ${entityId}`);
    this.name = "RuntimeEntityNotFoundError";
  }
}

// ============================================================================
// GoalDrivenRuntimeService — 业务服务层
// ============================================================================

/**
 * 面试点：这里故意没有把业务逻辑直接写进数据库层或 UI 层，
 * 而是先形成一个 goal-driven 的应用服务层。这样后面接 LangGraph 时，
 * graph 负责编排，这里负责稳定业务动作。
 *
 * GoalDrivenRuntimeService 是当前 runtime 的应用服务层。
 * 它还不是最终的 LangGraph 执行器，但已经把核心业务动作组织起来了。
 *
 * 主要职责：
 * 1. 执行所有持久化操作（创建/更新各类实体）
 * 2. 管理策略性的会话流程（goal-driven 是一个标志类流程）
 * 3. 提供 subagent 委托的马上整合
 * 4. 提供 LangGraph 需要的状态快照（buildGraphState）
 */
export class GoalDrivenRuntimeService {
  private readonly options: RuntimeServiceOptions;

  /**
   * 创建一个新的 Goal-Driven Runtime 服务。
   *
   * @param store 数据库访问层，手参是所有显式的提供者注入
   * @param options 运行时设置，常见需要自定义（尤其是控制时钟或 ID 生成）
   */
  constructor(
    private readonly store: RuntimeStore,
    options?: Partial<RuntimeServiceOptions>,
  ) {
    this.options = {
      ...createDefaultRuntimeOptions(),
      ...options,
    };
  }

  /**
   * 确保工作区存在，如果不存在则创建。
   * 
   * 这是一个幂等（idempotent）操作：
   * - 如果工作区已存在，直接返回现有的工作区对象
   * - 如果不存在，则创建新的工作区并返回
   * 
   * 设计思想：
   * - 工作区是会话的容器。任何 session 都必须属于某个 workspace
   * - 通过 ensureWorkspace，确保后续创建的 session 一定有有效的工作区
   * - 这样整个系统的数据完整性更强：session -> workspace -> path
   * 
   * Label 生成规则：
   * - 如果提供了 label，使用提供的值
   * - 如果没有，从路径的最后一个目录名推导（如 "/home/user/project" -> "project"）
   * - 路径为 "/" 时，默认 label 为 "workspace"
   * 
   * 常见用途：
   * - 创建 session 前，先确保其所属的 workspace 存在
   * - IDE 打开一个新项目时，自动为该项目创建/关联一个 workspace
   * - 脚本或 API 调用时，指定工作区路径
   * 
   * @param input 包含工作区路径和可选的 label
   * @returns 工作区对象，包含 ID、路径、标签和时间戳
   */
  async ensureWorkspace(input: EnsureWorkspaceInput): Promise<Workspace> {
    const existing = await this.store.workspaces.getByPath(input.path);
    if (existing) {
      return existing;
    }

    const now = this.options.now();
    const workspace: Workspace = {
      id: this.options.createId("workspace"),
      path: input.path,
      label: input.label ?? input.path.split("/").filter(Boolean).at(-1) ?? "workspace",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.workspaces.upsert(workspace);
    return workspace;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    // createSession 是所有“对话入口”的起点。
    // 不管是 UI 新建 session、smoke 脚本直接建 session，还是后续派生 child session，
    // 最终都要落成一个持久化的 Session 实体。
    //
    // 这里先 ensureWorkspace，再 createSessionRecord，目的是把“工作区存在”这个前提收成强约束。
    // 后面只要你看到某个 session，就能确定它一定挂在一个已知 workspace 上。
    const workspace = await this.ensureWorkspace({
      path: input.workspacePath,
      label: input.workspaceLabel,
    });
    return this.createSessionRecord({
      workspaceId: workspace.id,
      title: input.title,
      agentMode: input.agentMode ?? "build",
      parentSessionId: input.parentSessionId,
      summary: createDefaultSessionSummary(),
    });
  }

  /**
   * 获取指定 ID 的会话。
   * 
   * 这是一个简单的查询方法，加载单个会话的完整信息。
   * 如果会话不存在，会抛出 RuntimeEntityNotFoundError。
   * 
   * @param sessionId 会话 ID
   * @returns 会话对象，包含所有的元信息和摘要
   * @throws RuntimeEntityNotFoundError 如果会话不存在
   */
  async getSession(sessionId: string): Promise<Session> {
    return this.requireSession(sessionId);
  }

  /**
   * 重命名指定的会话。
   * 
   * 这是一个简单的元数据更新操作。
   * 会话标题用于在 UI 上展示，方便用户识别这场对话讲的是什么。
   * 
   * @param input 包含会话 ID 和新标题
   * @returns 更新后的会话对象
   * @throws RuntimeEntityNotFoundError 如果会话不存在
   */
  async renameSession(input: RenameSessionInput): Promise<Session> {
    await this.requireSession(input.sessionId);
    const now = this.options.now();
    await this.store.sessions.rename(input.sessionId, input.title, now);
    return this.requireSession(input.sessionId);
  }

  /**
   * 归档（逻辑删除）指定的会话。
   * 
   * 归档不是物理删除，而是把会话标记为已完成，从活跃列表中隐藏。
   * 归档的会话数据仍然保留在数据库中，任何时候都可以查询、恢复或审计。
   * 
   * 常见用途：
   * - 用户完成对话后归档，保持活跃列表干净
   * - 系统自动清理 child sessions，避免上下文垃圾堆积
   * - 长期保留已完成任务的记录，便于后续审计或学习
   * 
   * @param input 包含要归档的会话 ID
   * @returns 更新后的（已归档的）会话对象
   * @throws RuntimeEntityNotFoundError 如果会话不存在
   */
  async archiveSession(input: ArchiveSessionInput): Promise<Session> {
    await this.requireSession(input.sessionId);
    const now = this.options.now();
    await this.store.sessions.archive(input.sessionId, now);
    return this.requireSession(input.sessionId);
  }

  // 面试点：subagent 不是共享父上下文继续跑，而是创建 child session。
  // 这样上下文边界、lineage 和后续审计都会更清楚。
  async createChildSession(input: CreateChildSessionInput): Promise<{
    childSession: Session;
    childGoal?: Goal;
  }> {
    const parentSession = await this.requireSession(input.parentSessionId);
    const parentGoal = parentSession.activeGoalId
      ? await this.store.goals.getById(parentSession.activeGoalId)
      : null;

    const childSession = await this.createSessionRecord({
      workspaceId: parentSession.workspaceId,
      title: input.title ?? `${input.agentMode} child of ${parentSession.title}`,
      agentMode: input.agentMode,
      parentSessionId: parentSession.id,
      summary: createSessionSummaryWithBase(
        input.initialSummary ??
        `由父 session 委托创建，模式=${input.agentMode}${input.delegationReason ? `，原因=${input.delegationReason}` : ""
        }`,
      ),
    });

    if (!input.inheritActiveGoal || !parentGoal) {
      return { childSession };
    }

    const now = this.options.now();
    const childGoal: Goal = {
      id: this.options.createId("goal"),
      workspaceId: childSession.workspaceId,
      sessionId: childSession.id,
      title: `[${input.agentMode}] ${parentGoal.title}`,
      description: input.delegationReason
        ? `${parentGoal.description}\n\n子代理任务重点：${input.delegationReason}`
        : parentGoal.description,
      successCriteria: parentGoal.successCriteria,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.goals.create(childGoal);
    await this.store.sessions.setActiveGoal(childSession.id, childGoal.id, now);

    return {
      childSession,
      childGoal,
    };
  }

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    // goal 是 goal-driven runtime 的锚点。
    // 这里不是“顺便存一条标题”，而是：
    // - 在 session 下创建独立 Goal 实体
    // - 把 success criteria 一起固化
    // - 同步把 session.activeGoalId 指向新 goal
    //
    // 这样后面 plan / task / review 才有稳定回指，不会退化成聊天历史里的松散意图。
    const session = await this.requireSession(input.sessionId);
    const now = this.options.now();

    const goal: Goal = {
      id: this.options.createId("goal"),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      title: input.title,
      description: input.description,
      successCriteria: input.successCriteria,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.goals.create(goal);
    await this.store.sessions.setActiveGoal(session.id, goal.id, now);
    return goal;
  }

  async savePlan(input: SavePlanInput): Promise<Plan> {
    // savePlan 的职责是把“模型/规划器输出的一次计划草案”沉淀成持久化 Plan。
    // 这里有两个关键点：
    // 1. plan 一定依附 active goal，避免出现“有计划但不知道是为谁服务”
    // 2. step.id 在这里就被稳定下来，后面 executor 更新任务或 UI 显示步骤时才有可追踪标识
    const session = await this.requireSession(input.sessionId);
    const goalId = input.goalId ?? session.activeGoalId;

    if (!goalId) {
      throw new Error(`session ${session.id} 当前没有 active goal，无法保存 plan`);
    }

    const goal = await this.requireGoal(goalId);
    const now = this.options.now();
    const plan: Plan = {
      id: this.options.createId("plan"),
      goalId: goal.id,
      sessionId: session.id,
      status: input.status ?? "draft",
      summary: input.summary,
      steps: input.steps.map((step) => ({
        id: step.id ?? this.options.createId("plan_step"),
        title: step.title,
        description: step.description,
        status: step.status ?? "todo",
        evidence: step.evidence,
      })),
      createdAt: now,
      updatedAt: now,
    };

    await this.store.plans.save(plan);
    return plan;
  }

  async syncTasks(input: SyncTasksInput): Promise<Task[]> {
    // syncTasks 负责把 execute 阶段产生的任务账本落库。
    // 它和 savePlan 的区别是：
    // - plan 更像“意图和步骤”
    // - task 更像“执行中的进度账本”
    //
    // 一个很关键的设计点是：task 会显式记录 ownerAgent。
    // 这样同一个 session 里主 agent 和 subagent 的工作边界才可追溯。
    const session = await this.requireSession(input.sessionId);
    const goalId = input.goalId ?? session.activeGoalId;

    if (!goalId) {
      throw new Error(`session ${session.id} 当前没有 active goal，无法写入 task`);
    }

    const now = this.options.now();
    const tasks = input.tasks.map<Task>((task) => ({
      id: task.id ?? this.options.createId("task"),
      goalId,
      planId: input.planId,
      sessionId: session.id,
      ownerAgent: task.ownerAgent ?? session.activeAgentMode,
      title: task.title,
      status: task.status ?? "todo",
      inputSummary: task.inputSummary,
      outputSummary: task.outputSummary,
      createdAt: now,
      updatedAt: now,
    }));

    await this.store.tasks.upsertMany(tasks);
    return tasks;
  }

  async recordMemory(input: RecordMemoryInput): Promise<MemoryRecord> {
    // memory 单独建表，而不是混在 message 里。
    // 这里的取舍是：message 用来记录交互过程，memory 用来记录“可复用的稳定事实”。
    // 读这个函数时，可以特别注意 workspaceId/sessionId 的推导关系：
    // - session memory 依附当前 session
    // - workspace memory 可以跨 session 复用
    const session = input.sessionId ? await this.requireSession(input.sessionId) : null;
    const workspaceId = input.workspaceId ?? session?.workspaceId;

    if (!workspaceId) {
      throw new Error("recordMemory 需要 workspaceId 或 sessionId");
    }

    const now = this.options.now();
    const record: MemoryRecord = {
      id: this.options.createId("memory"),
      workspaceId,
      sessionId: input.sessionId,
      scope: input.scope,
      key: input.key,
      value: input.value,
      source: input.source,
      confidence: input.confidence ?? 0.8,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.memory.create(record);
    return record;
  }

  /**
   * 更新会话的摘要信息。
   * 
   * Session 摘要是对当前会话状态的一个高层总结。
   * 系统常常需要在不加载完整对话历史的情况下了解会话的进展，
   * 这时就依赖 summary 里的这些信息。
   * 
   * SessionSummary 包含四个部分：
   * - shortSummary: 一句话描述这个会话在做什么
   * - openLoops: 未解决的问题或需要后续处理的事项
   * - nextActions: 下一步应该做的事
   * - importantFacts: 对这个会话很重要的事实或发现
   * 
   * 常见用途：
   * - IDE 的会话列表只显示 shortSummary
   * - 恢复执行时，用摘要快速了解上下文，而不用读完整历史
   * - Session summary 本身作为 prompt 的一部分注入到模型
   * - UI 展示最近的 openLoops 和 nextActions
   * 
   * 设计特点：
   * - 支持部分更新（只提供 shortSummary，其他字段保持）
   * - 允许清空某些字段（如执行完成后清空 nextActions）
   * 
   * @param input 包含会话 ID 和要更新的摘要字段
   * @returns 更新后的 SessionSummary 对象
   */
  async updateSessionSummary(input: UpdateSessionSummaryInput): Promise<SessionSummary> {
    const session = await this.requireSession(input.sessionId);
    const now = this.options.now();
    const summary: SessionSummary = {
      shortSummary: input.shortSummary,
      openLoops: input.openLoops ?? session.summary.openLoops,
      nextActions: input.nextActions ?? session.summary.nextActions,
      importantFacts: input.importantFacts ?? session.summary.importantFacts,
    };

    await this.store.sessions.updateSummary(session.id, summary, now);
    return summary;
  }

  async appendMessage(input: AppendMessageInput): Promise<GraphMessage> {
    // message 虽然看起来简单，但它其实是很多上层能力的公共证据源。
    // buildGraphState、activity log、browser workbench、trace 回放，都会用到这里留下的消息。
    await this.requireSession(input.sessionId);
    const message: GraphMessage = {
      id: this.options.createId("message"),
      role: input.role,
      content: input.content,
      createdAt: this.options.now(),
    };

    await this.store.messages.append(input.sessionId, message);
    return message;
  }

  /**
   * 为当前执行创建一个 checkpoint（执行状态快照）。
   * 
   * Checkpoint 是 LangGraph 执行流中的"存档点"。
   * 如果 Agent 执行中断或出错，系统可以从最近的 checkpoint 恢复，
   * 避免从头重新执行，节省时间和成本。
   * 
   * Checkpoint 包含的信息：
   * - node: 当前执行到了 graph 的哪个节点
   * - stateJson: 完整的执行状态 JSON 快照
   * - summary: 人类可读的总结（便于 UI 展示）
   * 
   * 常见场景：
   * - LangGraph 每次状态变化、节点完成时创建 checkpoint
   * - IDE 用户点击"Pause"或"Save checkpoint"时创建手动 checkpoint
   * - 长时间运行的任务，定期创建 checkpoints 便于恢复
   * 
   * 设计考虑：
   * - stateJson 应该包含恢复所需的所有信息
   * - summary 帮助用户快速了解这个 checkpoint 代表什么时间点
   * - 存储很多 checkpoints 可能消耗空间，需要合理清理策略
   * 
   * @param input 包含会话 ID、当前节点、状态 JSON 和摘要
   * @returns 创建的 checkpoint 对象，包含生成的 ID 和时间戳
   */
  async createCheckpoint(input: CreateCheckpointInput): Promise<PersistedCheckpoint> {
    await this.requireSession(input.sessionId);
    const checkpoint: PersistedCheckpoint = {
      id: this.options.createId("checkpoint"),
      sessionId: input.sessionId,
      node: input.node,
      stateJson: input.stateJson,
      summary: input.summary,
      createdAt: this.options.now(),
    };

    await this.store.checkpoints.create(checkpoint);
    return checkpoint;
  }

  /**
   * 启动（记录）一次 subagent 的执行。
   * 
   * 这个方法在父会话决定委托给子代理时被调用。
   * 它创建一条 SubagentRun 记录，标记这次委托的开始。
   * 
   * SubagentRun 记录了：
   * - 哪个父会话委托的（parentSessionId）
   * - 委托给了哪个子会话（childSessionId）
   * - 是哪个父任务触发的（parentTaskId，可选）
   * - 子代理是什么模式（agentMode）
   * - 为什么要委托（reason）
   * - 委托了什么信息给子代理（inputSummary）
   * - 初始状态为"queued"（等待执行）
   * 
   * 与 delegateToSubagent 的区别：
   * - startSubagentRun: 低层方法，仅记录一条 run
   * - delegateToSubagent: 高层方法，包括创建 child session + startSubagentRun + 附加消息
   * 
   * 常见用途：
   * - delegateToSubagent 内部调用（高层委托流程）
   * - 测试时手动创建 run 记录
   * - 从外部系统同步 run 信息
   * 
   * @param input 包含父会话 ID、子会话 ID、代理模式、委托原因和输入摘要
   * @returns 创建的 SubagentRun 记录，初始状态为 "queued"
   */
  async startSubagentRun(input: StartSubagentRunInput): Promise<SubagentRun> {
    await this.requireSession(input.parentSessionId);
    await this.requireSession(input.childSessionId);
    const now = this.options.now();
    const run: SubagentRun = {
      id: this.options.createId("subagent_run"),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      parentTaskId: input.parentTaskId,
      agentMode: input.agentMode,
      status: "queued",
      reason: input.reason,
      inputSummary: input.inputSummary,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.subagentRuns.create(run);
    return run;
  }

  async delegateToSubagent(input: DelegateToSubagentInput): Promise<DelegateToSubagentResult> {
    // 这是 parent -> child delegation 的主入口。
    // 顺着这里往下读，你能看到 subagent 在这个项目里不是“换个 prompt 角色继续聊”，而是：
    // 1. 真实创建 child session
    // 2. 可选继承 active goal
    // 3. 创建 subagent run 记录
    // 4. 把 delegation 上下文写入 child session
    // 5. 把 parent task 标成 in_progress
    //
    // 也就是说，subagent 在这里是一个独立执行单元，而不是父上下文里的一次假装切换。
    const { childSession, childGoal } = await this.createChildSession({
      parentSessionId: input.parentSessionId,
      title: input.title,
      agentMode: input.agentMode,
      inheritActiveGoal: input.inheritActiveGoal ?? true,
      delegationReason: input.reason,
      initialSummary: `等待父 session 回收 delegation 结果：${input.reason}`,
    });

    const run = await this.startSubagentRun({
      parentSessionId: input.parentSessionId,
      childSessionId: childSession.id,
      parentTaskId: input.parentTaskId,
      agentMode: input.agentMode,
      reason: input.reason,
      inputSummary: input.inputSummary,
    });

    await this.appendMessage({
      sessionId: childSession.id,
      role: "system",
      content: `父 session 委托给 ${input.agentMode} 子代理。原因：${input.reason}\n任务摘要：${input.inputSummary}`,
    });

    if (input.parentTaskId) {
      const parentTask = await this.requireTask(input.parentTaskId);
      if (parentTask.sessionId !== input.parentSessionId) {
        throw new Error(`task ${parentTask.id} 不属于 parent session ${input.parentSessionId}`);
      }

      await this.store.tasks.upsertMany([
        {
          ...parentTask,
          status: "in_progress",
          outputSummary:
            parentTask.outputSummary ??
            `已委托给 ${input.agentMode} 子代理，child session=${childSession.id}，等待结果回流`,
          updatedAt: this.options.now(),
        },
      ]);
    }

    return {
      childSession,
      childGoal,
      run,
    };
  }

  async completeSubagentRun(input: CompleteSubagentRunInput): Promise<CompleteSubagentRunResult> {
    // completeSubagentRun 不是简单地把一条 run 状态改成 completed。
    // 它同时负责：
    // - 更新 child session summary
    // - 更新 child goal 状态
    // - 把结果回写到 parent task
    // - 给 parent session 追加 delegation outcome message
    // - 按策略归档 child session
    //
    // 如果没有这层“结果吸收”，subagent 运行完之后父会话只会知道“它跑过”，
    // 却不知道“它到底产出了什么”。
    const run = await this.requireSubagentRun(input.id);
    const childSession = await this.requireSession(run.childSessionId);
    const now = this.options.now();
    const finalStatus = input.status ?? "completed";

    await this.store.subagentRuns.complete(input.id, finalStatus, input.resultSummary, now);

    if (input.updateChildSummary ?? true) {
      const shortSummary = input.resultSummary
        ? `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}：${input.resultSummary}`
        : `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}`;

      await this.store.sessions.updateSummary(
        childSession.id,
        {
          shortSummary,
          openLoops: childSession.summary.openLoops,
          nextActions: childSession.summary.nextActions,
          importantFacts: childSession.summary.importantFacts,
        },
        now,
      );
    }

    if (childSession.activeGoalId) {
      await this.store.goals.updateStatus(
        childSession.activeGoalId,
        finalStatus === "completed" ? "completed" : finalStatus === "failed" ? "blocked" : "active",
        now,
        finalStatus === "completed" ? now : undefined,
      );
    }

    if (run.parentTaskId) {
      const parentTask = await this.requireTask(run.parentTaskId);
      if (parentTask.sessionId !== run.parentSessionId) {
        throw new Error(`task ${parentTask.id} 不属于 parent session ${run.parentSessionId}`);
      }

      // 面试点：subagent orchestration 不应该只停留在 run 记录。
      // 真正有用的系统，还要把 child 结果回写到 parent task，形成主流程账本。
      await this.store.tasks.upsertMany([
        {
          ...parentTask,
          status: mapRunStatusToTaskStatus(finalStatus),
          outputSummary:
            input.resultSummary ??
            parentTask.outputSummary ??
            `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}`,
          updatedAt: now,
        },
      ]);
    }

    // 面试点：subagent 结束不能只改一条 run 状态，还要把结果吸收到父 session。
    // 这样父会话恢复时能看到 delegation outcome，而不是只能自己再去读 child history。
    if (input.appendParentMessage ?? true) {
      const messageLines = [
        `子代理 ${run.agentMode} 已${finalStatus === "completed" ? "完成" : "结束"}。`,
        `child session: ${run.childSessionId}`,
        `委托原因：${run.reason}`,
      ];

      if (input.resultSummary) {
        messageLines.push(`结果摘要：${input.resultSummary}`);
      }

      await this.appendMessage({
        sessionId: run.parentSessionId,
        role: "system",
        content: messageLines.join("\n"),
      });
    }

    if (input.archiveChildSession) {
      await this.store.sessions.archive(run.childSessionId, now);
    }

    const cleanup =
      input.cleanupPolicy === false || input.archiveChildSession
        ? undefined
        : input.cleanupPolicy
          ? await this.cleanupChildSessions({
            parentSessionId: run.parentSessionId,
            policy: input.cleanupPolicy,
          })
          : undefined;

    return {
      run: await this.requireSubagentRun(run.id),
      childSession: await this.requireSession(run.childSessionId),
      cleanup,
    };
  }

  /**
   * Review 当前会话的目标是否满足，并根据结果更新状态。
   * 
   * Review 是 goal-driven runtime 的一个关键检查点。
   * 当 Agent 认为它已完成了目标（或无法继续）时，会调用 review，
   * 向系统（或用户）传达：这个 Goal 是否满足了。
   * 
   * ReviewGoal 的核心逻辑：
   * - satisfied = true: goal 标记为 completed，同时记录完成时间
   * - satisfied = false 且 remainingRisks 有数据: goal 标记为 blocked（有阻碍）
   * - satisfied = false 但无明显阻碍: goal 标记为 active（继续尝试）
   * 
   * ReviewReport 包含的信息：
   * - satisfied: 目标是否满足的布尔判断
   * - reasons: 为什么满足/不满足的原因列表
   * - remainingRisks: 如果不满足，剩余的风险或阻碍是什么
   * - recommendedNextStep: 建议的下一步行动（可选）
   * 
   * 常见场景：
   * - Agent 执行完计划，评估目标是否达成
   * - 遇到阻碍时，用户或系统决定是否放弃
   * - 多轮迭代中，每轮结束后都要 review 进度
   * - 委托给 subagent 时，subagent return 时也要 review
   * 
   * @param input 包含会话 ID、目标满足状态、原因和下一步建议
   * @returns Review 报告，包含对目标的评估和后续建议
   * @throws Error 如果会话当前没有 active goal
   */
  async reviewGoal(input: ReviewGoalInput): Promise<ReviewReport> {
    const session = await this.requireSession(input.sessionId);
    const goalId = session.activeGoalId;

    if (!goalId) {
      throw new Error(`session ${session.id} 当前没有 active goal，无法执行 review`);
    }

    const goal = await this.requireGoal(goalId);
    const now = this.options.now();
    const report: ReviewReport = {
      goalId: goal.id,
      satisfied: input.satisfied,
      reasons: input.reasons,
      remainingRisks: input.remainingRisks ?? [],
      recommendedNextStep: input.recommendedNextStep,
    };

    await this.store.goals.updateStatus(
      goal.id,
      input.satisfied ? "completed" : report.remainingRisks.length > 0 ? "blocked" : "active",
      now,
      input.satisfied ? now : undefined,
    );

    return report;
  }

  async buildGraphState(sessionId: string): Promise<AgentGraphState | null> {
    // buildGraphState 是 runtime 的状态装配点。
    // LangGraph、MiniMax hooks、IDE shell 都不直接各查各的表，而是尽量从这里拿“当前 session 的执行快照”。
    //
    // 这一步会把：
    // - session / activeGoal / currentPlan
    // - tasks / messages / checkpoints / toolInvocations
    // - session + workspace memory
    // - subagentRuns
    // 一次性拼成 AgentGraphState。
    //
    // 这个函数很适合拿来理解“系统到底认定哪些状态会影响执行”。
    const session = await this.requireSession(sessionId);
    if (!session.activeGoalId) {
      return null;
    }

    const activeGoal = await this.requireGoal(session.activeGoalId);
    const currentPlan = await this.store.plans.getLatestByGoal(activeGoal.id);
    const tasks = await this.store.tasks.listBySession(session.id);
    const [sessionMemory, workspaceMemory] = await Promise.all([
      this.store.memory.listByScope(session.workspaceId, "session", session.id),
      this.store.memory.listByScope(session.workspaceId, "workspace"),
    ]);
    const [messages, checkpoints, subagentRuns, toolInvocations] = await Promise.all([
      this.store.messages.listBySession(session.id),
      this.store.checkpoints.listBySession(session.id),
      this.store.subagentRuns.listByParentSession(session.id),
      this.store.toolInvocations.listBySession(session.id),
    ]);

    return {
      workspaceId: session.workspaceId,
      session,
      activeGoal,
      currentPlan: currentPlan ?? undefined,
      tasks,
      messages,
      toolInvocations: toolInvocations.map<GraphToolInvocation>((log) => ({
        id: log.id,
        sessionId: log.sessionId,
        taskId: log.taskId,
        subagentRunId: log.subagentRunId,
        toolName: log.toolName,
        status: log.status,
        inputJson: log.inputJson,
        outputJson: log.outputJson,
        createdAt: log.createdAt,
        updatedAt: log.updatedAt,
      })),
      memory: [...sessionMemory, ...workspaceMemory],
      activeAgent: session.activeAgentMode,
      activePolicy: DEFAULT_TOOL_POLICIES[session.activeAgentMode],
      subagentRuns,
      checkpoints,
    };
  }

  /**
   * 列出指定工作区路径下的所有会话。
   * 
   * 这个方法是 UI/IDE 发现"某个代码仓库相关的所有对话"的主入口。
   * 比如用户打开一个 VS Code 项目时，可以用这个来找该项目下所有积累的 sessions。
   * 
   * @param workspacePath 工作区的文件系统路径
   * @returns 该工作区下的所有活跃+已归档的 sessions
   */
  async listSessionsByWorkspacePath(workspacePath: string): Promise<Session[]> {
    const workspace = await this.store.workspaces.getByPath(workspacePath);
    if (!workspace) {
      return [];
    }

    return this.store.sessions.listByWorkspace(workspace.id);
  }

  /**
   * 列出某个会话的所有子会话。
   * 
   * 子会话是由当前 session 通过 delegation 创建的。
   * 这个方法帮助 UI 展示"这个会话委托过哪些子代理、各自的执行状态"。
   * 
   * @param parentSessionId 父会话 ID
   * @returns 该会话创建的所有子会话列表（包括已归档的）
   */
  async listChildSessions(parentSessionId: string): Promise<Session[]> {
    await this.requireSession(parentSessionId);
    return this.store.sessions.listByParentSession(parentSessionId);
  }

  /**
   * 列出会话中的所有消息。
   * 
   * 消息是会话交互的"公共证据源"：
   * - AI 的思考和回复
   * - 工具执行的输入/输出
   * - 系统通知（比如 delegation 开始/结束）
   * - 中间状态变化的提醒
   * 
   * IDE 的 chat panel、browser workbench、activity log 都会直接消费这个列表。
   * 
   * @param sessionId 会话 ID
   * @returns 该会话的所有消息，按创建时间排序
   */
  async listMessages(sessionId: string): Promise<GraphMessage[]> {
    await this.requireSession(sessionId);
    return this.store.messages.listBySession(sessionId);
  }

  /**
   * 列出会话的所有 checkpoint 存档。
   * 
   * Checkpoint 是 LangGraph 执行中的状态快照。
   * 如果 Agent 执行被中断或失败，系统可以从最近的 checkpoint 恢复，避免重复执行。
   * 
   * 这个方法主要被 LangGraph 的 checkpointer 和 IDE 的 "resume from checkpoint" 功能使用。
   * 
   * @param sessionId 会话 ID
   * @returns 该会话的所有 checkpoints，按创建时间排序
   */
  async listCheckpoints(sessionId: string): Promise<PersistedCheckpoint[]> {
    await this.requireSession(sessionId);
    return this.store.checkpoints.listBySession(sessionId);
  }

  /**
   * 列出会话中所有的工具调用日志。
   * 
   * ToolInvocationLog 记录了 Agent 每次使用工具的：
   * - 工具名称和调用参数（inputJson）
   * - 执行结果（outputJson）
   * - 执行状态和耗时
   * - 所属的 task 和 subagent run（用于追溯）
   * 
   * 这对于：
   * - 理解 Agent 实际做了什么工作
   * - 调试和优化 Agent 的决策
   * - 审计 Agent 的操作
   * 都很关键。
   * 
   * @param sessionId 会话 ID
   * @returns 该会话的所有工具调用日志
   */
  async listToolInvocations(sessionId: string): Promise<ToolInvocationLog[]> {
    await this.requireSession(sessionId);
    return this.store.toolInvocations.listBySession(sessionId);
  }

  /**
   * 列出某个会话发起的所有 subagent run 记录。
   * 
   * 每一条 run 代表一次委托执行：
   * - 父会话什么时候委托了什么任务给哪个子代理
   * - 子代理是否完成了（completed/failed/canceled）
   * - 子代理的结果摘要
   * 
   * 这个列表让 IDE 能展示"这场对话有多少次协作执行"。
   * 
   * @param parentSessionId 父会话 ID
   * @returns 该会话的所有 subagent run，按更新时间排序
   */
  async listSubagentRuns(parentSessionId: string): Promise<SubagentRun[]> {
    await this.requireSession(parentSessionId);
    return this.store.subagentRuns.listByParentSession(parentSessionId);
  }

  /**
   * 根据会话获取其所属的工作区信息。
   * 
   * 这是一个便利方法，避免调用者需要先知道 workspaceId。
   * 常见用途：获取工作区的 path（用来访问代码库）或 label（用来展示在 UI 上）。
   * 
   * @param sessionId 会话 ID
   * @returns 该会话所属工作区的详细信息
   * @throws RuntimeEntityNotFoundError 如果工作区不存在（通常不应该发生，表示数据不一致）
   */
  async getWorkspaceForSession(sessionId: string): Promise<Workspace> {
    const session = await this.requireSession(sessionId);
    const workspace = await this.store.workspaces.getById(session.workspaceId);
    if (!workspace) {
      throw new RuntimeEntityNotFoundError("workspace", session.workspaceId);
    }

    return workspace;
  }

  // 面试点：subagent 不只是“跑完了就算”。
  // 这里把 child session 里的消息、checkpoint、工具调用、任务一起聚合出来，
  // 让后续的 UI / API 能真正回放一次 delegation 的执行痕迹。
  async getSubagentRunReplay(runId: string): Promise<SubagentRunReplay> {
    const run = await this.requireSubagentRun(runId);
    const [parentSession, childSession] = await Promise.all([
      this.requireSession(run.parentSessionId),
      this.requireSession(run.childSessionId),
    ]);

    const [parentTask, childGoal, childTasks, childMessages, childCheckpoints, childToolInvocations] =
      await Promise.all([
        run.parentTaskId ? this.requireTask(run.parentTaskId) : Promise.resolve(undefined),
        childSession.activeGoalId ? this.requireGoal(childSession.activeGoalId) : Promise.resolve(undefined),
        this.store.tasks.listBySession(childSession.id),
        this.store.messages.listBySession(childSession.id),
        this.store.checkpoints.listBySession(childSession.id),
        this.store.toolInvocations.listBySession(childSession.id),
      ]);

    return {
      run,
      parentSession,
      childSession,
      parentTask,
      childGoal,
      childTasks,
      childMessages,
      childCheckpoints,
      childToolInvocations: childToolInvocations.filter(
        (log) => !log.subagentRunId || log.subagentRunId === run.id,
      ),
    };
  }

  /**
   * 获取某个主任务的完整执行追踪，包括直接工具调用和所有委托的子执行。
   * 
   * 这是"主任务视角"的 trace 聚合器。
   * 如果你想追一个复杂任务为什么没做完，通常不会只看 parent task 本身，
   * 还需要同时看到：
   * - parent 直接调用了哪些工具（directToolInvocations）
   * - 委托了哪些 child run（delegatedReplays）
   * - 每个 child run 里面又做了什么（完整的执行细节）
   * 
   * ParentTaskExecutionTrace 的结构：
   * - parentTask: 任务本身的元信息
   * - parentSession: 任务所属的会话
   * - directToolInvocations: 这个任务直接调用的工具列表
   * - delegatedReplays: 这个任务委托的所有子执行，每个都包含完整的执行细节
   * 
   * 常见用途：
   * - IDE 的 trace viewer 展示"这一步做了什么"
   * - 调试 agent 的工作为什么没完成
   * - 审计 agent 的决策和执行过程
   * 
   * @param parentTaskId 父任务的 ID
   * @returns 完整的执行追踪，包含直接工具调用和所有的委托执行细节
   */
  async getParentTaskExecutionTrace(parentTaskId: string): Promise<ParentTaskExecutionTrace> {
    // 这里是“主任务视角”的 trace 聚合器。
    // 如果你想追一个复杂任务为什么没做完，通常不会只看 parent task 本身，
    // 还需要同时看到：
    // - parent 直接调用了哪些工具
    // - 委托了哪些 child run
    // - 每个 child run 里面又做了什么
    //
    // 这个方法把这些证据汇成一条链，方便 UI 和排错工具直接消费。
    const parentTask = await this.requireTask(parentTaskId);
    const parentSession = await this.requireSession(parentTask.sessionId);
    const [sessionToolInvocations, parentRuns] = await Promise.all([
      this.store.toolInvocations.listBySession(parentSession.id),
      this.store.subagentRuns.listByParentSession(parentSession.id),
    ]);

    const delegatedRuns = parentRuns
      .filter((run) => run.parentTaskId === parentTask.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const delegatedReplays = await Promise.all(
      delegatedRuns.map(async (run) => this.getSubagentRunReplay(run.id)),
    );

    return {
      parentTask,
      parentSession,
      directToolInvocations: sessionToolInvocations.filter(
        (log) => log.taskId === parentTask.id && !log.subagentRunId,
      ),
      delegatedReplays,
    };
  }

  // 面试点：child session 需要有“收尾策略”，否则 subagent 会不断堆积成上下文垃圾。
  // 这里的 cleanup 只归档已经结束的 child session，并保留跳过原因，方便后面审计。
  async cleanupChildSessions(input: CleanupChildSessionsInput): Promise<CleanupChildSessionsResult> {
    await this.requireSession(input.parentSessionId);
    const policy = input.policy;
    const archiveStatuses =
      input.archiveStatuses ?? policy?.archiveStatuses ?? ["completed", "failed", "canceled"];
    const now = this.options.now();
    const nowTimestamp = toTimestamp(now);
    const [childSessions, runs] = await Promise.all([
      this.store.sessions.listByParentSession(input.parentSessionId),
      this.store.subagentRuns.listByParentSession(input.parentSessionId),
    ]);

    const retainMostRecentFinishedChildren = policy?.retainMostRecentFinishedChildren ?? 0;
    const childSessionsWithLatestFinishedRuns = childSessions
      .map((childSession) => ({
        childSessionId: childSession.id,
        latestRun: pickLatestRun(runs.filter((run) => run.childSessionId === childSession.id)),
      }))
      .flatMap((entry) => {
        if (!entry.latestRun) {
          return [];
        }

        if (!archiveStatuses.includes(entry.latestRun.status as (typeof archiveStatuses)[number])) {
          return [];
        }

        return [{ childSessionId: entry.childSessionId, latestRun: entry.latestRun }];
      });
    const retainedChildSessionIds = new Set(
      childSessionsWithLatestFinishedRuns
        .sort((left, right) => right.latestRun.updatedAt.localeCompare(left.latestRun.updatedAt))
        .slice(0, retainMostRecentFinishedChildren)
        .map((entry) => entry.childSessionId),
    );

    const archivedChildSessionIds: string[] = [];
    const skipped: CleanupChildSessionsResult["skipped"] = [];

    // 逐个评估每个 child session，决定是否归档
    for (const childSession of childSessions) {
      // 检查 1: 已经归档过的，除非明确要求，否则跳过
      if (childSession.status === "archived" && !(input.includeAlreadyArchived ?? false)) {
        skipped.push({
          childSessionId: childSession.id,
          reason: "child session 已归档",
        });
        continue;
      }

      // 检查 2: 找最新的 run。如果没有 run 关联，说明 child session 孤立了
      const latestRun = pickLatestRun(runs.filter((run) => run.childSessionId === childSession.id));
      if (!latestRun) {
        skipped.push({
          childSessionId: childSession.id,
          reason: "未找到关联的 subagent run",
        });
        continue;
      }

      // 检查 3: run 的状态必须符合清理条件（只归档已结束的 run）
      if (!archiveStatuses.includes(latestRun.status as (typeof archiveStatuses)[number])) {
        skipped.push({
          childSessionId: childSession.id,
          latestRunId: latestRun.id,
          latestRunStatus: latestRun.status,
          reason: "最新 subagent run 还未结束，不应归档",
        });
        continue;
      }

      // 检查 4: 是否在"保留窗口"内。最近的 N 个 child sessions 要保留，避免过度清理
      if (retainedChildSessionIds.has(childSession.id)) {
        skipped.push({
          childSessionId: childSession.id,
          latestRunId: latestRun.id,
          latestRunStatus: latestRun.status,
          reason: "命中保留窗口，暂不自动归档",
        });
        continue;
      }

      // 检查 5: 策略要求必须有结果摘要
      if (policy?.requireResultSummary && !latestRun.resultSummary) {
        skipped.push({
          childSessionId: childSession.id,
          latestRunId: latestRun.id,
          latestRunStatus: latestRun.status,
          reason: "缺少结果摘要，不满足自动归档策略",
        });
        continue;
      }

      // 检查 6: 检查 run 的年龄。太新的 run 要保留，以防后续需要恢复
      if (policy?.maxAgeMs !== undefined) {
        const ageMs = nowTimestamp - toTimestamp(latestRun.updatedAt);
        if (ageMs < policy.maxAgeMs) {
          skipped.push({
            childSessionId: childSession.id,
            latestRunId: latestRun.id,
            latestRunStatus: latestRun.status,
            reason: `距离最新结束时间仅 ${ageMs}ms，未达到自动归档阈值`,
          });
          continue;
        }
      }

      // 所有检查都通过了，准备归档这个 child session

      // 更新 child session 的 active goal 状态
      if (childSession.activeGoalId) {
        await this.store.goals.updateStatus(
          childSession.activeGoalId,
          mapRunStatusToGoalStatus(latestRun.status),
          now,
          latestRun.status === "completed" ? now : undefined,
        );
      }

      // 清空 child session 的摘要的不相关项，但保留重要事实（用于后续审计）
      await this.store.sessions.updateSummary(
        childSession.id,
        {
          shortSummary:
            childSession.summary.shortSummary ||
            `子代理 ${latestRun.agentMode} 已${latestRun.status === "completed" ? "完成" : "结束"}`,
          openLoops: [],  // 清空未完成的任务（已结束了）
          nextActions: [], // 清空下一步行动（已结束了）
          importantFacts: childSession.summary.importantFacts, // 保留重要发现
        },
        now,
      );
      // 最后标记为已归档
      await this.store.sessions.archive(childSession.id, now);
      archivedChildSessionIds.push(childSession.id);
    }

    return {
      parentSessionId: input.parentSessionId,
      archivedChildSessionIds,
      skipped,
    };
  }

  /**
   * 内部方法：创建并持久化一条 session 记录。
   * 
   * 这个方法负责把 session 对象构建完整并存入数据库。
   * 它被 createSession 和 createChildSession 两个公开方法共用，
   * 相当于 session 创建流程的"最后一公里"。
   * 
   * @param input session 的核心属性：工作区 ID、标题、agent 模式、可选的父会话 ID、初始摘要
   * @returns 新创建的 session 记录（包含了生成的 ID 和时间戳）
   */
  private async createSessionRecord(input: {
    workspaceId: string;
    title: string;
    agentMode: AgentMode;
    parentSessionId?: string;
    summary: SessionSummary;
  }): Promise<Session> {
    const now = this.options.now();
    const session: Session = {
      id: this.options.createId("session"),
      workspaceId: input.workspaceId,
      parentSessionId: input.parentSessionId,
      title: input.title,
      status: "active",  // 新建 session 默认是活跃的
      activeAgentMode: input.agentMode,
      summary: input.summary,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.sessions.create(session);
    return session;
  }

  /**
   * 内部方法：安全地获取 session，如果不存在则抛出错误。
   * 
   * 这是一个很常用的"验证+加载" step。几乎所有改动 session 的公开方法
   * 都会先调用这个来确保 session 存在
   * （比如 renameSession、archiveSession、createChildSession）。
   * 
   * @param sessionId 要查找的 session ID
   * @returns session 对象
   * @throws RuntimeEntityNotFoundError 如果 session 不存在
   */
  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.store.sessions.getById(sessionId);
    if (!session) {
      throw new RuntimeEntityNotFoundError("session", sessionId);
    }

    return session;
  }

  /**
   * 内部方法：安全地获取 goal，如果不存在则抛出错误。
   * 
   * goal 是 goal-driven runtime 的核心实体。任何涉及 goal 的操作
   * 都应该先通过这个方法验证 goal 确实存在。
   * 
   * @param goalId 要查找的 goal ID
   * @returns goal 对象
   * @throws RuntimeEntityNotFoundError 如果 goal 不存在
   */
  private async requireGoal(goalId: string): Promise<Goal> {
    const goal = await this.store.goals.getById(goalId);
    if (!goal) {
      throw new RuntimeEntityNotFoundError("goal", goalId);
    }

    return goal;
  }

  /**
   * 内部方法：安全地获取 subagent run，如果不存在则抛出错误。
   * 
   * 这个方法被 completeSubagentRun、cleanupChildSessions、getSubagentRunReplay 等方法使用，
   * 是对 run 记录的统一的"存在性验证"入口。
   * 
   * @param id 要查找的 subagent run ID
   * @returns subagent run 对象
   * @throws RuntimeEntityNotFoundError 如果 run 不存在
   */
  private async requireSubagentRun(id: string): Promise<SubagentRun> {
    const run = await this.store.subagentRuns.getById(id);
    if (!run) {
      throw new RuntimeEntityNotFoundError("subagent_run", id);
    }

    return run;
  }

  /**
   * 内部方法：安全地获取 task，如果不存在则抛出错误。
   * 
   * task 是执行账本中的"工作单位"。任何涉及 task 的操作
   * 都应该先通过这个方法验证 task 确实存在。
   * 
   * @param id 要查找的 task ID
   * @returns task 对象
   * @throws RuntimeEntityNotFoundError 如果 task 不存在
   */
  private async requireTask(id: string): Promise<Task> {
    const task = await this.store.tasks.getById(id);
    if (!task) {
      throw new RuntimeEntityNotFoundError("task", id);
    }

    return task;
  }
}
