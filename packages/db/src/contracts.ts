// 这些接口是 domain model 在存储层的镜像。现在它们还只是 TypeScript 合同，
// 但已经提前说明了：如果我们想做的是真 agent IDE，而不是聊天记录壳，
// 那哪些数据必须持久化。
export interface WorkspaceRow {
  id: string;
  path: string;
  label: string;
  created_at: string;
  updated_at: string;
}

// SessionRow 表示 session 在数据库里的存储形态，里面除了标题和状态，
// 还带 summary 和 lineage 信息。
export interface SessionRow {
  id: string;
  workspace_id: string;
  parent_session_id?: string;
  title: string;
  status: "active" | "archived";
  agent_mode: string;
  active_goal_id?: string;
  summary_json: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
}

// GoalRow 和消息历史分开存，是为了让 runtime 恢复工作时依赖“目标和成功标准”，
// 而不是只能把整段聊天从头读回去。
export interface GoalRow {
  id: string;
  workspace_id: string;
  session_id: string;
  title: string;
  description: string;
  success_criteria_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

// PlanRow 单独存，是因为 plan 和 steps 是结构化产物，不应该退化成普通聊天文本。
export interface PlanRow {
  id: string;
  goal_id: string;
  session_id: string;
  status: string;
  summary: string;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

// TaskRow 是执行账本。后面无论主 agent 还是 subagent 拿任务，
// 都应该能在这里追踪归属、状态和输入输出摘要。
export interface TaskRow {
  id: string;
  goal_id: string;
  plan_id?: string;
  session_id: string;
  owner_agent: string;
  title: string;
  status: string;
  input_summary: string;
  output_summary?: string;
  created_at: string;
  updated_at: string;
}

// MessageRow 故意保持很薄。复杂行为应该出现在 domain / runtime 层，
// 而不是把数据库存储细节渗透到整个系统里。
export interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content_json: string;
  created_at: string;
}

// MemoryRow 单独存在，是因为 memory 需要支持查询、跨 session 复用和持久化，
// 不能只塞进 summary 里。
export interface MemoryRow {
  id: string;
  workspace_id: string;
  session_id?: string;
  scope: "session" | "workspace" | "user";
  key: string;
  value: string;
  source: "user" | "assistant" | "system" | "tool" | "review";
  confidence: number;
  created_at: string;
  updated_at: string;
}

// SubagentRunRow 同时记录 parent 和 child，是为了让我们后面能查清：
// 到底委托了什么、委托给谁、结果从哪条 child session 回来。
export interface SubagentRunRow {
  id: string;
  parent_session_id: string;
  child_session_id: string;
  parent_task_id?: string;
  agent_mode: string;
  status: string;
  reason: string;
  input_summary: string;
  result_summary?: string;
  created_at: string;
  updated_at: string;
}

// CheckpointRow 是 runtime 可恢复执行的持久化挂点。
export interface CheckpointRow {
  id: string;
  session_id: string;
  node: string;
  state_json: string;
  summary: string;
  created_at: string;
}

// ToolInvocationRow 需要持久化，这样后面才能做回放、审计和问题排查。
export interface ToolInvocationRow {
  id: string;
  session_id: string;
  task_id?: string;
  subagent_run_id?: string;
  tool_name: string;
  input_json: string;
  status: "started" | "completed" | "failed";
  output_json?: string;
  created_at: string;
  updated_at: string;
}

// 这是数据库层最小必须覆盖的表面。少了其中几张表，就不能说真正支持了
// memory / multi-session / subagent / planning / goal-driven 这些核心能力。
export const DATABASE_MUST_HAVE_TABLES = [
  "workspaces",
  "sessions",
  "goals",
  "plans",
  "tasks",
  "messages",
  "memory_records",
  "subagent_runs",
  "checkpoints",
  "tool_invocations",
] as const;
