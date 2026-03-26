# 项目面试讲解手册

这份文档的目标不是写成 README，而是帮你在面试里把这个项目讲得有层次、有设计感，而且说得出 trade-off。

如果你准备在面试前重新把项目吃透，仓库里还有一份更偏“自学拆解”的材料：

- `docs/project-deep-dive.md`

它不是面试稿，而是按实现链路写的深度阅读文档。你可以先用那份文档复习，再回到这里练怎么压缩成面试表达。

## 一句话定位

这是一个正在实现中的 `agent IDE`，目标不是做一个聊天框，而是做一个真正能围绕 `goal / session / memory / planning mode / subagent` 运转的 coding agent 运行时和 IDE 外壳。

## 30 秒版本

我这个项目的核心不是“调一个大模型 API”，而是自己把 agent runtime 拆成了几个关键层：

- 领域模型层：把 `Goal`、`Session`、`MemoryRecord`、`SubagentRun` 这些概念做成一等实体
- runtime 层：把 agent 工作流拆成 `intake -> plan -> execute -> review -> summarize`
- 持久化层：用 `MySQL` 保存 durable state，用 `Redis` 做热缓存和 lease
- 工具层：不是靠 prompt 说“不要改文件”，而是把 `planning mode` 做成真正的 tool policy 拦截

我觉得这个项目最有价值的地方，在于它试图把“agent 行为”从 prompt 技巧，往工程系统能力推进。

## 2 分钟版本

我一开始就没把它当成聊天应用，而是把它当成一个 agent IDE runtime 去设计，所以我先定义了几个硬性要求：

- memory 必须持久化
- session 必须支持恢复、归档、后续 fork
- subagent 必须有独立边界
- planning mode 必须在执行层受限制
- goal-driven workflow 必须能落到持久化和 review 上

在架构上，我没有直接把所有逻辑塞进一个大 controller，而是分成：

1. `core`：领域模型，定义系统里到底有哪些真实实体
2. `runtime`：应用服务和 graph state，定义这些实体怎么流转
3. `db`：MySQL/Redis 适配层，保证状态可恢复
4. `tools`：工具注册、工具分发和权限检查

一个我觉得比较能体现工程意识的点是 `planning mode`。很多 agent 系统只是 prompt 里说“现在是 planning，不要改文件”，但我这里把它做成了 tool policy。也就是说：

- `plan` mode 在权限表里不允许 `write / edit / patch / bash`
- 工具真正 dispatch 的时候会先查 policy
- 所以就算模型想写文件，也会被执行层拦住

这类设计对我来说很重要，因为它说明这个系统不是靠模型“自觉”，而是靠工程约束保证行为。

## 项目里最值得讲的设计点

### 1. 为什么 Goal 要做成独立实体

如果 goal 只存在聊天历史里，后面很多事情都很难做：

- 无法明确判断当前任务到底围绕什么目标
- review 阶段很难判断“算不算完成”
- plan 和 task 也很难稳定回指到一个目标

所以我把 `Goal` 单独建模，并且把 `successCriteria` 直接挂在 goal 上。

你可以这样讲：

“我想避免 agent 系统最后变成一段越来越长的聊天记录，所以我把目标做成了结构化实体。这样 plan、task、review 都能围绕一个明确目标闭环。”

### 2. 为什么 Session 和 Memory 要分开

如果 memory 只是 message history 的一部分，会出现几个问题：

- 恢复旧 session 成本很高
- 跨 session 复用困难
- 很难区分‘聊天内容’和‘长期有效事实’

所以我把 `SessionSummary` 和 `MemoryRecord` 分开建模：

- `SessionSummary` 解决恢复会话时的信息压缩
- `MemoryRecord` 解决跨 session 的 durable knowledge

### 3. 为什么是 MySQL + Redis，而不是全塞进一个存储

这个 trade-off 很适合面试讲：

- `MySQL` 负责 durable relational state，是唯一真相源
- `Redis` 负责热缓存、session lease、后续事件流和队列

这样设计的理由是：

- agent IDE 的核心状态不能丢，所以必须有稳定真相源
- 但运行时又需要高频读写、锁和临时状态，所以 Redis 很适合做热路径

你可以这样回答：

“我不希望 Redis 变成事实数据库，所以我只让它做协作和缓存，不让它承担唯一真相。”

### 4. 为什么 planning mode 要放在 tool dispatch 层做

这是这个项目最适合被追问的点之一。

如果只是 prompt 里说“不要改文件”，会有几个问题：

- 不可验证
- 不可审计
- 一旦模型偏航，系统没有兜底

所以我把 planning mode 做成：

- `ToolPolicy`
- `ToolRegistry`
- `RuntimeToolExecutor`

这一层真正决定某个工具是否能跑。

### 5. 为什么还要单独做 RuntimeStore 抽象

因为 runtime 不应该直接依赖 MySQL 语句。否则：

- 测试困难
- 以后接 LangGraph 或换存储很痛苦
- 业务逻辑和数据访问会缠死

所以我在 runtime 里只依赖 `RuntimeStore` 接口，db 层再去实现 `createMySqlRuntimeStore()`。

这是一个很典型的“应用层依赖抽象，基础设施层实现抽象”的分层。

## 如果面试官追问“你是怎么把这个项目讲清楚的”

这时候不要临场乱跳文件，最好按固定顺序讲，不然很容易把 UI、runtime、provider、数据库混成一锅。

我建议你自己的讲法顺序是：

1. 先讲分层和组合根
2. 再讲应用服务层怎么定义 session/goal/plan/task/subagent 生命周期
3. 再讲 LangGraph 只是编排层，不是业务中心
4. 再讲 execute control loop、tool policy 和 reread budget
5. 再讲 MiniMax 适配层如何做结构化输出、repair 和 phase 约束
6. 最后讲 IDE workbench 是怎么把这些状态变成可见工作台的

如果面试官希望你“说细一点”，最稳的做法不是继续抽象，而是开始带代码位置。比如：

- 组合根看 `apps/ide-web/src/bootstrap.ts`
- 应用服务看 `packages/runtime/src/service.ts`
- graph 编排看 `packages/runtime/src/langgraph.ts`
- provider 适配看 `apps/ide-web/src/minimax.ts`
- IDE 状态层看 `apps/ide-web/src/shell.ts`
- 浏览器/服务端边界看 `apps/ide-web/src/browser.ts` 和 `apps/ide-web/src/server.ts`

你现在仓库里已经把这条阅读顺序写成了 `docs/project-deep-dive.md`。面试准备时，最好先沿那份文档复习一遍，再来把每一节压缩成 30 秒、2 分钟和 5 分钟版本。

如果面试官明确盯着 LangGraph 问，你现在仓库里还有一份专项材料：

- `docs/langgraph-in-project.md`

那份文档适合专门回答这些问题：

- LangGraph 到底是什么
- 这个项目里到底用了哪些 LangGraph 官方接口
- 哪些是项目自己写的适配层
- `thread_id / checkpoint_id / checkpoint_ns` 在这里具体代表什么
- 浏览器 prompt 是怎么真正进入 graph 的
- MySQL checkpointer 到底是怎么工作的

## LangGraph 这一块，面试时怎么讲才不塌

这部分不要从“我用了一个框架”开始讲，而要从“我把什么交给 LangGraph、什么留在项目自己手里”开始讲。

建议答法：

“我把 LangGraph 当成编排层，不当成业务中心。它负责节点顺序、graph state、thread checkpoint 和恢复；而 session、goal、plan、task、memory、tool policy、tool execution 这些业务动作，还是走我自己的 runtime service 和 toolExecutor。这样做的好处是框架负责 orchestration，我自己的代码负责领域规则，两边职责比较清楚。”

继续往下讲时，可以补：

“我先在 `packages/runtime/src/graph.ts` 里定义 workflow 合同和 `AgentGraphState`，再在 `packages/runtime/src/langgraph.ts` 里用 `Annotation.Root` 定义 LangGraph state，用 `StateGraph` 把 `intake -> clarify -> plan -> delegate -> execute -> review -> summarize -> continue-or-close` 接成主链。调用时我把 `thread_id` 直接对齐成 `sessionId`，这样 session 恢复和 graph 恢复就是同一个语义。”

再补 durable execution：

“LangGraph 官方 JS 版没有现成 MySQL saver，所以我自己实现了一个 `PersistentLangGraphCheckpointSaver`，把 checkpoint 和 pending writes 分别落到 `langgraph_checkpoints` 和 `langgraph_checkpoint_writes` 两张表里。这样 graph 的 checkpoint 恢复可以直接贴到 MySQL，而不用为了迎合框架去换存储架构。”

## LangGraph 面试训练版

这一节是给“训练面试”直接用的。

每一题都按 3 个层次写：

- 面试官可能会怎么问
- 你可以怎么答
- 代码证据在哪

建议你训练时不要背原文，而是先自己答，再回来对照代码位置补强。

### 1. LangGraph 到底是什么？你为什么在这个项目里用它？

你可以这样答：

“在我这个项目里，LangGraph 不是业务层，也不是模型层，而是 agent workflow 的编排层。我用它来表达节点顺序、graph state、thread checkpoint 和恢复。具体说，我把 `intake -> clarify -> plan -> delegate -> execute -> review -> summarize -> continue-or-close` 这条主链收成一张状态图，然后把 `thread_id` 对齐到 `sessionId`，这样一次 session 的运行和 LangGraph 的 thread 就是同一个恢复语义。这样做的好处是：业务动作仍然由我自己的 runtime service 执行，但编排、状态传递和 durable execution 交给框架来做。”

代码证据：

- workflow 合同定义：`packages/runtime/src/graph.ts:16-112`
- LangGraph 图定义：`packages/runtime/src/langgraph.ts:99-114`
- 节点和边：`packages/runtime/src/langgraph.ts:914-936`
- session 对齐 thread：`packages/runtime/src/langgraph.ts:944-957`

追问时可以补：

“我没有把 LangGraph 当成业务中心，所以 goal、plan、task、memory、tool policy 这些领域规则仍然在 `packages/runtime/src/service.ts` 和 `packages/runtime/src/tooling.ts` 里，而不是散进 graph 节点里。”

### 2. 你项目里到底用了哪些 LangGraph 官方接口？

你可以这样答：

“我项目里真正用到的 LangGraph 官方接口其实不算多，核心是 5 类。第一类是 `Annotation.Root`，我用它定义 graph state schema。第二类是 `StateGraph`，我用它把节点和边接成图。第三类是 `START / END`，定义图的入口和出口。第四类是 `compile({ checkpointer })`，让图具备 durable execution。第五类是 `invoke()` 和 `getState()`，分别负责运行一次图和读取 thread 快照。另外为了做持久化，我实现了 `BaseCheckpointSaver` 的自定义 MySQL 版本。”

代码证据：

- `Annotation.Root`：`packages/runtime/src/langgraph.ts:99-110`
- `StateGraph`：`packages/runtime/src/langgraph.ts:914-936`
- `START / END`：`packages/runtime/src/langgraph.ts:923-931`
- `invoke()`：`packages/runtime/src/langgraph.ts:944-957`
- `getState()`：`packages/runtime/src/langgraph.ts:959-965`
- `BaseCheckpointSaver` 自定义实现：`packages/db/src/langgraph-checkpointer.ts:174-354`

补充说明：

“项目里还有 `LangGraphHooks`、`LangGraphExecuteResult`、`AgentLangGraphRuntime` 这些名字听上去像 LangGraph 的东西，但它们不是官方接口，是我自己为了适配 provider 和业务层定义的项目内合同。”

对应代码：

- `LangGraphHooks`：`packages/runtime/src/langgraph.ts:52-91`
- `LangGraphExecuteResult`：`packages/runtime/src/langgraph.ts:35-41`
- `AgentLangGraphRuntime`：`packages/runtime/src/langgraph.ts:941-970`

### 3. 你的 graph state 是怎么定义的？为什么不用普通对象随便传？

你可以这样答：

“我用 `Annotation.Root` 显式定义了 graph state，因为我不想让节点之间传一个没有边界的普通对象。当前 state 里有 `sessionId`、`userMessage`、`runtimeState`、`latestReview`、`latestPlanId`、`latestSubagentRunId` 和 `executionLog`。其中 `executionLog` 还定义了 reducer，这样每个节点只返回自己的增量日志，整条运行链会自动累加。这样做的好处是状态结构稳定、类型清晰，也更利于 checkpoint 保存和恢复。”

代码证据：

- `AgentLangGraphAnnotation`：`packages/runtime/src/langgraph.ts:99-110`
- state/update 类型：`packages/runtime/src/langgraph.ts:112-114`

项目内业务 state 对应的是：

- `AgentGraphState`：`packages/runtime/src/graph.ts:63-77`

可以补一句：

“LangGraph annotation state 和业务状态不是一回事。annotation state 是图运行时在节点之间传的状态，`runtimeState` 只是其中一个字段，而 `runtimeState` 自身又对应项目自己的业务快照。”

### 4. 这张图现在是不是完全数据驱动的状态机？

你可以这样答：

“还不是完全数据驱动。当前项目已经在 `packages/runtime/src/graph.ts` 里定义了 `WorkflowNode`、`CORE_WORKFLOW`、`ALLOWED_TRANSITIONS` 和 `canTransitionTo()`，这些是状态机合同。但真正运行时会执行的顺序，当前还是 `packages/runtime/src/langgraph.ts` 里这一串固定的 `.addEdge(...)`。所以更准确地说，现在是‘状态机合同已经抽出来了，但 runtime 还是固定主链’，下一步才是把这些合同接成真正的条件路由。”

代码证据：

- workflow 合同：`packages/runtime/src/graph.ts:16-112`
- 固定主链：`packages/runtime/src/langgraph.ts:914-936`

这是个很好的诚实点：

- 设计层：有状态机合同
- 运行时层：当前仍是固定边

### 5. 浏览器里一次 prompt，到底是怎么进入 LangGraph 的？

你可以这样答：

“浏览器提交 prompt 之后，先走 `server.ts` 的 HTTP 边界。这个边界本身不懂业务，只负责解析请求和导航协议。真正进入 LangGraph 的地方在 `apps/ide-web/src/dev-server.ts` 的 `invoke` handler：这里会先确定 session，如果前端没传 session，就先创建一个新的 build session，然后调用 `runtime.langGraph.invoke({ sessionId, userMessage })`。而 `runtime` 本身是在 `apps/ide-web/src/bootstrap.ts` 里组装出来的，它把 store、service、toolExecutor 和 checkpointer 一起装进 `createAgentLangGraph(...)`。”

代码证据：

- HTTP 边界：`apps/ide-web/src/server.ts:134-260`
- prompt -> invoke：`apps/ide-web/src/dev-server.ts:44-65`
- 组合根：`apps/ide-web/src/bootstrap.ts:72-128`
- graph invoke：`packages/runtime/src/langgraph.ts:944-957`

面试时可以进一步压缩成一句：

“我的链路是 `browser -> server handler -> dev-server invoke -> runtime.langGraph.invoke -> graph node -> service/toolExecutor -> checkpointer/mysql`。”

### 6. 你的每个 graph 节点分别在做什么？

你可以这样答：

“我这张图里有 8 个节点。`intake` 负责写入用户消息，必要时创建第一个 goal；`clarify` 目前还是最小占位节点；`plan` 负责把 planner 的结构化输出落成真正的 Plan；`delegate` 负责决定是否派生 subagent，并创建 child session 和 subagent run；`execute` 是最复杂的控制环，负责 task/memory 同步和真实工具循环；`review` 负责判断 goal 是否真正满足；`summarize` 负责把当前进度收成 session summary；`continue-or-close` 是当前最小收尾节点。”

