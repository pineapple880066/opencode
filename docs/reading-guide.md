# 阅读顺序

这份文档的目标很简单：让你用最快速度看懂当前骨架，不被一堆文件名绕进去。

## 现在仓库里已经有什么

当前已经有的是：

- 架构定义和完成标准
- 项目内的 Codex skills，用来做自检和 goal-driven 约束
- TypeScript monorepo 骨架
- domain、runtime、db、tools、evals 这几层的合同定义
- 真正可运行的 MySQL repository、Redis summary cache、LangGraph 最小编排
- bootstrap 组合根和真实基础设施 smoke 脚本
- IDE 侧的 replay / delegation panel state builder
- IDE 单主工作区 workbench，已经能把 `agent 对话 + 文件编辑 + 终端面板` 收进同一个主交互面，并把 `goal / plan / activity / replay / delegation / inspector` 退成次级信息面板
- 当前工作台布局已经进一步往“中间工作区优先”调整：左/右侧大栏被压缩成顶部 header 和 session strip，方便把主要宽度留给 agent 对话、文件编辑和终端
- 浏览器运行时，已经能让这些 `data-action` 在浏览器里真实触发导航，也能把 prompt 提交接到 runtime
- workspace 文件浏览和最小终端命令面板，已经接进当前工作台，不再只有会话历史
- 当前 workbench 还额外做过一轮 UI 稳定性修复：固定区域、内部滚动、编辑器和终端彼此独立，避免 explorer 把整页撑长
- LangGraph execute 的最小工具循环已经接通：模型可以请求 `toolCalls`，runtime 会真实执行文件工具并把结果回写
- execute 的工具循环已经继续加固：最近工具调用摘要会回喂给 executor，连续重复的相同工具调用会被 runtime 里的 loop guard 拦截
- builtin 文件工具已经开始兼容更常见的 CLI agent 参数风格，比如 `file_path`、`old_string`、`new_string`
- `MiniMax` hooks 适配层已经存在，可以把外部模型挂到 `LangGraphHooks`
- 工作区级 `.env / .env.local` 自动加载已经接好，`smoke` 和 `dev-server` 会直接吃当前仓库配置
- `compose.yaml` 和 `pnpm infra:*` 已经把本地 `MySQL + Redis` 起服务这件事固化进仓库

现在还没有的是：

- 更完整的 scenario test 套件
- 完整的 subagent orchestration 和更完整的浏览器交互层
- versioned migration / rollback
- 更完整的 IDE UI，比如真正的 Monaco 工作流、PTY 级终端、局部刷新和更细的错误/加载反馈

所以你现在看到的代码，已经不只是“系统形状”和“边界定义”了，
而是一个开始能真实连接 MySQL / Redis / LangGraph 的早期 runtime，
但它仍然不是完整产品。

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
- `packages/runtime/src/service.ts`

为什么读它：

这两个文件描述的是：上面那些核心实体，之后要怎么在运行时流转，以及真正的业务动作怎么落地。

重点看这几个部分：

- `WorkflowNode`
- `AgentGraphState`
- `CORE_WORKFLOW`
- `ALLOWED_TRANSITIONS`

你可以把它理解成：

其中：

- `graph.ts` 更像 workflow 合同
- `service.ts` 更像应用服务层，负责 goal、plan、subagent、summary、replay、cleanup 这些真实动作

你可以把它理解成：

这是 runtime 的“状态流转 + 业务动作”双核心。后面接 LangGraph、接 UI、接 API，都应该去贴合它，而不是把它推翻。

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

### 5. 再看 bootstrap 和真实基础设施接法

再读：

- `packages/db/src/bootstrap.ts`
- `apps/ide-web/src/bootstrap.ts`

为什么这两个文件值得看：

它们回答的是“这些合同怎么真正接成一条启动链路”。

重点看这些点：

- MySQL 数据库如何自动创建
- 初始 schema 如何应用
- 为什么 bootstrap 之后还要立刻检查必需表
- Redis 怎么接进 session summary cache
- runtime store、tool registry、LangGraph runtime 是怎么被组装起来的

如果你想看“这个项目是不是已经开始真跑起来了”，这两个文件比只看类型定义更直接。

### 6. 再看本地基础设施怎么被固化下来

再读：

- `compose.yaml`
- `docs/local-infra.md`

为什么它们值得看：

这两份文件回答的是“现在这个仓库依赖的 MySQL 和 Redis，别人拿到代码后怎么一键起起来”。

重点看这些点：

- 为什么 `compose.yaml` 只放 `MySQL 8.4 + Redis 7`
- healthcheck、volume、端口映射是怎么定的
- 为什么 `.env` 会同时被应用脚本和 compose 复用

如果你现在最想做的是把本地依赖先起起来，再跑 smoke，这两份文件就是第一入口。

### 7. 再看 IDE 面板状态怎么接 runtime

再读：

- `apps/ide-web/src/panels.ts`

为什么它值得看：

它回答的是“runtime 已经聚合好的 replay / delegation 数据，怎么再转成 IDE 真能展示的面板状态”。

重点看这些点：

- `buildSubagentReplayPanelState()`
- `buildParentTaskDelegationPanelState()`
- 为什么 panel builder 不自己去查数据库
- tool invocation 是怎么按 task 分组的

如果你想看“这项目离真正的 agent IDE 还有多远”，这个文件很有代表性，因为它已经站在 UI 边缘了，但还没有真正画界面。

### 8. 再看 IDE 工作台怎么把状态变成界面

再读：

- `apps/ide-web/src/shell.ts`

为什么它值得看：

这个文件回答的是“panel state 已经有了之后，怎么把它们组织成一个类 opencode 的工作台，让状态真正可见、可点、可检查、可继续提交 prompt，并且至少能浏览当前 workspace 文件”。

