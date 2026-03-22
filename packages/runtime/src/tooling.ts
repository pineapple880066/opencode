import { randomUUID } from "node:crypto";

import { DEFAULT_TOOL_POLICIES } from "@agent-ide/core";
import { type ToolInvocation, type ToolResult, type ToolName, ToolRegistry } from "@agent-ide/tools";

import type { RuntimeStore } from "./store.js";
import { RuntimeEntityNotFoundError } from "./service.js";

export interface ExecuteToolInput<TInput = unknown> {
  sessionId: string;
  name: ToolName;
  input: TInput;
  taskId?: string;
  subagentRunId?: string;
  approvalGranted?: boolean;
}

// 面试点：这个执行器体现了“agent 不是黑盒”的设计思路。
// 每次工具调用都会经过 policy 检查，并且留下 invocation 记录，方便后续做审计、回放和 debug。
// RuntimeToolExecutor 负责把 session 的当前 agent mode、tool policy 和
// tool invocation 持久化串起来。
export class RuntimeToolExecutor {
  constructor(
    private readonly store: RuntimeStore,
    private readonly registry: ToolRegistry,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: (prefix: string) => string = (prefix) =>
      `${prefix}_${randomUUID()}`,
  ) {}

  async execute<TInput, TOutput>(input: ExecuteToolInput<TInput>): Promise<ToolResult<TOutput>> {
    const session = await this.store.sessions.getById(input.sessionId);
    if (!session) {
      throw new RuntimeEntityNotFoundError("session", input.sessionId);
    }

    const createdAt = this.now();
    const invocationId = this.createId("tool_invocation");

    await this.store.toolInvocations.start({
      id: invocationId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      subagentRunId: input.subagentRunId,
      toolName: input.name,
      inputJson: JSON.stringify(input.input),
      status: "started",
      createdAt,
      updatedAt: createdAt,
    });

    try {
      const result = await this.registry.dispatch<TInput, TOutput>(
        {
          name: input.name,
          input: input.input,
          requestedBy: session.activeAgentMode,
        } satisfies ToolInvocation<TInput>,
        {
          policy: DEFAULT_TOOL_POLICIES[session.activeAgentMode],
          approvalGranted: input.approvalGranted,
        },
      );

      await this.store.toolInvocations.finish(
        invocationId,
        result.ok ? "completed" : "failed",
        result.ok ? JSON.stringify(result.output ?? null) : JSON.stringify({ error: result.error }),
        this.now(),
      );

      return result;
    } catch (error) {
      await this.store.toolInvocations.finish(
        invocationId,
        "failed",
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        this.now(),
      );
      throw error;
    }
  }
}