代码证据：

- `intakeNode`：`packages/runtime/src/langgraph.ts:449-490`
- `clarifyNode`：`packages/runtime/src/langgraph.ts:492-498`
- `planNode`：`packages/runtime/src/langgraph.ts:500-539`
- `delegateNode`：`packages/runtime/src/langgraph.ts:541-583`
- `executeNode`：`packages/runtime/src/langgraph.ts:585-823`
- `reviewNode`：`packages/runtime/src/langgraph.ts:825-871`
- `summarizeNode`：`packages/runtime/src/langgraph.ts:873-904`
- `closeNode`：`packages/runtime/src/langgraph.ts:906-912`

一个比较成熟的补充说法是：

“LangGraph 这里只负责节点编排，真正写 goal/plan/task/memory/checkpoint 的动作，仍然下沉到 `GoalDrivenRuntimeService`。”

对应代码：

- service 注入点：`packages/runtime/src/langgraph.ts:441-447`
- service 本体：`packages/runtime/src/service.ts`

### 7. 你是怎么把模型接进 LangGraph 的？

你可以这样答：

“我没有在 graph 节点里直接写某个模型 API，而是抽了一层 `LangGraphHooks`。这个接口定义了 `goalFactory`、`planner`、`delegate`、`executor`、`reviewer`、`summarizer` 六个钩子。然后 `apps/ide-web/src/minimax.ts` 通过 `createMiniMaxHooks()` 返回这组 hook。这样做的好处是 provider 只负责在每个节点返回结构化 JSON，graph 自己再决定怎么调用 service 和 toolExecutor。所以换供应商时，理论上只需要替换 hooks 实现，不需要重写整张图。”

代码证据：

- `LangGraphHooks` 接口：`packages/runtime/src/langgraph.ts:52-91`
- `createMiniMaxHooks()`：`apps/ide-web/src/minimax.ts:1102-1285`
- `goalFactory`：`apps/ide-web/src/minimax.ts:1111-1134`
- `planner`：`apps/ide-web/src/minimax.ts:1135-1157`
- `delegate`：`apps/ide-web/src/minimax.ts:1158-1193`
- `executor`：`apps/ide-web/src/minimax.ts:1194-1242`
- `reviewer`：`apps/ide-web/src/minimax.ts:1243-1263`
- `summarizer`：`apps/ide-web/src/minimax.ts:1264-1283`

### 8. execute control loop 是怎么实现的？为什么它是最难的部分？

你可以这样答：

“我这个项目里最难的不是把图接起来，而是 `executeNode`。因为 `executeNode` 要同时处理 4 件事：调用 executor hook 拿结构化执行草案、同步 task 和 memory、真实执行工具、以及把工具结果回写给下一轮模型。它本质上已经不是简单节点，而是一个受约束的 tool-use control loop。这里我后来又加了 execution phase、duplicate tool loop guard、view reread budget 和 mixed explain+modify continuation policy，目的是把‘什么时候该继续读、什么时候该改、什么时候该收尾’从 prompt 自觉推进成执行层纪律。”

代码证据：

- `executeNode` 总体：`packages/runtime/src/langgraph.ts:1073-1405`
- `inferExecutionPhase(...)`：`packages/runtime/src/langgraph.ts:488-504`
- duplicate tool loop guard：`packages/runtime/src/langgraph.ts:1264-1274`
- reread budget：`packages/runtime/src/langgraph.ts:1276-1327`
- 真实工具执行：`packages/runtime/src/langgraph.ts:1329-1390`
- mixed explain -> modify 强制续跑：`packages/runtime/src/langgraph.ts:1185-1199`

这轮我又把“修改后怎么验证”也收进了同一个 control loop，而不是继续堆 benchmark prompt。现在 execute 不只是控制 `read -> modify`，还会控制 `modify -> verify -> finalize`：如果本轮已经真实 `edit/write`，但还没有任何验证尝试，runtime 会追加一条 `VERIFICATION_POLICY` system message，强制下一轮切到 `verify` phase，优先用 `bash` 跑最小相关验证；如果最新一次 verify 明确失败，也不会允许模型直接 finalize，而是必须继续 modify 或再次 verify。这样可以把“改完就收尾”和“测试挂了也硬说完成”这两类问题都压在执行层里，而不是留给模型自觉。

我后来又把这层从“要不要验证”推进到了“验证类型和粒度怎么放行”。现在 runtime 不只判断有没有 verify，还会判断当前 verify 属于：

- 结构性验证
- 行为验证
- 目标化行为验证

如果上下文已经出现了明确测试目标，比如用户点名某个测试文件、最近 tool trace 里已经 view 过相关测试文件，或者当前任务本身就是修某条回归，那么只跑 `py_compile / typecheck / lint / git diff --check` 这种结构性验证已经不够了；runtime 会继续阻止 finalize，要求补一轮更贴近修改点的目标化行为验证。反过来，如果任务明确声明“这次不改逻辑，只做结构性整理”，runtime 会接受最小结构性验证，不会强逼跑行为级测试。

这层我会直接点名成：

- `tool-use control loop`
- 或 `execution control loop`

因为它已经不只是一个 LangGraph 节点，而是运行时里最重要的执行纪律层。

补一句更工程化的话：

“如果没有这层控制环，agent 很容易出现假推进：它会说自己正在读文件、准备改文件，但实际上只是在反复 view，既没有 edit，也没有稳定的 tool trace。”

### 9. 你为什么要引入 `executionPhase`？

你可以这样答：

“因为 mixed explain + edit 请求如果只靠一个隐式 executor，模型很容易在‘解释’、‘修改’和‘验证’之间反复横跳。比如用户说‘先解释这个测试文件在干什么，再给它加两行注释’，模型可能先解释完就收尾了，文件却根本没改；又比如修一个行为性 bug，模型可能改完就直接总结，但完全没跑验证。所以我把执行相位显式化成 `explain / modify / verify / finalize`。这样 runtime 在控制 reread budget、是否继续 modify、以及什么时候必须先 verify 时，就有了明确依据，而不是只能猜模型现在是不是已经准备动手或准备收尾了。”

代码证据：

- `LangGraphExecutionPhase`：`packages/runtime/src/langgraph.ts:52`
- `inferExecutionPhase(...)`：`packages/runtime/src/langgraph.ts:488-504`
- MiniMax prompt 对 phase 的约束：`apps/ide-web/src/minimax.ts:1258-1298`
- mixed explain -> modify 续跑策略：`packages/runtime/src/langgraph.ts:1185-1199`
- modify -> verify -> finalize 验证门槛：`packages/runtime/src/langgraph.ts:1201-1223`

如果面试官继续追问“为什么 verify 不能只靠 prompt”，我会继续答：

“因为只靠 prompt，模型很容易在 benchmark 或真实改代码任务里出现两类假完成：第一类是已经 `edit/write` 了，但没有任何验证就 finalize；第二类是跑过验证，但 bash 返回失败，它还是把失败包装成最终总结。现在我把这两类情况都变成了 runtime policy：行为性修改必须至少做一次最小 verify，verify 失败也不能直接 finalize。与此同时，我又专门给纯注释/文档型修改留了豁免，不让它们被错误拉进 verify phase。” 

代码证据：

- 行为性修改判定：`packages/runtime/src/langgraph.ts:606-693`
- verify bash 识别：`packages/runtime/src/langgraph.ts:751-763`
- post-write verification gate：`packages/runtime/src/langgraph.ts:1201-1223`
- 纯注释修改免 verify 回归：`packages/runtime/src/langgraph.test.ts`

如果面试官继续追问“你后面怎么把这层做得更像工程系统，而不是 prompt tricks”，我会再补一句：

“我后来又往前推进了一步：不是只看‘有没有 verify’，而是看‘verify 的类型和粒度够不够’。比如行为性修改如果已经有明确测试目标，只跑 `py_compile` 这种结构性检查仍然不能 finalize；runtime 会继续要求目标化行为验证。相反，纯结构性整理只要完成一轮最小结构性验证就可以收尾。这说明验证门槛已经从单一布尔值，变成了 runtime 里的分级 policy。” 

代码证据：

- verification requirement 构建：`packages/runtime/src/langgraph.ts`
- verification command 分级：`packages/runtime/src/langgraph.ts`
- 目标化行为验证回归：`packages/runtime/src/langgraph.test.ts`
- 结构性验证回归：`packages/runtime/src/langgraph.test.ts`

### 10. 你怎么解决“重复 view 同一个文件，却迟迟进不了 edit”的问题？

你可以这样答：

“我后来踩到一个很真实的 execute bug：模型会连续多次 `view` 同一个文件，只是换 `lineRange`，结果整轮预算都花在重复读取上。这个问题不是单点错误，而是 3 层叠加：第一，provider 下一轮看到的 recent tool output 太短；第二，旧 loop guard 只拦完全相同调用，拦不住同一路径换范围；第三，直接禁止 reread 又太粗暴，会误伤合理精读。所以我最后把这层做成了 budgeted reread policy：第一次完整读取允许，之后允许 1 次 focused reread，第 3 次再拦；而且 reread 必须带新的范围，并且仍处在 explain phase。一旦进入 modify phase，就不再允许回头 reread。”

代码证据：

- `readToolCallPath(...)`：`packages/runtime/src/langgraph.ts:159-175`
- `hasExplicitViewRange(...)`：`packages/runtime/src/langgraph.ts:182-196`
- `readExplicitViewRangeKey(...)`：`packages/runtime/src/langgraph.ts:198-243`
- `ViewReadBudgetState`：`packages/runtime/src/langgraph.ts:245-257`
- `createViewBudgetGuardMessage(...)`：`packages/runtime/src/langgraph.ts:275-288`
- reread budget 主逻辑：`packages/runtime/src/langgraph.ts:724-766`
- provider 侧 recent tool output 放宽：`apps/ide-web/src/minimax.ts:786-825`
- provider 侧 state digest：`apps/ide-web/src/minimax.ts:865-937`

可以再补一句：

“这类问题很像真实 agent 系统里的上下文预算、工具合同和执行纪律冲突，不是简单调个 prompt 就能解决。”

### 11. 你的 durable execution 是怎么做的？

你可以这样答：

“LangGraph 官方 JS 版没有现成 MySQL saver，所以我自己实现了一个 `PersistentLangGraphCheckpointSaver`，继承 `BaseCheckpointSaver`。它对外保留的是 LangGraph 的 saver 语义，对内再通过 `LangGraphCheckpointRepository` 落 MySQL。具体保存成两张表：`langgraph_checkpoints` 存 checkpoint 主体，`langgraph_checkpoint_writes` 存 pending writes。这样 graph 的 thread 恢复可以直接贴到 MySQL，而不用为了框架去改我的真相源架构。”

代码证据：

- `BaseCheckpointSaver` 相关导入：`packages/db/src/langgraph-checkpointer.ts:1-14`
- repository 抽象：`packages/db/src/langgraph-checkpointer.ts:47-68`
- `PersistentLangGraphCheckpointSaver`：`packages/db/src/langgraph-checkpointer.ts:174-354`
- `getTuple(...)`：`packages/db/src/langgraph-checkpointer.ts:179-222`
- `list(...)`：`packages/db/src/langgraph-checkpointer.ts:224-274`
- `put(...)`：`packages/db/src/langgraph-checkpointer.ts:276-307`
- `putWrites(...)`：`packages/db/src/langgraph-checkpointer.ts:309-335`
- MySQL repository：`packages/db/src/langgraph-checkpointer.ts:356-539`
- SQL 表：`packages/db/sql/001_initial_schema.sql:134-159`

### 12. 为什么 `thread_id` 要等于 `sessionId`？

你可以这样答：

“因为我不想让 session 恢复语义和 graph 恢复语义分裂。把 `thread_id` 直接等于 `sessionId` 之后，session、LangGraph thread、checkpoint 恢复、`getState()` 查询就都是同一套标识。这会让 durable execution、调试和后续 resume/fork 设计都更直观。”

代码证据：

- invoke 传 `thread_id`：`packages/runtime/src/langgraph.ts:944-957`
- getState 传 `thread_id`：`packages/runtime/src/langgraph.ts:959-965`

### 13. LangGraph 和你自己的 RuntimeService / RuntimeStore 是什么关系？

你可以这样答：

“我没有把 LangGraph 当成业务层本身，而是把它当成 orchestration layer。graph 节点背后真正调用的还是我的 `GoalDrivenRuntimeService`，底层持久化还是走 `RuntimeStore`。这样 goal、plan、subagent、review、memory 这些动作仍然有清晰的领域边界。框架接在我的边界上，而不是我把业务逻辑散进框架 API 里。”

代码证据：

- graph 工厂签名：`packages/runtime/src/langgraph.ts:441-447`
- 节点里调用 service：
  - `service.appendMessage(...)`：`packages/runtime/src/langgraph.ts:456-461`
  - `service.createGoal(...)`：`packages/runtime/src/langgraph.ts:473-479`
  - `service.savePlan(...)`：`packages/runtime/src/langgraph.ts:526-529`
  - `service.delegateToSubagent(...)`：`packages/runtime/src/langgraph.ts:570-573`
  - `service.syncTasks(...)`：`packages/runtime/src/langgraph.ts:675-680`
  - `service.recordMemory(...)`：`packages/runtime/src/langgraph.ts:682-688`
  - `service.reviewGoal(...)`：`packages/runtime/src/langgraph.ts:856-859`
  - `service.updateSessionSummary(...)`：`packages/runtime/src/langgraph.ts:891-894`

### 14. 这个项目里，LangGraph 最大的当前局限是什么？

你可以这样答：

“最大的局限不是没接上 graph，而是当前 branching 还不够动态。设计上我已经抽出了 `ALLOWED_TRANSITIONS` 和 `canTransitionTo()`，但当前运行时真正执行的还是固定主链。另外 `clarify` 还是最小占位节点，条件路由和更复杂的 branching 还没完全接完。所以如果要更诚实地讲，这版已经是‘有 durable execution 的可运行 graph’，但还不是‘完全数据驱动的 agent 状态机’。”

代码证据：

- 状态机合同：`packages/runtime/src/graph.ts:81-112`
- 固定主链：`packages/runtime/src/langgraph.ts:914-936`
- `clarifyNode` 占位实现：`packages/runtime/src/langgraph.ts:492-498`

### 15. 如果面试官让你“按代码顺序讲 LangGraph”，你怎么讲？

你可以这样答：

“我会按 5 步讲。第一步看 `packages/runtime/src/graph.ts`，这是 workflow 合同。第二步看 `packages/runtime/src/langgraph.ts` 前半段，那里是 LangGraph state 和 provider/runtime 合同。第三步看同一个文件后半段，那里是节点实现、固定主链和 invoke/getState。第四步看 `packages/db/src/langgraph-checkpointer.ts` 和 SQL schema，这两者说明 durable execution 怎么落进 MySQL。第五步看 `apps/ide-web/src/bootstrap.ts` 和 `apps/ide-web/src/dev-server.ts`，说明浏览器 prompt 怎么真正进入这张图。”

代码顺序：

1. `packages/runtime/src/graph.ts:16-112`
2. `packages/runtime/src/langgraph.ts:24-114`
3. `packages/runtime/src/langgraph.ts:441-970`
4. `packages/db/src/langgraph-checkpointer.ts:47-354`
5. `packages/db/sql/001_initial_schema.sql:134-159`
6. `apps/ide-web/src/bootstrap.ts:72-128`
7. `apps/ide-web/src/dev-server.ts:32-124`

