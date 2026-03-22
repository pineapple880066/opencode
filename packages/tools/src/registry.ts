import type { PermissionScope, ToolPolicy } from "@agent-ide/core";

import {
  isToolAllowed,
  TOOL_PERMISSION_MAP,
  type ToolDefinition,
  type ToolInvocation,
  type ToolName,
  type ToolResult,
} from "./contracts.js";

export interface ToolDispatchContext {
  policy: ToolPolicy;
  approvalGranted?: boolean;
}

export class ToolNotFoundError extends Error {
  constructor(toolName: ToolName) {
    super(`未找到工具定义: ${toolName}`);
    this.name = "ToolNotFoundError";
  }
}

export class ToolPermissionDeniedError extends Error {
  constructor(toolName: ToolName, permission: PermissionScope, mode: ToolPolicy["mode"]) {
    super(`agent mode=${mode} 不允许执行工具 ${toolName}，因为它需要权限 ${permission}`);
    this.name = "ToolPermissionDeniedError";
  }
}

export class ToolApprovalRequiredError extends Error {
  constructor(toolName: ToolName, permission: PermissionScope, mode: ToolPolicy["mode"]) {
    super(`agent mode=${mode} 执行工具 ${toolName} 需要额外批准，权限=${permission}`);
    this.name = "ToolApprovalRequiredError";
  }
}

// 面试点：很多 agent 系统把“planning mode”写在 prompt 里，
// 但这里把限制放在 dispatch 层，目的是把行为约束做成系统能力。
// ToolRegistry 是真正的工具执行入口。planning mode 是否只读，
// 最终就取决于这里会不会严格先做 policy 检查。
export class ToolRegistry {
  private readonly definitions = new Map<ToolName, ToolDefinition>();

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    this.definitions.set(definition.name, definition as ToolDefinition);
  }

  get(name: ToolName): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.definitions.values());
  }

  async dispatch<TInput, TOutput>(
    invocation: ToolInvocation<TInput>,
    context: ToolDispatchContext,
  ): Promise<ToolResult<TOutput>> {
    const definition = this.definitions.get(invocation.name);
    if (!definition) {
      throw new ToolNotFoundError(invocation.name);
    }

    const permission = TOOL_PERMISSION_MAP[invocation.name];
    if (!isToolAllowed(invocation.name, context.policy)) {
      throw new ToolPermissionDeniedError(invocation.name, permission, context.policy.mode);
    }

    if (context.policy.requiresApproval.includes(permission) && !context.approvalGranted) {
      throw new ToolApprovalRequiredError(invocation.name, permission, context.policy.mode);
    }

    try {
      const output = await definition.run(invocation.input);
      return {
        ok: true,
        output: output as TOutput,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
