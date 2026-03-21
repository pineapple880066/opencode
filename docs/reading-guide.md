# 阅读顺序

这份文档的目标很简单：让你用最快速度看懂当前骨架，不被一堆文件名绕进去。

## 现在仓库里已经有什么

当前已经有的是：

- 架构定义和完成标准
- 项目内的 Codex skills，用来做自检和 goal-driven 约束
- TypeScript monorepo 骨架
- domain、runtime、db、tools、evals 这几层的合同定义

现在还没有的是：

- 真正可运行的 MySQL repository
- 真正接好的 Redis cache / lease 层
- 真正接上 LangGraph 的 runtime
- 真正能跑命令和改文件的工具执行器
- 真正的 IDE UI

所以你现在看到的代码，本质上是“系统形状”和“边界定义”，不是完整产品。

## 最推荐的阅读顺序

### 1. 先看规则

先读：

- `docs/agent-architecture.md`
- `docs/agent-definition-of-done.md`

为什么先看这两个：

因为它们定义了这个项目想成为什么，以及哪些地方绝对不能糊弄。如果不先看这两个，后面的 TypeScript 文件会看起来像一堆分散的类型定义。

### 2. 再看领域模型

再读：

- `packages/core/src/domain.ts`

为什么它最重要：

这个文件定义了系统里的核心“名词”：

- workspace
- session
- goal
- plan
- task
- memory
- tool policy
- agent profile
- subagent run

如果你能看懂这个文件，基本就明白了这个项目认定“什么东西是系统里真实存在的”。

这一层最值得注意的是：

- `Goal` 里直接存了 success criteria
- `Session` 里直接有 summary 和 parentSessionId
- `MemoryRecord` 和聊天记录是分开的
- `ToolPolicy` 是 planning mode 真正的约束方式
- `SubagentRun` 是 subagent 成为一等公民的关键

### 3. 然后看 runtime 主流程

再读：

- `packages/runtime/src/graph.ts`

为什么读它：

这个文件描述的是：上面那些核心实体，之后要怎么在运行时流转。

重点看这几个部分：

- `WorkflowNode`
- `AgentGraphState`
- `CORE_WORKFLOW`
- `ALLOWED_TRANSITIONS`

你可以把它理解成：

这是未来 LangGraph 真正接入之前的 runtime 合同。后面我们接 graph 引擎时，应该去贴合它，而不是把它推翻。

### 4. 再看存储层

再读：

- `packages/db/src/contracts.ts`

为什么它重要：

它回答的是“哪些东西必须进 MySQL，以及哪些热路径应该交给 Redis 辅助”。

你读这个文件时，可以重点想这些问题：

- session 怎么恢复
- goal 怎么持久化
- memory 怎么跨 session 留下来
- subagent 的父子关系怎么存
- checkpoint 怎么给 resume / fork 用
- tool invocation 怎么留痕

这一层最关键的观念是：

数据库不是只有 messages。这里把 goals、plans、tasks、memory、subagent_runs、checkpoints、tool_invocations 都作为独立概念来存；后面 Redis 只会辅助它们，不会替代它们。

### 5. 再看工具权限边界

再读：

- `packages/tools/src/contracts.ts`

为什么它小但重要：

这个文件在回答一个特别关键的问题：不同 mode 到底凭什么被限制。

这一层最值得注意的是：

- tool 会先映射到 permission scope
- agent mode 不是直接允许某个 tool，而是允许某种权限
- planning mode 以后能不能真的只读，关键就看这层

### 6. 再看验证标准

再读：

- `packages/evals/src/index.ts`

为什么看它：

它虽然短，但表达了一个重要态度：核心能力不是“感觉做出来了”，而是要有场景测试去证明。

### 7. 最后看一下 UI 入口占位

最后读：

- `apps/ide-web/src/index.ts`

为什么最后看：

它现在只是很薄的一层占位，但它已经告诉你第一版 IDE 最应该围绕哪些面板展开：

- sessions
- active goal
- plan
- activity log

## 每个核心 TypeScript 文件一句话理解

- `packages/core/src/domain.ts`：定义系统里到底有哪些核心实体。
- `packages/runtime/src/graph.ts`：定义这些实体在 runtime 里怎么流转。
- `packages/db/src/contracts.ts`：定义哪些状态必须持久化。
- `packages/tools/src/contracts.ts`：定义不同 agent mode 的权限边界。
- `packages/evals/src/index.ts`：定义以后怎么验证它不是嘴上实现了。

## 现在你可以怎么在脑子里理解这个仓库

你可以把它先想成五层：

1. `core` 负责定义“系统里有什么”。
2. `runtime` 负责定义“这些东西怎么动起来”。
3. `db` 负责定义“哪些东西重启后还得在”。
4. `tools` 负责定义“不同 agent 到底能做什么”。
5. `evals` 负责定义“以后怎么证明这些能力是真的”。

这就是当前这版仓库最核心的样子。