重点看这些点：

- `buildIdeShellState()`
- `reduceIdeShellNavigation()`
- `renderIdeShellDocument()`
- 文件浏览、文本编辑和保存链路是怎么和 session workbench 共存的
- 为什么这里先做三栏工作台和 server-driven renderer，而不是立刻绑定某个前端框架

如果你想理解“为什么这个项目现在还不能说 UI 完成，但已经不是纯后端骨架”，这个文件是最直接的证据。

### 9. 再看浏览器运行时和 HTTP 边界

再读：

- `apps/ide-web/src/browser.ts`
- `apps/ide-web/src/server.ts`
- `apps/ide-web/src/dev-server.ts`

为什么它们值得看：

这三份文件回答的是“现在这个最小 IDE shell 怎么真的跑进浏览器里”。

重点看这些点：

- `renderIdeShellBrowserDocument()` 如何把当前导航、当前 shell state 和浏览器运行时脚本注入文档
- `parseIdeShellActionDataset()` 和 `reduceIdeShellBrowserAction()` 如何把 `data-action` 变成下一次导航
- 浏览器里的 composer 是如何把 prompt POST 到 server，再触发 runtime / LangGraph 的
- `createIdeShellRequestHandler()` 如何同时处理 query 导航和 prompt invoke
- 为什么这一步先做 server-driven workbench，而不是立刻上完整前端框架

如果你想看“这个项目现在是否已经有真正的浏览器运行时”，这三份文件就是最直接的入口。

### 10. 再看外部模型怎么被接进来

再读：

- `apps/ide-web/src/minimax.ts`
- `packages/evals/src/minimax-smoke.ts`

为什么它们值得看：

它们回答的是“当前这个项目并没有把模型写死在 core 里，而是怎样通过 `LangGraphHooks` 把外部 provider 接进来”。

重点看这些点：

- `createMiniMaxHooks()` 如何把 `goalFactory / planner / delegate / executor / reviewer / summarizer` 一次实现出来
- `readMiniMaxConfig()` 如何读取 `MINIMAX_API_KEY / MINIMAX_BASE_URL / MINIMAX_MODEL`
- `minimax-smoke.ts` 如何跑最短验证链路：`create session -> invoke LangGraph -> 输出结果`

如果你现在要亲手接模型验证，这两份文件就是最直接的入口。

### 11. 再看工具权限边界

再读：

- `packages/tools/src/contracts.ts`

为什么它小但重要：

这个文件在回答一个特别关键的问题：不同 mode 到底凭什么被限制。

这一层最值得注意的是：

- tool 会先映射到 permission scope
- agent mode 不是直接允许某个 tool，而是允许某种权限
- planning mode 以后能不能真的只读，关键就看这层

### 12. 再看验证标准

再读：

- `packages/evals/src/index.ts`
- `packages/evals/src/minimax-smoke.ts`
- `packages/evals/src/persistence-smoke.ts`
- `apps/ide-web/src/minimax.test.ts`
- `apps/ide-web/src/browser.test.ts`
- `apps/ide-web/src/panels.test.ts`
- `apps/ide-web/src/shell.test.ts`
- `apps/ide-web/src/server.test.ts`
- `packages/runtime/src/multi-session.test.ts`
- `packages/runtime/src/subagents.test.ts`

为什么看它：

它表达了一个重要态度：核心能力不是“感觉做出来了”，而是要有验证去证明。
其中 `persistence-smoke.ts` 不是纯单测，而是会去打真实 MySQL / Redis 的 smoke 路径。

### 13. 最后看一下 UI 入口占位

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
- `packages/runtime/src/service.ts`：把 goal、plan、subagent、summary、replay、cleanup 这些动作组织成应用服务。
- `packages/db/src/contracts.ts`：定义哪些状态必须持久化。
- `packages/db/src/bootstrap.ts`：把数据库创建、schema 应用和必需表检查串起来。
- `packages/db/src/env.ts`：把工作区级 `.env / .env.local` 自动加载成运行时配置源。
- `compose.yaml`：把本地 MySQL / Redis 依赖固化成可复用的基础设施入口。
- `apps/ide-web/src/bootstrap.ts`：把 MySQL、Redis、runtime store、tool registry、LangGraph 接成启动链路。
- `apps/ide-web/src/panels.ts`：把 replay / delegation 聚合结果转成 IDE 面板状态。
- `apps/ide-web/src/shell.ts`：把 sessions、replay、delegation、inspector 组织成最小 IDE 壳层。
- `apps/ide-web/src/browser.ts`：把当前 shell 文档升级成浏览器可交互的运行时文档。
- `apps/ide-web/src/server.ts`：给浏览器提供最小 HTML/JSON 边界。
- `apps/ide-web/src/dev-server.ts`：提供本地启动最小 IDE 浏览器运行时的入口。
- `apps/ide-web/src/minimax.ts`：把外部模型 provider 适配成 hooks。
- `packages/tools/src/contracts.ts`：定义不同 agent mode 的权限边界。
- `packages/evals/src/minimax-smoke.ts`：用真实 MiniMax API key 跑最短 smoke 路径。
- `packages/evals/src/persistence-smoke.ts`：用真实基础设施验证持久化和 durable execution。

## 现在你可以怎么在脑子里理解这个仓库

你可以把它先想成五层：

1. `core` 负责定义“系统里有什么”。
2. `runtime` 负责定义“这些东西怎么动起来”。
3. `db` 负责定义“哪些东西重启后还得在”。
4. `tools` 负责定义“不同 agent 到底能做什么”。
5. `evals` 负责定义“以后怎么证明这些能力是真的”。

这就是当前这版仓库最核心的样子。