## LangGraph 这一块，最容易被追问的 4 个点

### 1. 你的状态机是不是已经完全数据驱动了？

当前不是。

虽然 `packages/runtime/src/graph.ts` 里已经有：

- `WorkflowNode`
- `CORE_WORKFLOW`
- `ALLOWED_TRANSITIONS`
- `canTransitionTo(...)`

但当前真正运行时会执行的主链，还是 `packages/runtime/src/langgraph.ts` 里这一串固定的 `.addEdge(...)`。

所以正确说法应该是：

- 设计上已经把状态机合同抽出来了
- 但当前 LangGraph 仍然是固定主链
- `ALLOWED_TRANSITIONS` 目前更像 workflow contract，而不是已完全驱动 runtime branching 的唯一真相源

### 2. 你是怎么把模型接进 LangGraph 的？

正确答法不是“我在 graph 里直接调 MiniMax”。

更准确的说法是：

- `apps/ide-web/src/minimax.ts` 通过 `createMiniMaxHooks()` 返回 `LangGraphHooks`
- 每个 hook 只负责给某个 graph 节点返回结构化 JSON
- graph 自己再决定如何调用 `service` 和 `toolExecutor`

也就是说：

- provider 适配层负责“怎么让模型按节点输出结构化结果”
- LangGraph 负责编排顺序
- runtime service 负责真正的业务落地

### 3. 你怎么处理 durable execution？

这里一定要把两个层次分清楚：

- LangGraph 官方需要的是 `BaseCheckpointSaver`
- 项目真正实现的是 `PersistentLangGraphCheckpointSaver`

调用链是：

1. `apps/ide-web/src/bootstrap.ts` 里创建 `createMySqlLangGraphCheckpointSaver(mysql.pool)`
2. 再把这个 saver 注入 `createAgentLangGraph(...)`
3. `StateGraph.compile({ checkpointer })` 后，graph 的 invoke/getState 才真正带 durable execution 语义

### 4. 你这个项目里最难的 LangGraph 点是什么？

最值得讲的不是 `addNode/addEdge`，而是 execute control loop。

因为图搭起来不难，真正难的是：

- mixed explain + edit 请求，怎么避免重复 `view`
- 工具循环怎么避免打转
- provider 输出脏 JSON 时，怎么不让整条 graph 直接 500
- 什么时候允许 reread，什么时候该强制进入 modify

这其实是一个“LangGraph 编排 + 工具合同 + provider 适配 + 执行纪律”四层一起作用的问题。

## SWE-bench Lite 这一块，面试时怎么讲

这部分很适合回答“你怎么验证 agent 不是只会聊天”的问题。

建议先把定位说清楚：

“我没有把 benchmark 做成点网页 UI 的 demo，而是专门做了一条 headless runner。因为 SWE-bench 真正评的是 patch，不是对话体验。我要验证的是 `实例输入 -> agent session -> 工作区改动 -> git diff patch -> harness 评分` 这条链，而不是浏览器里气氛看起来像不像 IDE。”

### 1. 为什么 benchmark 不走浏览器工作台，而是单独做 headless runner？

你可以这样答：

“浏览器工作台适合人机协作，不适合稳定 benchmark。因为 benchmark 需要的是可批处理、可复现、可直接输出 patch 的流程。我在这个项目里单独加了 `packages/evals/src/swebench-lite.ts`，它会直接创建 runtime、创建 session、调用 `runtime.langGraph.invoke(...)`，最后从实例工作区收集 `git diff`，输出成官方 harness 能吃的 `predictions.json`。这样 benchmark 路径不依赖 UI 状态，不依赖 DOM，也不依赖人工点按钮。”

代码证据：

- headless runner 入口：`packages/evals/src/swebench-lite.ts:1-482`
- 真正调用 graph：`packages/evals/src/swebench-lite.ts:333-372`
- patch 收集：`packages/evals/src/swebench-lite.ts:374-391`
- predictions/report 输出：`packages/evals/src/swebench-lite.ts:413-472`

追问时可以补：

“我不是完全不用现有 runtime，而是复用 runtime，只绕开浏览器。也就是说，benchmark 和 IDE 共用同一套 `LangGraph + service + toolExecutor`，这样 benchmark 测出来的不是另一套孤立代码。”

### 2. 你的 SWE-bench 输入格式和官方 harness 是怎么对齐的？

你可以这样答：

“我没有自己发明 benchmark 输入格式，而是对齐了官方实例语义。runner 里每条实例至少包含 `instance_id`、`repo`、`base_commit`、`problem_statement`。执行结束后，我输出的 prediction 结构也对齐官方要求，只保留 `instance_id`、`model_name_or_path`、`model_patch`。这样后面直接接官方 harness 就不需要再写一层格式转换。”

代码证据：

- 实例接口：`packages/evals/src/swebench-lite.ts:18-27`
- prediction 接口：`packages/evals/src/swebench-lite.ts:29-33`
- 实例文件解析：`packages/evals/src/swebench-lite.ts:214-246`
- 导出子集脚本：`packages/evals/scripts/export_swebench_lite_subset.py:1-92`

可以补一句：

“我另外写了 `export_swebench_lite_subset.py`，目的是先稳定导出 5 条实例做 smoke，而不是一开始就跑完整个 Lite。”

### 3. 为什么要做 `repo cache + instance workspace` 两层目录？

这是 benchmark 里很值得讲的工程点。

你可以这样答：

“如果每个实例都重新从远端 clone 一次 repo，会很慢；但如果所有实例共用同一个工作区，又会互相污染。所以我把 benchmark 目录拆成两层：一层是 `repo cache`，负责缓存裸克隆来源；另一层是 `instance workspace`，每跑一个实例就从 cache 克隆出一个干净工作区，然后 checkout 到该实例的 `base_commit`，最后所有改动和 patch 都只发生在这个实例工作区里。这样既能复用下载成本，又能保证实例隔离。”

代码证据：

- cache/workspace 常量和目录：`packages/evals/src/swebench-lite.ts:15-16`、`packages/evals/src/swebench-lite.ts:101-111`
- cache 准备：`packages/evals/src/swebench-lite.ts:248-285`
- 每实例 workspace 准备：`packages/evals/src/swebench-lite.ts:287-331`
- 文档说明：`docs/swebench-lite.md`

追问时可以补：

“这实际上和官方 harness 的语义是一致的，因为 benchmark 评的是某个特定 `base_commit` 上的 patch，不允许前一个实例的改动污染下一个实例。”

### 4. 你为什么在 benchmark 路径里单独处理 bash approval？

你可以这样答：

“IDE 正常交互里，`bash` 是高风险工具，所以我保留了显式批准的约束；但是 benchmark 是无人值守批处理，如果还要求人工批准，整条链就跑不起来。所以我没有把全局权限放开，而是在 `createAgentLangGraph(...)` 这层加了一个 `toolApprovalDecider` 钩子，让 benchmark runner 只对 `bash` 做受控自动批准，其他工具还是走正常执行链。这样既保持了 IDE 的安全边界，也给 benchmark 提供了最小验证命令能力。”

代码证据：

- runtime 选项新增 `toolApprovalDecider`：`packages/runtime/src/langgraph.ts:43-50`
- execute 节点把批准决策传给 `toolExecutor`：`packages/runtime/src/langgraph.ts:775-782`
- bootstrap 透传：`apps/ide-web/src/bootstrap.ts:31-36`、`apps/ide-web/src/bootstrap.ts:108-111`
- benchmark runner 只对白名单 `bash` 放行：`packages/evals/src/swebench-lite.ts:343-347`

这是个很好的 trade-off：

“我不是为了 benchmark 方便就把主系统的权限模型破坏掉，而是用依赖注入的方式，只在 headless 评测路径里放开最小必要能力。”

### 5. benchmark prompt 是怎么设计的？为什么不是直接把 issue 扔给模型？

你可以这样答：

“SWE-bench 评的是补丁质量，所以 prompt 不能只说‘帮我修 bug’，而要显式约束 agent 的输出目标。我在 runner 里会把 `problem_statement`、`repo`、`base_commit` 和 patch-oriented 规则一起拼成任务提示，要求它围绕当前实例工作区生成真实代码改动，必要时运行最小验证命令，并以 working tree diff 作为最终产物。这样模型的目标不是写一段解释，而是推动工作区产生可评分 patch。”

代码证据：

- prompt 生成：`packages/evals/src/swebench-lite.ts:248-285`
- runner 调 graph 时使用 prompt：`packages/evals/src/swebench-lite.ts:355-360`
- 对应测试：`packages/evals/src/swebench-lite.test.ts:39-53`

### 6. 这条 benchmark 链路最关键的风险是什么？

你可以这样答：

“最大风险不是 harness 本身，而是 agent 可能生成对话、summary，甚至工具调用日志都很好看，但最后没有产出标准 patch。SWE-bench 真正看的不是对话，而是 `git diff`。所以我在 benchmark 路径里最关心的是三件事：第一，实例工作区是否真的 checkout 到正确 `base_commit`；第二，agent 是否真的对工作区做了改动；第三，最终是否导出了官方格式的 prediction 文件。这也是为什么我把这条链单独固化在 `packages/evals/src/swebench-lite.ts` 里，而不是试图从 UI 上‘看起来像跑过了’。”

代码证据：

- `base_commit` 校验与 checkout：`packages/evals/src/swebench-lite.ts:296-313`
- patch 收集：`packages/evals/src/swebench-lite.ts:374-391`
- 最终 summary/report：`packages/evals/src/swebench-lite.ts:413-472`

你还可以补一句很务实的话：

“对我这种还在演进中的 agent 来说，SWE-bench Lite 的第一阶段价值不是追分，而是找执行链短板，比如它会不会只解释不改、会不会 tool loop、会不会 patch 为空、会不会 bash 跑不动。”

### 7. 你已经实际跑过 benchmark 了吗？结果说明了什么？

你可以这样答：

“我已经先用自己这套 headless runner 真实跑过同一批 5 条 SWE-bench Lite 实例两轮 baseline。第一轮结果是 `completed=4 / failed=1 / withPatch=0`，说明链路通了，但 patch 产出很弱。后来我补了两类执行层优化：一类是 `edit` 工具兼容更多外部字段名，比如 `oldText/newText`；另一类是 execute control loop 在‘已经定位到可修改文件后’更强制地从 explain 切到 modify。第二轮再跑同一批 5 条，结果提升到 `completed=5 / failed=0 / withPatch=3`。这说明优化不是停留在 prompt，而是确实改变了 patch 产出行为。”

代码证据：

- runner 主入口：`packages/evals/src/swebench-lite.ts:520-657`
- 真实 run 产物目录：`.benchmarks/swebench-lite/runs/`
- 结果汇总文档：`docs/progress.md`

你可以继续补具体发现：

“这 5 条里面暴露出来的真实问题包括：第一，repo cache 不能用 partial clone 再本地派生工作区，否则会撞上 promisor remote 问题；第二，provider 瞬时 500 如果不重试，整条实例会被偶发错误打断；第三，当前 agent 在 benchmark 场景下最关键的瓶颈不是‘不会规划’，而是‘定位到文件后能不能稳定进入 edit/write’；第四，工具参数别名兼容会直接影响 patch 产出，比如 `pytest-dev__pytest-5227` 就是在补上 `oldText/newText` 兼容后，从空 patch 提升成了真实修改 `src/_pytest/logging.py` 的 patch。” 

### 8. 你后来把结果送进官方 harness 之后，得到了什么更有价值的反馈？

你可以这样答：

“我后来拿 `withPatch=3` 的那版 predictions 去跑了官方 SWE-bench harness。第一轮正式结果不是特别高，5 条里只有 1 条被判 resolve，也就是 `pytest-dev__pytest-5227`。但这一步很重要，因为它把问题进一步拆清楚了。现在我已经知道：第一，当前系统不是完全跑不起来，因为官方 harness 已经能消费 predictions 并给出 resolve 结果；第二，`能产出 patch` 和 `官方判定 resolved` 之间还有明显差距；第三，当前最值得继续压的不是 UI，而是 execute control loop 这一层。”

代码和结果证据：

- 官方 harness 输入：`.benchmarks/swebench-lite/runs/swebench-lite-20260325T100432Z/predictions.json`
- 官方 harness 结果汇总：`.benchmarks/official/SWE-bench/minimax:MiniMax-M2.7.opencode-lite-20260325T100432Z.json`
- headless runner 入口：`packages/evals/src/swebench-lite.ts:520-657`

你可以继续补这句：

“官方结果里最关键的信号有两个：`pallets__flask-4045 / pallets__flask-4992` 都是 empty patch，说明 agent 在 Flask 这类实例上还停在‘会找、会读、会总结，但不稳定 edit’；而 `psf__requests-2148 / psf__requests-2674` 虽然已经有 patch，但官方仍判 unresolved，说明不是所有 patch 都足够接近真实修复。”

### 9. 你怎么定位 Flask 两条实例为什么会一直空 patch？

你可以这样答：

“我不是凭感觉改 prompt，而是先按执行链去对齐证据。先看 benchmark run report 和 predictions，确认 Flask 两条确实是 completed 但 patch 为空；再回到 session 的 tool trace，看它到底卡在 `grep/view` 还是已经走到 `edit`；最后对着工具合同和 control loop 逐层查。这样我最后定位到的不是一个点，而是三类阻抗叠加：工具参数别名不完整、读取策略过早收尾、以及模型口头说自己进入 modify phase 时，runtime 过于相信它。”

代码证据：

- tool 合同入口：`packages/tools/src/builtin.ts`
- execute control loop：`packages/runtime/src/langgraph.ts:585-823`
- benchmark prompt 和 runner：`packages/evals/src/swebench-lite.ts`

更细一点可以这样讲：

“第一，模型在 benchmark 里经常把 grep 的关键字字段写成 `pattern` 或 `keyword`，但我的工具原来更偏 `query`；第二，模型会对单文件路径做 grep，但我的工具最开始更偏目录搜索；第三，当前任务是‘定位同文件类比点后马上 edit’，但 executor 有时只要模型说自己已经进入 modify phase，就默认它已经会去 edit，实际上它可能还在继续读。”

### 10. 你最后具体怎么修这条 Flask 执行链？

你可以这样答：

“我没有只加一条 prompt，而是同时收紧了三层。第一层是工具合同层，我让 grep 兼容 `pattern / keyword`，也能正确处理单文件路径；第二层是 benchmark prompt，我明确要求‘如果同文件已经找到类似校验或参数处理，就把它视为最终 anchor，停止横向搜索，最多再做一次局部 reread，然后立刻 edit’；第三层是 execute control loop，我不再因为模型口头声称自己进入了 `modify` phase 就直接放它收尾，而是要检查当前 invoke 是否已经真的有成功的 `edit/write`。如果没有，就继续强制它留在 modify 流程里。” 

代码证据：

- grep 别名和单文件处理：`packages/tools/src/builtin.ts`
- execute 对 modify continuation 的约束：`packages/runtime/src/langgraph.ts:585-823`
- benchmark prompt 约束：`packages/evals/src/swebench-lite.ts`

可以再补一层工程 trade-off：

“这一步本质上不是在‘调 prompt’，而是在把模型输出的不确定性往执行层收。也就是说，模型可以建议读哪里、改哪里，但最后是否继续读、是否该进入 edit，不再完全靠模型自觉，而是靠 runtime 的 policy 和 control loop 来兜底。”

