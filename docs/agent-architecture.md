# Agent IDE 架构说明

## 产品定义

这个项目要做的是一个严肃的 agent IDE，不是给模型外面包一层聊天壳。
系统必须原生支持：

- 持久化 memory
- multi-session 工作流
- 真正的 subagent
- 带真实工具限制的 planning mode
- 带 review 闭环的 goal-driven 执行流程

第一阶段目标是做一个类似 opencode 的 agent IDE。后面它可以长成桌面版、终端版或者 Web 版，但 runtime 和数据模型必须先稳定下来，UI 只是上层外壳，不应该反过来主导底层设计。

## 第一阶段不追求的东西

- 视觉上极致精致
- 第一天就支持很多模型和 provider
- 在核心 runtime 还没稳定前就先做花哨插件生态
- 只有 prompt 角色不同、实际上没有边界的假 subagent

## 硬性能力要求

下面这些是发布门槛，不是加分项：

1. Memory 必须在进程重启后仍然存在。
2. Session 必须是一等实体，支持创建、列出、恢复、重命名、归档、fork。
3. Subagent 必须有自己的身份、策略和上下文边界。
4. Planning mode 必须由工具权限策略强制执行，不能只靠 prompt 文案约束。
5. Goal 状态必须同时存在于存储层和 runtime 状态里。
6. 每个核心能力都必须有场景测试，不能只有 unit test。

## 顶层结构

### 产品表层

- `apps/ide-web`：第一版 IDE 外壳

### 核心包

- `packages/core`：领域模型和系统不变量
- `packages/runtime`：编排图和执行合同
- `packages/db`：持久化合同和 repository 层
- `packages/tools`：工具合同、权限模型和执行适配层
- `packages/evals`：场景化验证和回放测试

## 核心领域实体

整个 runtime 围绕下面这些实体运转：

- `Workspace`：agent 操作的仓库或文件根目录
- `Session`：对话线程，也是执行线程
- `Goal`：当前 session 试图完成的持久化目标
- `Plan`：围绕某个 goal 产出的结构化策略
- `Task`：从 plan 中拆出来的可执行工作单元
- `Message`：用户、assistant、tool、system 消息
- `MemoryRecord`：跨 turn、跨 session 的 durable memory
- `Checkpoint`：用于恢复和审计的 graph 状态快照
- `SubagentRun`：一次带明确归属和策略的子执行

## Goal-driven runtime 模型

Runtime 应该组织成下面这条状态机：

1. `intake`：接收用户请求、workspace 和当前 session 状态
2. `clarify`：识别阻塞点，或记录合理假设
3. `plan`：为当前 goal 产出或修订计划
4. `delegate`：判断是否有任务需要交给 subagent
5. `execute`：调用工具，推进 task 状态
6. `review`：检查输出是否满足成功标准
7. `summarize`：把关键信息压缩进 session summary 和长期 memory
8. `continue-or-close`：决定继续、暂停、关闭，或标记 goal 完成

这里最重要的一条原则是：

任何执行步骤都必须能回指到当前 active goal 和它的 success criteria。只要 assistant 说不清“这一步为什么能推进目标”，这一步就不该发生。

## Memory 模型

Memory 分三层：

### 工作记忆

- 当前消息
- 当前计划
- 当前 task 列表
- 当前打开的工具结果

这一层主要存在于 session thread 和 checkpoint state 里。

### Session 记忆

- session summary
- 还没解决的问题
- 下一步待办
- 本次 session 里发现的重要 workspace 事实

这一层必须持久化，并且在恢复 session 时能重新加载。

### 长期项目记忆

- 用户偏好
- 仓库约定
- 重要架构说明
- 已知坑点
- 长期有效的操作规则

这一层必须可检索，并且能跨 session 使用。它不能只是埋在聊天记录里。

## Multi-session 模型

Multi-session 不是左边放几个聊天标题就算完成，它至少要支持：

- 新建 session
- 恢复已有 session
- 重命名 session
- 归档 session
- 从当前状态或任意 checkpoint fork 新 session
- 按 workspace 列出 session
- 保留 summary，让旧 session 不用加载完整历史也能快速理解

建议第一版就有的字段：

