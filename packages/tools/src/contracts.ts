import type { AgentMode, PermissionScope, ToolPolicy } from "@agent-ide/core";

// ToolName 现在故意保持小而稳。先把工具边界定义清楚，
// 再逐步加 LSP、MCP 或更复杂的自动化能力。
export type ToolName =
  | "list"
  | "grep"
  | "view"
  | "write"
  | "edit"
  | "patch"
  | "bash"
  | "git_status"
  | "git_diff"
  | "run_checks"
  | "git_commit"
  | "webfetch"
  | "agent";

// ToolDefinition 描述一个工具是什么、需要什么权限、以及 runtime 应该怎么调用它。
// 真正的执行器后面再接进来。
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: ToolName;
  permission: PermissionScope;
  description: string;
  run: (input: TInput) => Promise<TOutput>;
}

// ToolInvocation 把“调用请求”从“工具实现”里拆出来，
// 这样更适合做日志、回放和权限检查。
export interface ToolInvocation<TInput = unknown> {
  name: ToolName;
  input: TInput;
  requestedBy: AgentMode;
}

// ToolResult 统一成功和失败的返回格式，避免每个工具自己定义一套结果结构。
export interface ToolResult<TOutput = unknown> {
  ok: boolean;
  output?: TOutput;
  error?: string;
}

// planning mode 的真实约束从这里开始：工具先映射到 permission scope，
// 然后再由 policy 判断是否允许，而不是只按工具名字硬编码。
export const TOOL_PERMISSION_MAP: Record<ToolName, PermissionScope> = {
  list: "read",
  grep: "read",
  view: "read",
  write: "write",
  edit: "edit",
  patch: "patch",
  bash: "bash",
  git_status: "git",
  git_diff: "git",
  run_checks: "bash",
  git_commit: "git",
  webfetch: "web",
  agent: "read",
};

export function isToolAllowed(name: ToolName, policy: ToolPolicy): boolean {
  const permission = TOOL_PERMISSION_MAP[name];
  if (policy.denied.includes(permission)) {
    return false;
  }

  return policy.allowed.includes(permission);
}