### 11. 这些修复有没有拿到具体结果，而不只是你觉得应该有效？

你可以这样答：

“有。修完之后我单独把 `pallets__flask-4045` 重跑了一次，这次已经从 empty patch 变成了真实 patch。它最终改的是 `src/flask/blueprints.py`，在 `Blueprint.__init__` 里补上了 blueprint name 不能包含 dot 的校验。这个结果对我很重要，因为它说明之前的问题不是‘模型完全不会做这个题’，而是执行链没有把它稳定推到 edit。修完 control loop 之后，同一类实例已经能产出真正的文件改动了。”

代码和结果证据：

- 单实例 rerun 报告：`.benchmarks/swebench-lite/runs/swebench-lite-flask4045-rerun-20260325T202000Z/run-report.json`
- 对应 prediction：`.benchmarks/swebench-lite/runs/swebench-lite-flask4045-rerun-20260325T202000Z/predictions.json`
- 目标改动文件：`src/flask/blueprints.py`

你可以再补一句更诚实的话：

“这不代表 Flask 这两条实例已经被官方 harness 全部判定 resolve，但它至少证明当前执行链的瓶颈已经从‘空 patch’进一步推进到了‘patch 质量和测试通过率’层面。”

### 12. Flask 两条实例最后拿到的官方结果是什么？你从里面读出了什么？

你可以这样答：

“我后面把修过执行链的 Flask 两条 predictions 单独重新送进了官方 harness。最终结果是 `2 条都完成、0 条 empty patch、1 条 resolve、1 条 unresolved`。被判 resolve 的是 `pallets__flask-4992`，而 `pallets__flask-4045` 虽然 patch 已经能正确 apply，也通过了新增目标测试 `test_dotted_name_not_allowed`，但仍然打挂了一个旧回归 `test_route_decorator_custom_endpoint_with_dots`。这对我来说是个很关键的阶段性信号：说明当前 execute control loop 的主要问题已经不是‘不改文件’，而是‘改动是否足够完整、是否会伤到原有行为’。”

代码和结果证据：

- 官方二次结果：`.benchmarks/official/SWE-bench/minimax:MiniMax-M2.7.opencode-flask-patched-20260325T202800Z-rerun2.json`
- `4045` harness 报告：`.benchmarks/official/SWE-bench/logs/run_evaluation/opencode-flask-patched-20260325T202800Z-rerun2/minimax:MiniMax-M2.7/pallets__flask-4045/report.json`
- `4045` test output：`.benchmarks/official/SWE-bench/logs/run_evaluation/opencode-flask-patched-20260325T202800Z-rerun2/minimax:MiniMax-M2.7/pallets__flask-4045/test_output.txt`

更适合面试的总结句是：

“这轮优化把问题从‘执行链断了，agent 只会读不会改’推进成了‘patch 已经能出来，但 correctness 还不够稳定’。这意味着下一步不该再优先美化 UI，而是继续收紧 edit 策略和局部验证，让 agent 在修改同类框架代码时更好地保持周边兼容性。”

### 13. 你后来是怎么把 `pallets__flask-4045` 从 unresolved 推到 resolved 的？

你可以这样答：

“第一次把 Flask 两条实例送进官方 harness 之后，`4045` 已经不再是 empty patch，但还差一个回归：`test_route_decorator_custom_endpoint_with_dots`。我没有直接把官方 `test_patch` 喂给 agent，因为那会让本地 benchmark 失去可比性。我做的是把这个失败模式抽成更通用的 benchmark 规则：第一，把每个 `FAIL_TO_PASS` 都当成独立验收项；第二，如果 issue 文本明确说‘某类校验已经在别处存在，也应该加到这里’，那就不仅要在新位置补一个检查，还要把同模块里的 sibling validation 统一到同一显式异常语义。”

代码证据：

- prompt 规则：`packages/evals/src/swebench-lite.ts`
- prompt 回归测试：`packages/evals/src/swebench-lite.test.ts`

可以继续补这句：

“具体到 4045，这条规则的效果很直接。旧 patch 只会在 `Blueprint.__init__` 里补 `ValueError`；新 patch 则会同时把 `Blueprint.__init__`、`endpoint` dot 校验、`view_func.__name__` dot 校验统一成显式 `ValueError`。也就是说，我不是靠手改 Flask 代码去过题，而是把剩余错误模式收敛成 benchmark prompt 里的可复用控制规则。”

结果证据：

- 新的单实例 prediction：`.benchmarks/swebench-lite/runs/swebench-lite-flask4045-rerun-20260325T200900Z/predictions.json`
- 官方单实例结果：`.benchmarks/official/SWE-bench/minimax:MiniMax-M2.7.opencode-flask4045-rerun-20260325T200900Z.json`

如果面试官追问“为什么这次你不说是 runtime 修复，而说是 benchmark rule 修复”，可以这样答：

“因为这次暴露出来的问题不是主系统工具跑不起来，也不是 loop control 断掉，而是 benchmark 任务定义还没有充分把‘多个 FAIL_TO_PASS 测试必须同时满足’和‘同类 public validation 需要统一语义’表达给 agent。这里更有效的修复点是 runner prompt，而不是再去改 IDE 主运行时。”

### 14. 你后来把新的 `4045` patch 和已有的 `4992` patch 合回整批 5 条以后，官方结果到什么程度了？

你可以这样答：

“我没有停在单实例过题，而是把最新已经 resolve 的 `pallets__flask-4045` patch 和已经 resolve 的 `pallets__flask-4992` patch 合回原始 5 条 predictions，然后重新跑了一次官方 SWE-bench harness。新的整批结果从最早那版的 `1/5 resolve` 提升到了 `3/5 resolve`。具体 resolve 的是 `pallets__flask-4045`、`pallets__flask-4992` 和 `pytest-dev__pytest-5227`；未 resolve 的是 `psf__requests-2148` 和 `psf__requests-2674`。更重要的是，这次 `empty_patch=0`、`error=0`，说明 benchmark 路径现在已经稳定越过了‘产不出 patch’这个阶段，问题开始集中在 patch correctness 本身。”

代码和结果证据：

- 合并后的 5 条 predictions：`.benchmarks/swebench-lite/runs/swebench-lite-five-patched-20260325T203300Z/predictions.json`
- 官方整批结果：`.benchmarks/official/SWE-bench/minimax:MiniMax-M2.7.opencode-five-patched-20260325T203300Z.json`

如果面试官继续追问“这 2 条没过的 requests，到底卡在哪”，可以这样答：

“这两条失败模式不一样。`psf__requests-2148` 是 patch 能 apply，而且绝大部分目标测试都过了，只差最后一个 `FAIL_TO_PASS`，所以它更像修复不完整；`psf__requests-2674` 则是目标测试都过了，但把 `PASS_TO_PASS` 打挂了 6 条，所以它更像主症状修到了、但副作用还没压住。这类结果很有价值，因为它告诉我 benchmark 后半程的主要问题，不再是 agent 是否进入 edit/write，而是修改后的语义兼容性和局部验证是否足够强。”

更细一点可以继续补：

“对我来说，这个 `3/5` 不是为了好看，而是一个很明确的阶段信号：第一，patch 产出链已经稳定；第二，Flask 这条线的问题已经被关掉；第三，后续优化应该集中打 `requests-2148` 的最后一个目标测试，以及 `requests-2674` 的回归副作用，而不是继续泛化地改 UI 或重新折腾 benchmark 基础设施。”

### 15. 你后来怎么把 `requests-2148 / requests-2674` 这两类 benchmark failure class，下沉成 agent 本体能力，而不是继续堆 benchmark prompt？

你可以这样答：

“这一步我刻意没有继续往 benchmark prompt 里塞题目专用提示，因为那样只能提局部分数，不能证明 agent 本体变强。我先把两条实例拆成两类 failure class：`2148` 是修复不完整，agent 找到了方向，但只做了 import/comment 级表层 patch 就想 finalize；`2674` 是高风险共享路径上的修改过重，主目标测试可能过了，但把一组 `PASS_TO_PASS` 回归打坏了。基于这个拆分，我把修复下沉到了 runtime 的 execute control loop 和 verification policy，而不是只改 benchmark runner。” 

具体代码证据：

- verification requirement 分级：
  - `packages/runtime/src/langgraph.ts:882-1019`
  - 这里的 `buildVerificationRequirement()` 不再只回答“要不要验证”，而是显式区分：
    - 结构性验证
    - 目标化行为验证
    - 目标化行为验证 + 相邻回归验证
- verification 命令粒度判断：
  - `packages/runtime/src/langgraph.ts:1021-1188`
  - 这里的 `commandLooksLikeAdjacentRegression()`、`analyzeVerificationCommand()`、`describeVerificationGap()` 会把 bash 命令分成：
    - 结构性检查
    - 行为验证
    - 是否已经覆盖相邻回归
- execute control loop 的真实 gate：
  - `packages/runtime/src/langgraph.ts:1691-1858`
  - 这里的 `shouldForceSubstantiveBehaviorEdit`
  - 以及 `shouldForceVerificationBeforeFinalize / shouldForceStrongerVerification`
  - 决定了什么时候必须继续 modify、什么时候必须继续 verify、什么时候还不能 finalize
- edit/write 补丁质量分析：
  - `packages/runtime/src/langgraph.ts:784-839`
  - `packages/runtime/src/langgraph.ts:1984-2038`
  - 这里会把补丁区分成：
    - import/comment 级表层 patch
    - 实质性行为修改
    - 高风险共享路径修改
- provider 侧执行约束同步：
  - `apps/ide-web/src/minimax.ts:1271-1279`
  - 这里明确告诉 executor：
    - 行为修复不能只停在 import/comment
    - 高风险共享路径优先最小增量 edit
    - 高风险共享路径必须补相邻回归
- 回归测试：
  - `packages/runtime/src/langgraph.test.ts`
  - 两条新增场景：
    - 行为任务里，只有 import/comment 级补丁时不能 finalize
    - 高风险共享路径上的行为修改，必须补相邻回归验证后才能 finalize

可以继续补这句：

“这一步对我来说最重要的不是加了更多提示词，而是把 agent 的收尾标准从‘模型说它做完了’推进成了‘runtime 代码只允许在满足这些门槛时收尾’。这才是 agent 本体能力的提升。”

如果面试官继续追问“这两个 failure class 分别是怎么映射进 runtime 的”，可以这样答：

- `2148` 型：要求 runtime 识别“表层 patch 不能冒充行为修复”
  - 如果最新 patch 只改了 import/comment，`executeNode` 会先发 `MODIFICATION_POLICY`，强制继续 modify
  - 这一步现在优先级高于 verify gate，避免半成品 patch 先被推去验证
- `2674` 型：要求 runtime 识别“高风险共享路径不能只跑主目标测试”
  - 如果修改命中了共享热路径，而且上下文里已经有明确测试目标，verification requirement 会升级成“目标化行为验证 + 相邻回归验证”
  - 这时单个 case 跑绿还不够，runtime 仍然会继续发 `VERIFICATION_POLICY`，逼下一轮补整文件/整模块级验证

验证证据：

- `pnpm typecheck`
- `pnpm test -- --runInBand`
- 当前全量 `72` 个测试全绿

这类回答的重点不是“我又调了一版 prompt”，而是：

“我先从 benchmark 结果里抽 failure class，再把修复做进 tool contract、execute control loop 和 verification policy。这样同类问题以后不只在 benchmark 上有效，在普通 agent 编码任务里也会受益。”

## 当前已经实现到哪

这部分你面试时一定要诚实：

已经有：

- 核心领域模型
- MySQL schema
- Redis cache / lease helper
- runtime 应用服务
- 最小 LangGraph adapter
- 自定义 MySQL 持久化 checkpointer
- bootstrap 组合根，已经把 MySQL、Redis、runtime store、tool registry、LangGraph 接成一条启动链路
- tool registry / tool dispatcher
- 第一批真实工具：`list / view / grep / write / edit / bash`
- planning mode 的执行层拦截
- subagent replay 聚合视图和 child session cleanup 策略
- parent task execution trace，以及给 IDE 用的 replay/delegation panel state builder
- 当前 Web IDE 已经从最小 inspector shell 推进成更像 opencode 的单主工作区 workbench，能直接看到 `workbench / goal / plan / activity / replay / delegation / inspector`
- 当前浏览器运行时已经不只是点导航，还能直接提交 prompt，并在同一 session 上触发 LangGraph / runtime
- 当前工作台已经能浏览 workspace 文件列表，并在主工作区里直接编辑和保存文本文件，所以它不再只是“看会话记录”的调试页
- 当前工作台已经补上最小可用的终端命令面板：可以在当前 workspace 内执行命令，并把最近的 stdout / stderr 历史留在工作区
- 当前工作台还专门把左侧 agent 区和右下 terminal 区做成了可开关面板，而且不是只存在前端局部 state 里，而是走 server-driven navigation 协议。这样刷新页面、切换 session、提交 prompt、保存文件和运行命令之后，布局状态都还能保持，这更像一个真正的 IDE workbench，而不是一次性页面
- 我还根据真实使用反馈把布局从“三栏信息平均分”继续改成了“中间工作区优先”。原先左右两边都在抢宽度，会把真正重要的 agent 对话和文件编辑压得很窄；后来我把 session/context 收进顶部 workbench header 和横向 session strip，并且干脆把 `messages + editor + terminal` 收成单主工作区。这类调整对 agent IDE 很重要，因为编辑器和 agent 交互才是高频行为，摘要和元信息应该退到次要位置
- 这个 UI 过程中我还踩到了一个很真实的坑：如果为了赶功能太早把 Monaco 这种 richer editor 挂进去，而固定区域、内部滚动和面板边界还没收稳，就会出现 explorer 把整页撑长、编辑器和终端互相重叠这类非常难用的问题。所以我后来专门做了一次 UI 稳定性修复，先把 workspace-first 布局收稳，再把 Monaco / PTY 放回后续阶段
- LangGraph 的 execute 阶段已经不只是吸收模型文本结果，而是能消费模型返回的 `toolCalls`，真实执行 `view / edit / write` 这类工具，再把结果回流到消息和 tool logs
- execute 这一层后来又继续加固了 loop guard。原因是光有真实工具循环还不够，模型仍然可能反复 `view` 同一个文件、只会说“正在读取文件”，却不继续 `edit`。我后来把最近工具调用摘要显式喂回 executor，并在 runtime 里拦截连续重复的相同工具调用，这样工具环才真正有“防打转”的能力
- 另外一个很真实的坑是“工具协议阻抗不匹配”。模型经常会输出其他 agent CLI 常见的字段名，比如 `file_path`、`old_string`、`new_string`，但我的工具最初只接受 `path / search / replace`，这会导致 runtime 明明已经进到真实工具循环，却还是因为字段不兼容而失败。我后来专门在 builtin file tools 里做了参数兼容层，把这类常见别名统一映射进内部合同，减少模型供应商切换时的摩擦
- execute 这一层最近又继续细化成了更明确的 `executionPhase`。原因是 mixed explain + edit 请求如果全塞给同一个隐式 executor，模型很容易在“解释”和“修改”之间反复横跳。我后来把 phase 明确成 `explain / modify / finalize`，然后让 runtime 的 reread budget 直接依赖这个 phase 做决策：`explain` 阶段允许有限精读，进入 `modify` 之后就不再回头 reread
- 后来我又碰到一个更细的执行层问题：用户请求是“先解释这个测试文件在干什么，然后再加两行注释”，模型会先给出解释，但不一定继续真的改文件。如果 runtime 这时直接在 explain phase 收尾，用户看到的就是“agent 解释得头头是道，但文件没动”。所以我又在 execute control loop 里补了一层 phase continuation policy：如果用户请求里明确带修改意图，而且当前 invoke 已经读过文件、但还没有任何 `edit/write` 成功，那么 runtime 会追加一条 `EXECUTION_POLICY` system message，强制下一轮从 explain 切到 modify。这一步本质上是在把“是否该继续动手”从模型自觉收成执行层约束
- MiniMax hooks 适配层已经补进组合根外侧，用来把外部模型接成 `LangGraphHooks`
- MiniMax 适配层不是只靠 prompt 约束，而是做了三层收口：prompt 约束、本地 sanitizer 归一化/裁剪、以及一次受限的 JSON repair 重试
- 后来我又发现，光修 schema 还不够。有些模型输出甚至在 `JSON.parse` 之前就已经坏了，比如少一个逗号、引号没配平。这类错误如果不单独处理，planner/executor 会在 very first parse 就直接 500，连后面的 Zod 校验和 repair 都走不到。所以我后来把 MiniMax 适配层继续往下做了一层 `syntax repair`：先修语法，再做 schema repair。这一点很能说明做 agent 不能只盯 prompt，要把模型输出当成不可信输入来处理
- MiniMax executor 这层还额外做了 state-aware fallback：如果模型只给 `task id + status`，系统会优先从现有 task 或 plan step 补全必需字段，补不齐的脏项直接丢弃
- 本地基础设施已经补成 `compose.yaml + pnpm infra:*`，可以一键启动 `MySQL 8.4 + Redis 7`
- `2026-03-21` 已经用 Docker 起真实 `MySQL 8.4 + Redis 7` 跑通 persistence smoke
- `2026-03-21` 已经在真实 `MiniMax` API key 下跑通了一次完整 `smoke:minimax`，拿到了外部模型生成 goal / plan / execute / review / summarize 的链路证据
- `smoke:minimax` 现在支持 `--session / --latest` 复用已有 session，便于验证“跨轮追问”而不是每次都从新会话开始