- `session.id`
- `session.workspace_id`
- `session.parent_session_id`
- `session.title`
- `session.status`
- `session.agent_mode`
- `session.summary`
- `session.created_at`
- `session.updated_at`

## Subagent 模型

Subagent 必须是真正的执行单元。每个 subagent 至少要有：

- agent profile
- 显式的 tool policy
- 清晰的输入合同
- parent session 引用
- child session 或独立 namespace
- 结果摘要
- 状态和时间戳

Subagent 调用必须是有边界的。父级只应该传最小必要上下文、任务合同和相关产物，不能一股脑把完整上下文全塞过去。

第一版建议内置这些 subagent：

- `explore`：只读检索和上下文收集
- `plan`：只做规划分析
- `review`：只读评审
- `build`：通用执行

## Planning mode

Planning mode 是一种受限 runtime 模式，必须强制做到：

- 不能创建文件
- 不能修改文件
- 不能打 patch
- 不能执行 shell

允许的工具可以包括：

- 读文件
- 搜索
- 列目录
- 诊断信息
- memory 检索
- 如果后面有需要，也可以允许写入结构化 plan 文件

Planning mode 的存在意义是：让系统可以安全地“看、想、提方案”，但不产生副作用。

## 持久化策略

当前版本改为：

- `MySQL`：核心真相源，承载 durable relational state
- `Redis`：热路径缓存、session lease、短期事件和后续队列能力

这里的关键原则是：

- 核心业务状态必须以 MySQL 为准
- Redis 只负责“快”和“协作”，不负责“唯一真相”
- 只要 Redis 丢了，系统应该最多退化，不应该丢失核心状态

最低限度要落在 MySQL 里的数据：

- workspaces
- sessions
- goals
- plans
- tasks
- messages
- session summaries
- memory records
- subagent runs
- checkpoints
- tool invocations
- tool results

Redis 第一阶段建议承担：

- session summary 热缓存
- active run lease，避免同一 session 被多个执行器同时推进
- 后续 event stream / queue 的预留入口

## 工具系统

工具系统至少需要三层：

1. `Tool contract`：稳定名称、类型化输入、类型化输出
2. `Tool policy`：mode 级别的 allow / deny 规则
3. `Tool executor`：真正调用 shell、filesystem、git，后续再接 LSP / MCP

每一次工具调用都应该落日志，方便后面回放、review 和排错。

## Review 和质量闭环

每个非平凡 turn 都应该以结构化 review 结束：

- 当前 goal 是否达成
- 还剩什么没解决
- 什么内容应该沉淀成 memory
- 当前 session 应该继续、压缩、fork 还是停止

Runtime 要偏保守。如果它不确定 goal 是否完成，就必须显式报告不确定，而不是悄悄宣称成功。

## 交付阶段

### Phase 1：基础层

- 定义核心实体
- 定义工具权限策略
- 建 MySQL schema
- 建 Redis keyspace 约定
- 建 runtime 状态机
- 持久化 sessions 和 summaries

### Phase 2：执行层

- 实现文件系统和 shell 工具
- 增加 subagent 执行
- 增加 plan mode 策略执行
- 增加场景测试

### Phase 3：IDE 外壳

- 类 opencode 的单主工作区 workbench：把 session/context 收进顶部或次级区域，把主舞台留给 agent、编辑器和终端
- 消息面板和 prompt 输入框
- session strip / session 列表
- workspace 文件列表、编辑器和保存链路
- 终端面板
- plan 面板
- goal 面板
- activity log 面板
- run log 面板
- 文件树和编辑器集成
- subagent 可视化

第一版 Web IDE 至少要做到：

- 能在同一 session 里连续提交 prompt，而不是每次都重新开会话
- 能直接浏览当前 workspace 的文件，并至少可以编辑和保存文本内容
- 能在当前 workspace 内执行命令，并查看最近的输出
- 能直接看到当前 active goal、current plan、recent messages、activity log
- 能从主交互区切到 replay / delegation / inspector，而不是只剩一个检查器页面

## 架构层面的危险信号

一旦出现下面这些情况，就应该停下来重构：

- session memory 只存在内存里
- planning mode 只靠 prompt 文案限制
- subagent 默认共享完整父上下文
- goal 只隐含在聊天文本里，没有独立实体
- 完成与否没有 success criteria 和 review 支撑