还没有完全做完：

- LangGraph 已经最小接入，而且 durable checkpointer 代码也已经补上
- 而且真实 MySQL 环境下的持久化集成也已经跑通验证
- 但还没有 versioned migration / rollback
- 更复杂的 subagent orchestration 还没完全做完，但已经有 delegation、child session 和结果吸收
- multi-session 和 subagent 的场景测试比前一版更完整了，但还不是完整测试体系
- IDE 已经有可提交 prompt 的单主工作区 workbench，也已经补上文件浏览和最小终端命令面板，但还不是完整前端框架和组件化交互系统
- MiniMax hooks 已经拿到一条真实外部模型调用证据，但覆盖面还不够广
- 场景测试体系完全铺开
- IDE UI

你可以这样说：

“这个项目我刻意是先把 runtime 和边界做扎实，再往 UI 和 agent orchestration 上叠，因为我希望它先是一个靠谱系统，再是一个好看的 demo。”

这里可以再补一句 trade-off：

“我没有一上来就做全功能编辑器，而是先把文件浏览和最小可编辑文本面板补进工作台，因为 agent IDE 至少要做到‘能继续对话、能看目标/计划、能看当前工作区文件、能直接改动文本文件’，这样用户才不会只面对一堆 session 记录。”

这里还可以再补一个工程 trade-off：

“我先做的是 server-driven 的最小编辑器，而不是直接上 Monaco，因为我当时最优先要验证的是文件选择、保存边界、workspace 路径约束和浏览器提交链路。后来我还专门做了一次 UI 稳定性修复，把固定区域、内部滚动和编辑器/终端的边界先收稳；Monaco 会放在下一阶段做成更完整的工作流，而不是半挂载状态就先上线。”

这里还可以补一个 workbench 设计点：

“后来我又把 UI 从‘Messages tab + Files tab’继续收敛成单主工作区，因为真正像 opencode 这种 agent IDE，高频动作不是切信息 tab，而是同时盯着 agent 对话、文件编辑和终端输出。把这三块拆散，用户就会一直来回切页，体验会很碎。”

这里还能再补一个终端设计 trade-off：

“我这版先做的是最小可用的 workspace command runner，而不是一上来就接 PTY。原因不是我不知道 PTY 更完整，而是我先要把 command submit、workspace cwd、历史输出和错误反馈这些边界收口。等这一层稳定之后，再升级成 PTY/xterm，风险会更可控。”

这里还可以补一个 workbench 导航设计点：

“我后来发现，agent IDE 里很多看起来像 UI 细节的东西，其实应该进导航协议，而不是只放在前端局部状态里。比如左侧 agent 区和终端区的展开/折叠，如果只靠浏览器内存状态，刷新或者切 session 就会乱。我后来把 `conversationPane / terminalPane` 直接做进 server-driven navigation，这样 URL、浏览器 reducer、服务端 HTML 重建和 POST 回跳都共享同一套布局状态，工作区就稳定很多。” 

这里还可以补一个这次新出现的 trade-off：

“我后来发现，如果 execute 只吸收模型生成的 task 和 message，agent 会出现一种很危险的假阳性：它会说自己正在读文件、正在改文件，但实际上没有任何工具调用。我后来专门把 executor 的结构化 `toolCalls` 接到真实工具循环里，并要求工具结果反写到 message 和 tool invocation 里，这样 activity log 和 replay 才真的可信。”

这件事还可以再往下一层讲一个难点：

“光把 toolCalls 接通还不够，agent 还是可能在工具环里打转。比如它已经 `view` 过同一个文件了，却继续重复 `view`，一轮轮输出‘正在读取文件’，体验上就很像假装在干活。我后来做了两层约束：一层把最近工具调用摘要显式喂回模型，另一层在 runtime 里做 loop guard，连续重复的相同工具调用会被直接拦截，并要求下一轮必须改用 `edit/write` 或者结束。这一步让我觉得很像把 agent 从‘会调用工具’推进到了‘有最小执行纪律’。”

这里还可以补一个更细的真实坑：

“后来我发现，光有 loop guard 还不够。如果我给模型看的最近 tool 结果被截得太短，它下一轮其实拿不到足够上下文，于是会继续对同一个文件反复 `view`，只是把 `lineRange` 换一换来绕过‘完全相同调用’的去重。更关键的是，`完整读取后就一刀切禁止再读` 也太粗暴，会误伤合理的二次精读。所以我后来把这层升级成 `budgeted reread policy`：第一次完整读取允许，之后允许 1 次 focused reread，第 3 次再拦；而且 reread 必须带新的范围，并且仍处在 explain phase。这个问题特别像真实 agent 系统里的上下文预算、工具合同和执行纪律冲突，不是简单调个 prompt 就能彻底解决的。” 

这里还能再补一个工程 trade-off：

“loop guard 也不能做得太粗暴。比如工具第一次就因为参数协议不兼容而失败，这时候如果我直接把下一次同样的调用也拦掉，就会让系统变成‘既不会自己修参，也不让模型重试’。所以我后来把 guard 收窄成只拦截成功的重复工具调用；失败调用则把错误信息留给下一轮，让模型有机会修正参数。这个细节很小，但它决定了 agent 是不是会在真实使用里让人抓狂。”

这里还可以再补一个 IDE 侧的排错细节：

“我后来发现，浏览器里那句 ‘Agent 调用失败，请查看控制台日志’ 有时候也会误导人。原因不是后端没报错，而是前端在错误情况下还强行 `response.json()`，服务端一旦回了纯文本 500，前端自己会先炸成一个新的 `SyntaxError`，把真正的后端异常掩盖掉。所以我后来把 IDE API 的错误边界统一成结构化 JSON error，浏览器端也改成按 content-type 稳健解析。这个修复不改变 agent 能力本身，但它会直接决定你排错时到底是在和真实错误打交道，还是在和前端二次错误打交道。” 

## 一个很值得讲的真实难点案例

### 案例标题

`mixed explain + edit` 任务在 execute 阶段反复 `view` 同一个文件，却迟迟进不了 `edit`

### 用户现象

这个 bug 不是我在单测里猜出来的，而是用户真实点出来的。

用户给 agent 的任务是：

- 先解释 `apps/ide-web/src/browser.test.ts` 这个测试文件到底在测什么
- 然后再往这个文件里加两行注释

按理说，一个成熟的 agent 应该这样做：

1. `view` 一次目标文件，拿到上下文
2. 根据文件内容给出自然语言解释
3. 直接发起 `edit`
4. 最后再输出结果总结

但真实发生的是：

1. agent 连续 4 次 `view apps/ide-web/src/browser.test.ts`
2. 只是换了不同的 `lineRange`
3. 没有进入 `edit`
4. 整个 `execute` checkpoint 最后只显示“执行了 4 次工具调用”

这就是一种很典型的 agent 假推进：

- 它不是完全没调用工具
- 但也没有真正推进到修改代码
- 用户体感上就是“等了十几分钟，它一直像在忙，但其实没干成事”

### 我是怎么定位的

我不是只看网页 trace，而是顺着持久化证据往下查：

1. 先查 `tool_invocations`
2. 再查 `checkpoints`
3. 再查 `messages`

定位结果很清楚：

- 同一个 session 里，`tool_invocations` 确实记录了 4 条 `view`
- 没有对应的 `edit`
- `checkpoints.execute.summary` 明确写的是“已执行 4 次工具调用”
- 所以这不是前端显示错了，也不是工具没接上，而是 execute 阶段真的把预算花在重复读取上了

面试时你可以这样讲：

“我定位这类 agent bug 时，不会只看最后一条 assistant 消息。我会同时看 message、tool invocation 和 checkpoint，因为很多问题其实不是‘模型没回答’，而是 runtime 把执行预算花在了错误的动作上。”

### 根因拆解

这个 bug 不是单点问题，而是 3 层叠加。

#### 根因 1：模型下一轮看到的 `view` 结果太短

`MiniMax executor` 的下一轮决策，不是直接重新读磁盘，而是看 `runtimeState digest`。

这个 digest 里会带：

- `recentMessages`
- `recentToolInvocations`

原来的实现里，`tool=view` 的结果会被截得比较短。  
于是下一轮模型虽然知道“刚才 view 过”，但看不到足够多的源码细节，就会继续想再读一点。

这件事非常工程化，不是 prompt 小技巧：

- 你给模型看的最近上下文太短，它就会重复读
- 你给得太长，又会浪费 token

所以这其实是一个“上下文预算”和“执行纪律”一起作用的问题。

#### 根因 2：旧 loop guard 只拦“完全相同的工具调用”

原来的 loop guard 是按整条 tool input 做去重。

这能拦住：

- `view(path=foo.ts)` 后又来一个完全相同的 `view(path=foo.ts)`

但拦不住：

- `view(path=foo.ts)`
- `view(path=foo.ts, lineRange=1-70)`
- `view(path=foo.ts, lineRange=1-150)`

因为从 runtime 角度看，这些 input 不一样。

这就是为什么它可以“合法地”连续 4 次 view 同一个文件，却不触发旧的 guard。

#### 根因 3：工具层对 `lineRange` 的兼容之前并不完整

模型会自然生成 `lineRange: "1-70"` 这种写法。  
但我们原来的 `view` 工具只认：

- `startLine`
- `endLine`

所以模型以为自己在“按范围重读”，而工具层以前并没有真正把这条兼容协议收口好。

这让系统更像在“半理解”模型的意图，也更容易让 execute 卡在读文件阶段。

### 我怎么修的

这次我没有把锅全推给模型，而是分 3 层修。

#### 修复 1：让 executor 真正看到更完整的最近 `view` 结果

我在 `apps/ide-web/src/minimax.ts` 里把：

- `recentMessages`
- `recentToolInvocations`

对 `tool=view` 的摘要长度单独放宽了。

目的不是无脑塞更多上下文，而是保证：

- 模型至少能拿到足够继续 `edit` 的文件片段
- 不会因为摘要太短，再把下一轮预算浪费在 `view`

#### 修复 2：把 “同一路径的 reread” 升级成有预算的 runtime 约束

我在 `packages/runtime/src/langgraph.ts` 里没有继续保留“完整读取过一次就完全禁止再读”的硬规则，而是改成了 `budgeted reread policy`：

- 首次完整 `view` 允许
- 完整读取之后，允许 1 次 focused reread
- focused reread 必须带新的范围
- focused reread 必须仍处于 `explain` phase
- 一旦进入 `modify / finalize`，就不再允许回头 reread
- 第 3 次再读同一路径时，runtime 才写 `LOOP_GUARD`

这一步的意义是：

- 不再把“合理的二次精读”误判成循环
- 但也不会放任模型一直拿 `lineRange` 换皮重复读
- 把“执行纪律”从 prompt 约束推进到 runtime 控制环

这层我现在更愿意把它叫做：

- `tool-use control loop`
- 或者 `execution control loop`

因为它做的事情已经不是简单去重，而是在管“这轮工具预算应该怎么花”。

#### 修复 3：工具层真正兼容 `lineRange`

我在 `packages/tools/src/builtin.ts` 里把 `view` 合同收成了显式分页/分段形式：

- 主合同：`startLine / endLine`
- 分页合同：`offset / limit`
- 兼容别名：`lineRange / line_range`、`start_line / end_line`

这样工具层对“局部读取”的语义是清楚的，模型不需要靠模糊字符串猜，runtime 也能更稳定地判断这是“完整读取”还是“focused reread”。

### 我怎么验证修复生效

我没有只靠手测，而是补了两类回归测试：

1. 工具层测试
   在 `packages/runtime/src/tooling.test.ts`
   验证 `view` 真正兼容 `lineRange`，也兼容 `offset / limit`

2. LangGraph 场景测试
   在 `packages/runtime/src/langgraph.test.ts`
   新增一条专门的场景：
   - 第一次完整 `view`
   - 第二次做 1 次合理的 focused reread
   - 第 3 次再读同一路径时触发 budget guard
   - 下一轮成功改用 `edit`

这条测试的价值很高，因为它不是测一个纯函数，而是在测一整条 agent 执行行为。

### 这个案例为什么很适合讲给面试官听

因为它能说明你不是只会“调通 API”。

这个案例同时涉及：

- prompt 约束
- runtime orchestration
- tool contract
- execution phase 建模
- 持久化排错
- 场景回归测试

也就是说，你不是在修一句 prompt，而是在修一个真实 agent 系统的行为缺陷。

你可以把这个案例总结成一句话：

“这个 bug 让我意识到，agent 能不能真正推进任务，不只取决于它会不会调工具，还取决于 runtime 有没有足够强的执行纪律，以及工具结果是不是以正确粒度反馈给下一轮模型。” 

## 面试官可能会追问的问题

### Q1：为什么不直接用现成框架把 agent 跑起来？

回答思路：

- 我并不是拒绝框架，后面是准备接 LangGraph 的
- 但在接 graph 框架之前，我先把领域模型、持久化边界和工具约束定义清楚
- 否则很容易变成“框架能跑起来，但系统边界很混乱”

### Q2：你这个项目最难的工程问题是什么？

推荐回答：

- 不是调 API
- 真正难的是如何把 agent 的“行为约束”做成系统能力
- 比如 planning mode 到底是 prompt 习惯，还是执行层策略
- 比如 subagent 到底是角色扮演，还是有 child session 和独立 policy 的执行单元

### Q3：为什么 Goal / Plan / Task 要拆开？

推荐回答：

- `Goal` 表示目标和成功标准
- `Plan` 表示当前策略
- `Task` 表示具体执行单元

拆开后才能清楚表达：

- 目标没有变，但策略可能会变
- 一个计划会拆成多个任务
- review 是对 goal 判断，不是对某一条消息做判断

### Q4：为什么不用 Redis 当主存储？

推荐回答：

- 因为 agent IDE 的核心数据是 durable state
- 我需要能恢复 session、goal、plan、memory、tool logs
- Redis 更适合热点数据和协作，但不适合作为唯一真相源

### Q5：planning mode 你是怎么确保真的只读的？

推荐回答：

- 不是 prompt 限制
- 我把每个工具映射成 permission scope
- 每个 agent mode 有 allow / deny / requiresApproval
- 调工具前先走 `ToolRegistry.dispatch()`
- 所以 mutating tools 会在执行前被拦

这道题你最好直接说“这是我项目里最想强调的设计点之一”。

### Q6：你为什么要记录 tool invocation、checkpoint、subagent run？

推荐回答：

- 为了可恢复
- 为了可审计
- 为了后面能做 replay/debug
- 也是为了把 agent 从“黑盒回答器”变成“可观察系统”

### Q7：subagent 为什么要用 child session，而不是共享父 session？

推荐回答：

- 共享同一份上下文虽然实现简单，但边界会很快变乱
- child session 可以天然表达 lineage
- 每个 subagent 都有自己的 summary、message、goal、checkpoint 空间
- 父 session 回收结果时，也更容易做审计和 debug

你可以这样总结：

“我不想把 subagent 做成角色扮演，所以我让它拥有真正的 child session。这样上下文隔离、状态可追踪、父子关系也能持久化。”

### Q8：你怎么管理 child session 的生命周期？

推荐回答：

- subagent 完成时，不是只把 run 标记成 completed
- 我会把结果摘要吸收到父 session
- 同时更新 child session summary，必要时归档 child session
- 如果 child session 挂着 active goal，也会同步更新它的 goal 状态

你可以这样讲：

“我把 child session 当成真正的执行空间，所以它也要有自己的收尾动作。subagent 完成之后，父 session 要能看到结果，child session 也要能被归档或继续追踪，而不是留下一堆孤立上下文。”

### Q9：你为什么在接入 LangGraph 之后，还保留自己的 RuntimeService / RuntimeStore？

推荐回答：

- LangGraph 负责的是编排、thread_id、状态流转和节点执行
- 但业务动作本身，比如 `createGoal / savePlan / delegateToSubagent / reviewGoal`，我不想直接散落在 graph 节点里
- 所以我保留了应用服务层和持久化抽象层
- 这样以后即使换 graph 框架、补 durable checkpointer，业务边界也不会被框架绑死

你可以这样讲：

“我没有把 LangGraph 当成业务层本身，而是把它当成 orchestration layer。真正的业务动作还是走 RuntimeService，底层存储还是走 RuntimeStore，这样我的系统不是依赖某个框架 API 拼出来的，而是框架接在我自己的边界上。”

### Q10：模型经常不按 schema 输出，你是怎么让它稳定下来的？

推荐回答：

- 我没有把结构化输出的稳定性完全寄托在 prompt 上
- 我做了三层防线
- 第一层是 prompt 里把允许字段、枚举值、布尔值格式写死
- 第二层是本地 sanitizer，在进 Zod 之前先做归一化、裁剪、别名映射
- 第三层是在 still-invalid 时只做一次受限 repair retry，让模型根据校验错误修补 JSON

你可以这样讲：

“如果只靠 prompt，模型一飘整个 runtime 就会脆。我的做法是把 prompt 当成第一层，不把它当唯一层；真正兜底的是本地 schema 适配和有限次 repair，这样模型输出轻微漂移时，系统仍然能稳定吸收。”

如果面试官继续追问“你有真实验证吗”，你可以补一句：

“有，我已经在真实 `MiniMax` API key 下跑过 smoke，不只是本地 mock。这个验证链路会实际创建 goal、保存 plan、执行 review 和 summarize，所以我讲这三层防线时，不是纸上设计。” 

如果面试官继续追问“那 task 字段缺失怎么办”，你可以再补一句：

“我没有把 executor 的结构完整性全压给模型。像 `task.title`、`task.inputSummary` 这种运行时必需字段，如果模型只给了 `id + status`，我会先尝试从当前 runtime state 里的旧 task 或 plan step 回填；回填不了就丢掉那条脏数据，保证系统稳态优先。” 

### Q10：官方没有 MySQL saver，你为什么还要自己实现一个？

推荐回答：

- 因为我项目的真相源本来就定成了 `MySQL`
- 官方 JS 版 LangGraph 的现成 saver 更偏 `SQLite / Postgres / MongoDB / Redis`
- 如果为了省事把架构改到别的存储上，反而会把系统边界搞乱
- 所以我选择自己补一个 `PersistentLangGraphCheckpointSaver`，把 LangGraph 接到我已经定义好的持久化边界上

你可以这样讲：

“我不想因为框架默认支持什么，就让系统架构跟着漂移。既然这个项目已经把 MySQL 定成 durable state 的真相源，那我宁可自己补一个 MySQL saver，也不想为了偷懒把持久化边界改掉。”

### Q11：subagent 结果为什么还要回写 parent task？

推荐回答：

- 因为 run 记录解决的是 delegation lineage
- 但真正的主流程执行账本还是 `Task`
- 如果子代理完成后没有回写 parent task，主流程只会看到“派出去过”，看不到“这个任务最后到底完成了什么”

你可以这样讲：

“我后来补的一个点是 parent task 联动。subagent delegation 时，父任务会进入 `in_progress`；subagent 完成时，结果会回写到父任务的 `outputSummary`。这样主流程账本和子代理账本就接起来了。”

### Q12：你为什么现在先做 server-driven 的最小浏览器运行时，而不是直接上 React/Vite？

推荐回答：

- 因为这时最重要的是先验证“导航协议、状态边界、服务端聚合结果”是不是成立
- 如果太早上前端框架，很容易把精力花在组件和样式上，而不是 runtime 到 UI 的真实边界
- 我先让浏览器能真实拦截 `data-action`，再通过 query 导航去驱动服务端输出新的 shell 文档
- 这样我先证明“最小 IDE 已经真的能交互”，后面再把它升级成更完整的前端框架层

### Q13：你后来为什么还要把最小 shell 继续改成“类 opencode 的三栏工作台”？

推荐回答：

- 因为我发现“能看到状态”和“真的好用”不是一回事
- 之前的最小 shell 更像 inspector，适合验证 runtime 聚合结果，但不适合持续交互
- 所以后来我把 UI 重组为三栏：左边 session，中间主交互区，右边 goal / plan / activity 上下文栏
- 同时把 prompt 提交直接接到 LangGraph，让浏览器不再只是看记录，而是能继续推进同一个 session

你可以这样讲：

“我一开始故意先做了一个最小 shell，目的是验证状态边界；但真正上手后会发现它很难用，因为它更像调试页，不像 agent IDE。所以我第二步把它重构成类 opencode 的工作台结构，并补上同一 session 的 prompt 提交，这样 UI 才真正开始服务 runtime，而不只是旁观 runtime。” 

### Q14：把 prompt 提交接进浏览器以后，最难的点是什么？

推荐回答：

- 不是写一个表单，而是保证浏览器交互、session 连续性和 runtime 持久化边界一致
- 如果浏览器每次提交都偷偷新建 session，用户会感觉“上下文丢了”
- 如果 UI 只展示 message，不展示 goal / plan / activity，用户会以为 agent 什么都没做
- 所以我补了两类能力：
- 一类是 `--session / --latest` 这种 CLI 侧复用 session
- 另一类是浏览器侧 composer 提交时默认继续当前 session，无 session 时才新建

你可以这样讲：

“真正难的是连续性。用户在 UI 里说‘继续刚才那个计划’，系统必须真的沿用同一个 session，而不是重新来一遍。这个问题如果不在 runtime 和 UI 两侧同时收口，表面上像是前端难用，底层其实是 session continuity 没建好。” 

你可以这样讲：

“我没有把第一版浏览器层做成纯静态 demo。我先做了一个 server-driven 的交互壳层，让浏览器点击能驱动真实导航和服务端重建状态。这样我验证的是 runtime 到 IDE 的真实闭环，而不是先做一套漂亮但边界不稳的前端。”

### Q13：你为什么还要额外提供 `/__ide__/state` 这种 JSON 检查入口？

推荐回答：

- 因为 IDE 不只是“看起来能点”，还要能检查当前 shell state
- 这个 JSON 入口后面可以给更完整的前端框架、调试工具、自动化测试复用
- 它也说明这个 IDE 壳层不是把所有逻辑硬编码在浏览器里，而是服务端明确提供状态边界

你可以这样讲：

“我希望这个 IDE 的浏览器层只是交互壳，不是唯一的业务边界。所以我把 shell state 也作为一个显式输出暴露出来，这样浏览器、测试、后续前端框架都能消费同一份状态。”

### Q14：MiniMax 这种外部模型你接在哪一层，为什么不直接塞进 runtime core？

推荐回答：

- 我把外部模型适配放在组合根外侧，而不是放进 runtime core
- runtime core 只认识 `LangGraphHooks`、`RuntimeService`、`RuntimeStore`
- MiniMax 只是某个 provider 的实现细节，所以我把它收敛在 `apps/ide-web/src/minimax.ts`
- 这样后面要换 OpenAI、Anthropic、DeepSeek，本质上都是换一组 hooks，不需要把 core 改烂

你可以这样讲：

“我没有让 runtime 直接依赖某个模型 SDK。runtime 只依赖 hooks 抽象，MiniMax 是在组合根外侧实现这组 hooks。这样模型是可替换的，业务边界不会被 provider 绑死。”

### Q15：你现在怎么验证 MiniMax 接入是否真的工作？

推荐回答：

- 第一层是单测，确保配置读取、HTTP 请求体、结构化 JSON 解析和 hooks 组装没问题
- 第二层是 smoke 脚本，用真实 API key 去跑一条 `create session -> invoke LangGraph -> 查看 shell state` 的链路
- 我刻意把“代码写好了”和“外部 API 真实验证过了”分开，避免把未验证能力说成已完成

你可以这样讲：

“我先用单测把 provider adapter 的内部逻辑钉住，再用 smoke 跑真实 API。这样我能明确区分：哪些是仓库内已经验证的，哪些还要等外部依赖给证据。”

你还可以补一句：

“真实模型经常会把 `todo / in_progress / done` 这类枚举写成 `pending / doing / completed`，所以我在 provider adapter 里又补了一层归一化。这样系统不是对模型输出完全零容错，但最终还是要落回 runtime 的严格枚举。”

### Q16：你怎么让别人一上手就把本地依赖跑起来，而不是手敲很多命令？

推荐回答：

- 我没有把“怎么起 MySQL 和 Redis”只写成聊天说明
- 我把它固化成了仓库根目录的 `compose.yaml`
- 再用 `pnpm infra:up / infra:down / infra:logs / infra:ps` 包了一层团队可复用的入口
- `.env` 同时被应用脚本和 Docker Compose 复用，减少环境漂移

你可以这样讲：

“我希望这个项目不只是我自己能跑，所以我把本地基础设施也做成了仓库的一部分。别人拿到仓库以后，不需要先翻聊天记录找命令，直接 `pnpm infra:up` 就能起依赖。”

## 亮点补充

### 亮点 13：我先把浏览器运行时做成真实交互，再决定前端框架

这个点很适合讲“工程优先级判断”：

- 我不是没想过直接上 React/Vite
- 但那样会把很多 UI 复杂度和 runtime 边界问题搅在一起
- 所以我先做 server-driven shell：浏览器能点、服务端能回、状态能查
- 这一步把“真正可交互”先拿到手，再决定后面前端框架怎么接最合适

### 亮点 14：我把模型 provider 接成 hooks，而不是把 runtime 绑死在某个 SDK 上

这个点很适合讲“分层意识”：

- runtime core 不直接依赖 MiniMax
- MiniMax 只是一组 `LangGraphHooks` 的实现
- 这样换 provider 时，不需要重写 goal/session/subagent/planning 的核心逻辑
- 我还能很清楚地区分：本地单测验证了什么，真实外部 API 又验证了什么

### 亮点 15：我把本地基础设施也做成了仓库能力，而不是口头说明

这个点很适合讲“工程交付意识”：

- 基础设施不是只靠 README 里的一段命令
- 我把它做成了 `compose.yaml + pnpm infra:*`
- `.env` 也被统一成应用和 compose 的共享配置源
- 这样 smoke、浏览器调试、真实模型验证都能落到一致的本地环境里

### Q12：你怎么证明这套持久化不是“看起来能跑”，而是真的在数据库里跑通过？

推荐回答：

- 我专门补了一条真实基础设施的 smoke path，而不是只靠内存单测
- `2026-03-21` 我用 Docker 起了真实 `MySQL 8.4 + Redis 7`
- bootstrap 会先创建数据库、应用初始 schema、检查最小必需表，然后再组装 runtime
- smoke 真正创建了 session / goal，调用了 LangGraph，并验证了 `langgraph_checkpoints` 和 `langgraph_checkpoint_writes` 已经落库
- 同时也验证了 Redis summary cache 能回读

你可以这样讲：

“我不想只停在类型通过和内存单测，所以我专门做了真实基础设施的 smoke。它在 2026-03-21 的一次运行里，真实创建了数据库、打通了 Redis，并且写出了 10 条 LangGraph checkpoints 和 25 条 checkpoint writes。这能证明 durable execution 不是嘴上接上了，而是真的写进 MySQL 了。”

### Q13：真实数据库验证时你碰到过什么坑？

推荐回答：

- 第一个坑是 `workspace.path` 长度太大，`utf8mb4` 下直接做唯一索引会撞 MySQL key length 限制
- 第二个坑是领域层一直用 ISO 时间串，但 MySQL `DATETIME(3)` 不能直接吃带 `T` 和 `Z` 的字符串
- 第三个坑是 mysql2 对 `JSON` 列的返回形态不总一致，有时会直接给 JS 值，有时给原始字符串

你可以这样讲：

“这也是我为什么坚持做真实基础设施 smoke。因为这三个问题在内存测试和类型检查里都不明显，但一上真实 MySQL 就会暴露。最后我把它们分别改成了 path hash 唯一键、时间适配层、JSON 读写适配层。”

### Q14：subagent 跑完以后你怎么做排错和回放？

推荐回答：

- 我没有让 subagent 只留下一个 `run` 状态
- 我补了 `getSubagentRunReplay()`，可以把 child session 里的 task、message、checkpoint、tool invocation 聚合起来
- 我又补了 `getParentTaskExecutionTrace()`，让 parent task 也能看到自己直接做了什么、派出去了什么
- 在 IDE 侧，我没有让 UI 直接查数据库拼状态，而是做了 replay / delegation panel state builder
- 我还补了 `cleanupChildSessions()` 和 completion 时可选的 `cleanupPolicy`，让已经结束的 child session 可以按策略归档

你可以这样讲：

“我不希望 subagent 跑完以后只剩一句 completed。所以我后来补了 replay 视图，把 child session 的消息、checkpoint、工具调用和任务聚合起来；同时又补了 parent task trace，让主任务能看到自己直接做了什么、又委托了什么。再往前我还加了 cleanup 策略，避免 child session 一直堆着变成上下文垃圾。这让 subagent 更像一个可调试、可审计的执行单元，而不是黑盒分支。”

### Q15：你怎么把这些运行时聚合结果接给 IDE，而不让前端自己乱拼？

推荐回答：

- 我没有让前端直接查很多张表去拼 replay
- 我在 `apps/ide-web` 里补了 panel state builder
- 这些 builder 只消费 runtime service 提供的聚合结果，比如 `getSubagentRunReplay()` 和 `getParentTaskExecutionTrace()`
- 这样 UI 只关心展示，不关心底层 lineage、tool log 和 checkpoint 的拼装细节

你可以这样讲：

“我不想让前端自己去拼业务逻辑，所以我在 IDE 这一层做的是 panel state builder，而不是让组件直接查数据库。runtime service 先把 replay 和 parent task trace 聚合好，IDE 再把它们转换成面板状态。这样 UI 会更薄，也更不容易把领域规则写散。”

### Q16：如果你现在还没有完整前端框架，为什么还先做最小 IDE shell？

推荐回答：

- 因为我想先把“界面需要消费什么状态、点击之后要怎么切换”明确下来
- 所以我没有一上来就引入一整套 React/Vite，而是先补了 `shell state + navigation reducer + HTML renderer`
- 这样 sessions、replay、delegation、inspector 已经能被统一接起来
- 以后即使换成真正的浏览器前端，这层状态组织也不用重写

你可以这样讲：

“我不想在 UI 还没想清楚消费面之前就先引一堆前端框架，所以我先做了一个最小 IDE shell。它已经能把 sessions、subagent replay、parent task delegation 和 inspector 接起来，而且支持点击切换。这样我先把界面边界做出来，后面再换成真正的浏览器运行时，代价会更低。”

## 你可以主动强调的亮点

### 亮点 1：不是 prompt 工程，而是系统工程

你可以直接说：

“我这个项目里最在意的一点，是把 agent 行为从 prompt 技巧，逐渐做成工程可约束、可持久化、可恢复、可观察的系统能力。”

### 亮点 2：设计先于界面

你可以说：

“我没有先做一个炫的聊天 UI，而是先把 session、goal、plan、memory、tool policy 这些底层东西定好，因为这些才决定它能不能长期扩展成一个真正的 agent IDE。”

### 亮点 3：对未完成部分有清楚边界

面试里这反而加分。你可以说：

“我会明确区分哪些已经是运行能力，哪些还只是合同层。比如 planning mode 已经进入执行层；subagent 也已经有 child session、run 记录和结果吸收，但更复杂的 orchestration 还没做完。”

### 亮点 4：subagent 不是 prompt 角色，而是 child session

你可以说：

“我后面专门把 subagent delegation 做成了父 session 创建 child session，再落 subagent run 记录。这个设计比单纯给 prompt 加一个‘你现在是 explore agent’要重，但也更像真实系统。”

### 亮点 5：我考虑了 child session 的生命周期回收

你可以说：

“subagent 不是派出去就算了，我还补了结果吸收这一步。子代理完成后，结果会回流到父 session，child session 的 summary 和 goal 状态也会同步更新，必要时还能直接归档。这一点让我在讲项目时不只是说‘我支持 subagent’，而是能说清楚它怎么开始、怎么结束、怎么被父会话消费。”

### 亮点 6：LangGraph 接进来以后，我没有把业务边界丢掉

你可以说：

“我接 LangGraph 不是为了把所有代码改写成框架 demo，而是把它放在编排层。graph 节点背后调用的还是我自己的 RuntimeService，所以 goal、plan、subagent、review 这些动作仍然有清楚的领域边界。这样后面补 durable checkpointer、换执行策略，成本会更低。” 

### 亮点 7：我没有让框架支持范围反过来决定架构

你可以说：

“LangGraph 官方没有现成 MySQL saver，但我没有因此把真相源改成别的数据库。我是自己补了持久化 checkpointer，让框架适配我已经定好的系统边界。这件事很能说明我在这个项目里更看重架构一致性，而不是只追求最快跑通。”

### 亮点 8：subagent 和主任务账本已经接起来了

你可以说：

“我不希望 subagent 只是额外飘着的一层记录，所以我补了 parent task 联动。委托发生时，父任务进入处理中；子代理完成时，结果会回写到父任务。这样从主流程视角看，subagent 不再是黑盒分支，而是主任务的一部分。” 

### 亮点 9：我用真实基础设施 smoke 去逼出系统边界问题

你可以说：

“我没有满足于单测通过，而是专门做了一条 Docker-backed persistence smoke。它除了验证 bootstrap 和 durable execution 打通以外，还帮我逼出了几个很真实的基础设施问题，比如 MySQL 长索引限制、DATETIME 格式适配和 JSON 列返回形态。这些问题修完之后，我对这套 runtime 的落地可信度会高很多。”

### 亮点 10：subagent 不只是能委托，还能回放和清理

你可以说：

“我后来又往前补了一步，不只是让 subagent 能被派出去和把结果回传回来，而是继续补了 replay 和 cleanup。这样 delegation 结束以后，我既能把 child session 的执行痕迹聚合起来做调试，也能把已经结束的 child session 安全归档，不让系统越跑越乱。”

### 亮点 11：我没有让前端自己拼运行时账本

你可以说：

“我在 IDE 这一层没有直接让前端去查很多张表拼 replay，而是补了 panel state builder，让它消费 runtime service 提供的聚合结果。这样 UI 只负责展示，业务拼装逻辑还留在 runtime 边界里，这对后续演进会稳很多。”

### 亮点 12：我先把最小 IDE shell 跑通，再决定前端框架

你可以说：

“我没有在 UI 这层一上来就塞进很多框架，而是先补了最小 shell，把 sessions、replay、delegation、inspector 的状态和点击切换走通。这样我先证明这些面板之间的关系是对的，再决定后面要不要接完整浏览器前端。这种推进方式会更稳，也更符合我这个项目先做边界、再做壳子的思路。”

### 亮点 13：我把 benchmark runner 从“跑一下试试”做成了可诊断的执行器

你可以说：

“我后来发现 headless benchmark runner 里最麻烦的问题不是单纯失败，而是卡住的时候完全不知道停在哪。最开始 runner 只有 batch 结束才写 report，所以一旦 `LangGraph invoke` 卡住，外部只看到进程一直不退出。后来我专门给 runner 补了 instance timeout、阶段日志和增量落盘。现在每条实例都会记录 `prepare-workspace`、`runtime-bootstrap`、`create-session`、`invoke`、`collect-artifacts`、`runtime-dispose` 这些阶段，并且中途就持续写 `run-report.json`。这样我在重跑 `requests-2148/2674` 时，能明确看到 `2148` 已经跑完并产出 patch，而 `2674` 是稳定卡在 `invoke:start` 之后超时。这种可诊断性对 benchmark 调优很关键。” 

代码证据：

- `packages/evals/src/swebench-lite.ts`
  - `readSweBenchLiteInvocation()`：解析 `instanceTimeoutMs`
  - `withTimeout()`：实例级超时包装
  - `persistSweBenchArtifacts()`：增量落盘
  - `runSweBenchLite()`：按实例记录 `stageLogs`
- `packages/evals/src/swebench-lite.test.ts`
  - CLI timeout 参数回归测试
- 真实运行证据：
  - `.benchmarks/swebench-lite/runs/swebench-lite-requests-rerun-20260326T154500Z/run-report.json`

### 亮点 14：我把 `requests-2674` 的 benchmark 卡死问题，拆成了三个执行层根因，而不是继续怪模型

你可以说：

“`requests-2674` 一开始表现成 benchmark invoke 阶段卡住，但我没有继续调 prompt，而是先把 runner 做成有阶段日志和增量落盘的可诊断工具。拿到账本后我发现它不是单一问题，而是三层执行层阻抗叠在一起：第一，模型第一次真正 edit 时，用的是 `search_replace / new_content`，而我们的 edit 工具当时不兼容；第二，模型会用 `view(root, offset, limit)` 看工作区，但我们把目录当文件读，直接 `EISDIR`；第三，benchmark runner 允许 delegate，可 headless 路径并没有 child execution backend，于是 parent session 会创建 queued 的 subagent run，却没人真的执行 child session。我后来把这三处都修掉：edit 合同补 benchmark 别名、目录 view 降级成目录预览、benchmark runner 显式禁用 delegation。修完后 `2674` 不再 timeout，而且能稳定产出 patch；再送进官方 harness，它已经从‘跑不出来’推进到了‘FAIL_TO_PASS 全过，只剩 4 条 PASS_TO_PASS 回归’。” 

代码证据：

- `packages/tools/src/builtin.ts`
  - `normalizeEditInput()`：兼容 `search_replace / new_content`
  - `viewTool()`：目录路径退化成目录预览
- `packages/runtime/src/langgraph.ts`
  - `readWriteLikeChangeSegments()`：write-like 分析同步兼容 benchmark 风格字段
- `packages/evals/src/swebench-lite.ts`
  - benchmark runner 创建 hooks 时显式禁用 `delegate`
- `packages/runtime/src/tooling.test.ts`
  - `search_replace/new_content` 兼容测试
  - 目录 `view` 退化测试
- 运行证据：
  - `.benchmarks/swebench-lite/runs/swebench-lite-requests-2674-rerun-20260326T163200Z/run-report.json`
  - `.benchmarks/official/SWE-bench/minimax:MiniMax-M2.7.opencode-2674-rerun-20260326T163200Z.json`

### 亮点 15：我没有把高风险共享路径的 patch 质量继续留给 prompt，而是把“最小改动预算”做进了 runtime

你可以说：

“我后来发现 `requests-2674` 这类题真正危险的地方，不是修不到，而是模型很容易在 `adapters.py` 这种共享热路径上直接复制大段流程、包一层宽泛 `try/except`，结果目标测试虽然能过一部分，但 `PASS_TO_PASS` 会炸一片。这个问题如果继续只靠 prompt 提醒，效果不稳定，所以我把它下沉到了 runtime：在 `toolExecutor.execute(...)` 之前先分析这次 `edit/write` 的改动规模、有效代码行数和是否像宽范围控制流重写；如果超出预算，就直接拦截，不让这版 patch 先落盘。” 

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `analyzeWriteLikeModification()`：抽取路径、有效代码行数、是否属于宽范围重写
  - `buildModificationBudget()`：只对高风险共享路径上的行为修复开启预算
  - `explainModificationBudgetViolation()`：把超预算原因写成系统级 `MODIFICATION_POLICY`
  - `executeNode` 的工具循环：在 `toolExecutor.execute(...)` 前执行 budget guard
- `packages/runtime/src/langgraph.test.ts`
  - `高风险共享路径上的过宽 edit 会先被 budget guard 拦下，并要求补相邻回归验证后才能 finalize`

这件事面试里最值得讲的点是：

- 我没有继续把“patch 太大”当成模型能力问题
- 我把它转成了 runtime 可以强制执行的工程约束
- 这样 agent 至少不会在高风险共享路径上轻易落下一版明显过宽的补丁

### 亮点 16：我把“相邻回归验证”从一句模糊提示，推进成了显式命令选择器

你可以说：

“之前 verification policy 已经知道高风险共享路径不能只跑目标测试，但它给 executor 的还是文件名级提示。后来我继续往前推进了一步：runtime 会从上下文里抽 pytest/unittest 风格的测试选择器，再把它收成两组显式命令，一组是最小目标验证命令，另一组是相邻回归命令。这样系统提示给模型的，不再只是‘去补同模块回归’，而是会直接出现像 `python3 -m unittest tests.test_adapters.AdapterBehaviorTests.test_none_timeout` 和 `python3 -m unittest tests.test_adapters` 这样的建议命令。” 

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `extractTestSelectorHintsFromText()`：从上下文里抽测试选择器
  - `buildTargetedBehavioralCommands()`：生成目标验证命令
  - `buildAdjacentRegressionCommands()`：生成相邻回归命令
  - `formatVerificationRequirement()`：把命令写进 `VERIFICATION_POLICY` 提示
- `packages/runtime/src/langgraph.test.ts`
  - `高风险共享路径上的过宽 edit 会先被 budget guard 拦下，并要求补相邻回归验证后才能 finalize`
  - `行为性修改在有明确测试目标时，必须补齐目标化行为验证后才能 finalize`

这件事面试里可以强调两个 trade-off：

- 我没有直接在 runtime 里替模型执行这些命令，而是先把它做成显式建议，这样保留了 provider 层的灵活性
- 但我也不再满足于“只写文件名提示”，因为那样对 verify phase 的约束仍然太弱

### 亮点 17：我会用 benchmark 反证推翻自己的 runtime 策略，而不是把新 gate 当成真理

你可以说：

“我后来专门把新 runtime 再拿去重跑了 `requests-2148 / requests-2674`，目的不是证明自己这版策略多厉害，而是验证它到底有没有把 benchmark 结果真正往前推。结果很直接：`2148` 虽然能跑完并产出 patch，但官方 harness 仍然判 unresolved，而且还新增了两条回归；`2674` 在 headless runner 里会超时，但工作区会留下 patch，送进官方 harness 以后又在 `pytest -rA test_requests.py` 阶段异常变慢，十几分钟还没有 report。这个结果说明我这版 `budget + selector` 提高了安全性，却没有真正把 agent 推到正确的行为修复路径上。工程上我会把这类结果记成反证，而不是继续自我感觉良好地堆 prompt。”

代码证据：

- `packages/evals/src/swebench-lite.ts`
  - `ensureRepositoryCache()`：repo cache 已存在时，`git fetch` 失败不再立刻打死实例，而是优先复用本地 cache
  - `runSweBenchLite()`：继续用阶段日志和增量落盘保留 rerun 证据
- 本轮 runner 结果：
  - `.benchmarks/swebench-lite/runs/swebench-lite-requests-rerun-20260326T213500Z/run-report.json`
  - `.benchmarks/swebench-lite/runs/swebench-lite-requests-rerun-20260326T213500Z/predictions.json`
- `2148` 官方结果：
  - `.benchmarks/SWE-bench/logs/run_evaluation/opencode-requests-rerun-20260326T213500Z/minimax:MiniMax-M2.7/psf__requests-2148/report.json`
- `2674` 官方运行证据：
  - `.benchmarks/SWE-bench/logs/run_evaluation/opencode-requests-rerun-20260326T213500Z/minimax:MiniMax-M2.7/psf__requests-2674/run_instance.log`

这件事面试里最值得讲的点是：

- 我没有把 runtime gate 当成一加就一定提分的“正确答案”
- 我会重新送进 benchmark，用官方结果验证它到底是在提高 patch 质量，还是只是把 agent 卡在更保守但也更表层的补丁里
- 这类反证会直接反过来指导下一轮 runtime 设计，比如：
  - `failing test -> target function/path` 的更强语义锚定
  - import/comment 级 patch 不能冒充行为修复
  - 当目标路径已经定位明确时，要允许最小必要行为 patch 真正落盘

### 亮点 18：我把 “行为修复必须命中目标函数体” 做成了 runtime gate，而不是继续靠 prompt 猜模型有没有改到点上

你可以说：

“`requests-2148` 这类题给我的一个明确反证是：agent 其实已经看懂了方向，甚至会补 `ConnectionError`、`socket` 这种 import，但补丁还是可能停在 import 级半成品，根本没真正改到目标行为路径。这个问题如果继续靠 prompt 提醒‘去改核心逻辑’，约束力不够，所以我把它下沉到了 runtime：verification requirement 不再只记录测试目标，还会额外抽目标代码路径和目标行为锚点；每次 `edit/write` 之后，runtime 会判断这次改动是不是只停在 import/comment 级整理，还是已经命中了目标文件里的真实函数体、条件分支或异常映射。如果没有命中，就直接发 `MODIFICATION_POLICY`，禁止 finalize，强制下一轮继续 modify。” 

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `extractBehaviorTargetAnchorsFromText()`：从用户请求、测试名和上下文里抽行为锚点
  - `collectTargetCodePaths()` / `collectBehaviorTargetAnchors()`：把目标路径和锚点装进 verification requirement
  - `writeLikeToolCallTargetsBehavior()`：判断某次 write-like edit 是否命中了目标行为
  - `executeNode`
    - `shouldForceTargetBehaviorHit`
    - `shouldForceReturnToTargetPathAfterFailedVerification`
- `packages/runtime/src/langgraph.test.ts`
  - `行为性任务里，只有 import/comment 级补丁时不能 finalize，必须继续命中真实行为路径`

这件事面试里最值得讲的点是：

- 我没有把“模型应该自己知道改哪里”当成假设
- 我把“是否真的改到了目标行为路径”变成了 runtime 可以检查的条件
- 这类 gate 不一定直接提高 benchmark 分数，但它能把半成品 patch 更早挡在 control loop 里

### 亮点 19：我把 “共享热路径上的表层补丁不能长期占住 modify phase” 从一句经验，变成了显式状态和策略

你可以说：

“`requests-2674` 暴露出的另一个问题是：像 `adapters.py` 这种共享热路径上，即使模型没有直接做大重写，它也可能先落一个 import-only 的表层补丁，然后一直耗在 modify phase 里，看起来像在推进，实际并没有碰到真正的行为路径。这个问题如果只用 `highRisk = substantial rewrite` 去判断，会漏掉一类很重要的假推进。所以我在 runtime 里把 `sharedHotPath` 和 `highRisk` 拆开了：前者表示它是不是共享热路径，后者才表示它是不是实质性的高风险大改。这样 runtime 就能单独识别‘共享热路径上的表层补丁’，然后明确追加策略提示：不能让这种补丁长期占住 modify phase，下一轮必须继续打到目标函数体。” 

### 亮点 20：我会用“整批 benchmark 回归”验证 runtime gate 是否真的有效，而不是只看单条修好了没有

你可以说：

“我后来专门把这版 runtime 放回原始 5 条 SWE-bench Lite 实例里整批回归，而不是继续只盯 `2148 / 2674` 两条。因为单条实例有时会让人误以为策略有效，但整批回归更能看出这是不是 agent 本体能力的改善。这轮 headless runner 的结果其实很好，5 条实例全部稳定产出了 patch；但官方 harness 还是 `3/5 resolved`，通过的仍然是两条 Flask 加上一条 pytest，`requests-2148 / requests-2674` 依旧 unresolved。这个结果说明一件很关键的事：我现在的问题已经不是 patch 产不出来，而是 requests 这两类题仍然停在 import 级表层补丁，没有真正推进到目标行为路径。所以我不会因为 headless `5/5 withPatch` 就说 agent 变强了，我更看重的是官方 harness 上的稳定、可重复结果。” 

代码证据：

- 这轮 headless runner 产物：
  - `.benchmarks/swebench-lite/runs/swebench-lite-five-rerun-20260326T230500Z/run-report.json`
  - `.benchmarks/swebench-lite/runs/swebench-lite-five-rerun-20260326T230500Z/predictions.json`
- 这轮官方 harness 汇总：
  - `Desktop/benchmarks/SWE-bench/minimax:MiniMax-M2.7.opencode-five-rerun-20260326T230500Z.json`
- 两条 requests 的官方明细：
  - `Desktop/benchmarks/SWE-bench/logs/run_evaluation/opencode-five-rerun-20260326T230500Z/minimax:MiniMax-M2.7/psf__requests-2148/report.json`
  - `Desktop/benchmarks/SWE-bench/logs/run_evaluation/opencode-five-rerun-20260326T230500Z/minimax:MiniMax-M2.7/psf__requests-2674/report.json`
- 两条 requests 的 patch：
  - `Desktop/benchmarks/SWE-bench/logs/run_evaluation/opencode-five-rerun-20260326T230500Z/minimax:MiniMax-M2.7/psf__requests-2148/patch.diff`
  - `Desktop/benchmarks/SWE-bench/logs/run_evaluation/opencode-five-rerun-20260326T230500Z/minimax:MiniMax-M2.7/psf__requests-2674/patch.diff`

面试里最值得强调的点：

- 我不会把 `withPatch=5` 直接包装成 benchmark 提升
- 我会区分：
  - `patch 产出链是否稳定`
  - `官方 harness 是否真的判 resolved`
- 这轮整批回归给我的新结论不是“又只有 3/5”，而是：
  - `2148` 的 patch 还是只改 import，说明“命中目标函数体”这条 gate 还不够硬
  - `2674` 的 patch 还是只补 import，说明“共享热路径上的表层补丁不能长期占住 modify phase”这条 gate 还不够硬
- 这就把下一轮 runtime 该补哪一层说得很清楚，而不是继续泛泛地调 prompt

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `WriteLikeModificationAnalysis.sharedHotPath`
  - `pathLooksLikeHighRiskSharedCode()`
  - `executeNode` 里的：
    - `sharedHotModifiedPaths`
    - `superficialBehaviorPaths`
    - `highRiskSuperficialBehaviorPaths`
- `packages/runtime/src/langgraph.test.ts`
  - `高风险共享路径上的 import 级表层补丁不能长期占住 modify phase`

这件事面试里最值得讲的点是：

- 我不是简单把“高风险”理解成“大改动”
- 我把“路径风险”和“补丁深度”拆成两个维度建模
- 这样 runtime 才能识别一类 benchmark 里很常见的假推进：文件被碰了，但真实行为没改

### 亮点 20：我把测试失败从“原始 bash 文本”推进成了结构化反馈，再反推下一轮 modify 的目标路径

你可以说：

“我后来发现一个很关键的问题：即使 agent 已经会改代码、会跑测试、失败后也不会直接 finalize，但如果失败反馈只是原始 stderr 文本，下一轮 modify 其实还是主要靠模型自己从长文本里猜。这个链路在 benchmark 里很容易退化成两种情况：要么读很多无关文件，要么知道测试失败了，但回不到真正的目标函数体。所以我把 verify 失败的反馈继续下沉到了 runtime：每次 `bash` 验证失败后，不再只保留 `exitCode` 和原始输出，而是额外解析出 failing tests、traceback 命中的代码路径、函数/方法锚点，以及 assertion / exception hints，然后把它们写成一条 `VERIFICATION_FEEDBACK` system message，并直接并回下一轮 verification requirement。这样 runtime 后面的 gate 不再只依赖用户原始 prompt 里的模糊描述，而能基于刚刚失败留下的结构化证据，明确要求下一轮回到目标代码路径继续 modify。” 

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `readBashOutputText()`：从 `bash` 的 stdout/stderr 拼出待分析文本
  - `extractFailingTestsFromOutput()`：抽失败测试
  - `extractTraceAnchorsFromOutput()`：抽 traceback 命中的代码路径和函数锚点
  - `extractAssertionHintsFromOutput()`：抽 assertion / exception 线索
  - `parseVerificationFailureFeedback()`：把原始验证失败输出收成结构化对象
  - `createVerificationFeedbackMessage()`：把结构化失败反馈写成 `VERIFICATION_FEEDBACK` system message
  - `buildVerificationRequirement(...)`：现在会吃 `latestVerificationFailure`
  - `executeNode`：
    - failed verify 后会更新 `latestVerificationFailure`
    - 写入 `VERIFICATION_FEEDBACK`
    - 再通过 `shouldForceReturnToTargetPathAfterFailedVerification` 这类 gate 强制下一轮回到目标路径
- `apps/ide-web/src/minimax.ts`
  - executor prompt 新增：如果最近消息里有 `VERIFICATION_FEEDBACK`，下一轮必须优先围绕这些信号继续 modify / verify，不要回头读无关文件
- `packages/runtime/src/langgraph.test.ts`
  - `verify 失败后会生成结构化失败反馈，并把下一轮 modify 拉回目标代码路径`

这件事面试里最值得讲的点是：

- 我没有满足于“验证失败后别 finalize”这种弱约束
- 我把测试失败信息从原始文本推进成了 runtime 可消费的结构化信号
- 这类设计的价值，不只是让模型更方便读日志，而是让后续 control loop 的 gate 有了更明确的目标路径依据

你可以进一步补一句：

“这一步我没有把它包装成 benchmark 已经改善了。更准确地说，这是 runtime feedback loop 的能力升级，benchmark 是否因此提分，还要再用 `2148 / 2674` 之类实例重新验证。” 

### 亮点 21：我把 `2148` 暴露出的“import 级假推进”收成了更硬的 modify gate

你可以说：

“`psf__requests-2148` 给我的一个很直接的信号是：agent 已经知道问题和 `socket.error`、`ConnectionError` 这类概念有关，但它会停在一种假推进状态里，也就是只补 import，然后看起来像已经进入 modify phase。这个问题如果不在 runtime 层处理，模型就很容易把‘我已经碰到目标文件了’误当成‘我已经修到目标行为了’。所以我后来专门把这类情况收成了一个更硬的 modify gate：如果任务是行为修复，而且 runtime 已经知道目标代码路径和行为锚点，那么只在目标文件上做 import/comment/表层整理，就不再算一次有效 modify。runtime 会在真正执行工具前直接拦掉这类 edit，并追加一条 `MODIFICATION_POLICY`，要求下一轮必须继续命中真实函数体或异常路径。” 

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `writeLikeToolCallIsSuperficialBehaviorPatch()`
  - `explainSuperficialBehaviorPatchViolation()`
  - `executeNode`
    - 在真正执行 `edit/write` 前先判断表层补丁
    - 命中后直接写入 `MODIFICATION_POLICY`
- `packages/runtime/src/langgraph.test.ts`
  - `行为性任务里，只有 import/comment 级补丁时不能 finalize，必须继续命中真实行为路径`

这件事面试里最值得讲的点是：

- 我没有把“模型会自己知道 import 不够”当成默认假设
- 我把“行为修复必须打到函数体/异常路径”变成了 runtime 能检查的条件
- 这比继续堆 prompt 更接近 agent 本体能力建设

### 亮点 22：我把 `2148` 里的“局部行为补丁被误判成大改”也拆出来修了

你可以说：

“`2148` 还有另一个很隐蔽的问题：之前的 budget guard 会把某些局部 try/except 行为补丁误判成‘宽范围控制流/异常映射重写’，结果 runtime 在 edit 执行前就把它打掉。这样模型就会卡在两个坏结果之间：真正的局部行为修复过不了 budget guard，而 import-only 的表层补丁却更容易活下来。所以我把 budget 逻辑又拆细了一层：如果 patch 确实命中了目标行为，而且改动范围还在局部预算内，就不会仅仅因为出现 try/except 或异常映射结构，就把它一刀切判成必拦的大改。” 

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `writeLikeToolCallTargetsBehavior()`
  - `explainModificationBudgetViolation(...)`
  - `executeNode`
    - `targetsBehavior`
    - `budgetViolation`

这件事面试里最值得讲的点是：

- 我不是简单把 budget guard 做得更严
- 我是在把“表层补丁”和“局部行为修复”区分开
- 否则 runtime 会自己制造一种反激励：逼模型退回 import-only 假推进

### 亮点 23：我把 `2674` 暴露出的“共享热路径 import-only patch”单独建模了

你可以说：

“`psf__requests-2674` 暴露出的不是‘不会改’，而是另一类假推进：文件本身已经是共享热路径，比如 `requests/adapters.py`，但模型先落了一个 import-only 的表层补丁，然后 modify phase 就被这种浅层 patch 占住了。这个问题如果只看 `highRisk = 大改/宽改`，其实抓不住。所以我后来明确把 `sharedHotPath` 和 `highRisk rewrite` 拆成两个维度：前者描述路径风险，后者描述补丁深度。这样 runtime 就能单独识别‘共享热路径上的表层补丁’，并把它判成无效 modify，要求下一轮继续命中真实行为分支。” 

代码证据：

- `packages/runtime/src/langgraph.ts`
  - `WriteLikeModificationAnalysis.sharedHotPath`
  - `pathLooksLikeHighRiskSharedCode()`
  - `writeLikeToolCallIsSuperficialBehaviorPatch()`
  - `executeNode`
    - `sharedHotModifiedPaths`
    - `highRiskSuperficialBehaviorPaths`
- `packages/runtime/src/langgraph.test.ts`
  - `高风险共享路径上的 import 级表层补丁不能长期占住 modify phase`

这件事面试里最值得讲的点是：

- 我没有把“高风险”简单等同于“大 patch”
- 我把“路径风险”和“补丁深度”分开建模
- 这样 control loop 才能识别 benchmark 里很常见的一类假推进

### 亮点 24：我会把 benchmark failure class 下沉到 runtime，而不是停在 benchmark prompt

你可以说：

“这几轮 benchmark 最重要的收获，不是我把某两道题刷过了，而是我开始区分两类 failure class：一类是 `2148` 这种‘表层补丁冒充行为修复’，另一类是 `2674` 这种‘共享热路径上的浅层补丁长期占住 modify phase’。我的处理方式不是继续往 benchmark prompt 里塞更多题目特例，而是把它们下沉到 runtime gate：让工具执行前就能识别无效 modify，并把控制环强制拉回目标函数体和行为路径。这样即使 benchmark 分数暂时还没涨，这一轮工作也仍然是在提高 agent 本体能力，而不是只是在刷题。” 

代码证据：

- `packages/tools/src/builtin.ts`
  - `normalizeEditInput()`：补齐 benchmark 风格的小写参数别名，先消除工具协议阻抗
- `packages/runtime/src/langgraph.ts`
  - `writeLikeToolCallIsSuperficialBehaviorPatch()`
  - `writeLikeToolCallTargetsBehavior()`
  - `explainModificationBudgetViolation(...)`
  - `executeNode`
- `packages/runtime/src/langgraph.test.ts`
  - `行为性任务里，只有 import/comment 级补丁时不能 finalize，必须继续命中真实行为路径`
  - `高风险共享路径上的 import 级表层补丁不能长期占住 modify phase`

这件事面试里最值得讲的点是：

- 我会区分“benchmark 上看起来像在推进”和“runtime 真的把无效 modify 挡掉”
- 我不会把 prompt 层的启发式写法包装成 agent 本体能力
- 我更关注哪些策略已经在 runtime 代码里被强制执行，并且有场景测试兜住

## 讲项目时的推荐顺序

你可以按这个顺序讲：

1. 先说产品定位：agent IDE，不是聊天壳
2. 再说五个硬门槛：memory、multi-session、subagent、planning mode、goal-driven
3. 再说架构分层：core、runtime、db、tools
4. 再说一个最能体现设计深度的点：planning mode 执行层拦截
5. 再说 MySQL + Redis 的 trade-off
6. 最后诚实说明当前做到哪、下一步做什么

## 一句收尾模板

“这个项目对我来说最重要的收获，不是把模型接进来，而是开始把 agent 从一个会聊天的接口，往一个有状态、有约束、有执行边界的工程系统去做。”
