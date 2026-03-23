# 项目深度拆解

这份文档不是 README，也不是给面试官看的短讲稿。
它的目标只有一个：让你在暂停功能迭代的时候，能按顺序把当前这套 `agent IDE` 的主要实现链路真正看懂。

阅读方式建议：

1. 先看本文件，不要急着在仓库里随机点文件。
2. 每读完一个主题，再跳到对应代码范围。
3. 不要一次想把所有文件背下来，先抓住“每一层到底解决什么问题”。
4. 如果你中途迷路，就回到“这个函数是组合根、应用服务、编排层、工具层，还是 UI 状态层”这个问题上。

---

## 主题一：先把系统分层看懂，不然你后面读任何一个函数都会混

这一套项目最容易把人绕晕的地方，不是某个复杂算法，而是“同样都在处理 prompt 和 session，为什么文件分散在 `apps/ide-web`、`runtime`、`db`、`tools` 这么多层”。如果不先把这个问题讲清楚，你后面读 `createAgentLangGraph()`、`GoalDrivenRuntimeService` 或 `createIdeRuntimeEnvironment()` 时，很容易把职责看混。

建议你先按下面这个顺序看几段代码：

- `packages/runtime/src/store.ts:13-120`
- `packages/runtime/src/graph.ts:14-113`
- `apps/ide-web/src/bootstrap.ts:72-128`
- `packages/db/src/runtime-store.ts:23-40`

这四段代码合起来，基本就是整个系统的骨架。

先看 `packages/runtime/src/store.ts:13-120`。这里定义了 `RuntimeStore`，它不是具体实现，而是一组“runtime 允许向持久化层提什么要求”的合同。你能看到它把工作区、会话、目标、计划、任务、memory、消息、checkpoint、subagent run、tool invocation 全都分成独立 store。这件事很重要，因为它说明当前项目从一开始就没有把“agent 状态”偷懒收成一张 message 表。换句话说，这个系统认定“目标、计划、任务、memory、工具调用痕迹”都是真实存在的一等公民。只要你理解了这一点，后面看到 `GoalDrivenRuntimeService` 里那么多方法，就不会以为它们只是围绕聊天记录打补丁。

再看 `packages/runtime/src/graph.ts:14-113`。这里描述的是“运行时状态长什么样”，以及“主流程最少应该有哪些节点”。`WorkflowNode` 把整个主循环收成 `intake -> clarify -> plan -> delegate -> execute -> review -> summarize -> continue-or-close`。这并不是为了炫图，而是为了告诉你：这个项目把 agent 看成一个持续推进 goal 的状态机，而不是单轮问答。`AgentGraphState` 更关键。你应该把它当成“任何会影响一次执行决策的东西都应该出现在这里”。所以它里面同时有 session、activeGoal、currentPlan、tasks、messages、toolInvocations、memory、subagentRuns、checkpoints。这个设计能帮你建立一个很重要的判断标准：如果某段逻辑依赖一个关键状态，但这个状态既不在 `AgentGraphState` 里，也不在 `RuntimeStore` 合同里，那多半说明这段逻辑还不够稳定，或者仍然依赖局部变量和隐式约定。

再看 `apps/ide-web/src/bootstrap.ts:72-128`。这段代码是组合根。你应该把组合根理解成“把系统接起来的地方”，而不是“写业务逻辑的地方”。这里做的事情只有五件：读配置、起 MySQL、连 Redis、组装 `RuntimeStore + GoalDrivenRuntimeService + RuntimeToolExecutor`、然后创建 LangGraph runtime。它不自己判断 goal 该怎么建，也不自己判断 planner/executor 怎么跑。这种写法是有意的，因为组合根一旦开始夹杂业务细节，后面每换一个模型、每换一个前端入口、每换一种持久化实现，都要重写这里。当前这段代码保持得比较干净，所以你可以把它当成“启动图”，顺着看依赖关系，而不要在这里找业务规则。

最后看 `packages/db/src/runtime-store.ts:23-40`。这个文件的价值不在于代码多，而在于它把前面抽象层和基础设施层接住了。`runtime` 只依赖 `RuntimeStore` 抽象，`db` 才知道底下其实是 MySQL repository + Redis summary cache。这个边界能带来几个直接好处。第一，`GoalDrivenRuntimeService` 不需要知道 SQL 怎么写。第二，测试时可以替换实现。第三，以后你想做一个纯内存版 runtime 或换存储，只需要在这里换适配器，不用把业务层全部重写。

如果你把这四段代码串起来，应该形成一个比较稳定的脑图：

- `store.ts` 定义 runtime 允许依赖什么持久化能力
- `graph.ts` 定义 runtime 允许依赖什么状态和流程骨架
- `runtime-store.ts` 把 db 层的 MySQL/Redis 实现适配成 runtime 认识的合同
- `bootstrap.ts` 把所有层真正接起来

到这里你要先形成一个判断：这套系统不是“浏览器直接调模型 API”，也不是“controller 里把所有逻辑塞一起”。它是“组合根 + 抽象合同 + 应用服务 + 编排层 + 浏览器壳层”的分层结构。只要这点看懂了，后面每一层代码读起来都会容易很多。

---

## 主题二：应用服务层是这套系统真正的业务中心，LangGraph 只是编排器

如果你只看 `packages/runtime/src/langgraph.ts`，很容易误会“这个项目的业务逻辑都在 graph 里”。实际上，当前仓库真正的业务中心是 `GoalDrivenRuntimeService`，也就是 `packages/runtime/src/service.ts`。建议你这次按下面的顺序看：

- `packages/runtime/src/service.ts:306-337`
- `packages/runtime/src/service.ts:365-427`
- `packages/runtime/src/service.ts:443-576`
- `packages/runtime/src/service.ts:608-721`
- `packages/runtime/src/service.ts:801-904`
- `packages/runtime/src/service.ts:906-1104`

先看 `306-337`，也就是 `ensureWorkspace()` 和 `createSession()`。这段代码很基础，但你不能跳过，因为后面几乎所有动作都要求先有 session。`createSession()` 先保证工作区存在，再创建 session。这说明 session 不是漂在空中的 chat tab，而是明确挂在一个 workspace 上。你后面在 UI、tool execution、terminal、file save 里看到所有动作都要带 `workspacePath`，根本原因就在这里。它让“会话”和“工作区”从第一天开始绑定，而不是后面再临时拼。

然后看 `365-427`，也就是 `createChildSession()` 和 `createGoal()`。`createChildSession()` 是理解 subagent 的关键入口。它不是“复制一份上下文继续聊”，而是建立一个真正的 child session，并且可选继承父目标。这里会复制父 session 的 `workspaceId`，会建立 `parentSessionId` 关系，还会在需要时给 child 建一个新的 goal。这个设计是当前项目里很重要的一个分水岭：subagent 到底是不是独立执行单元，看的不是 prompt 里有没有“你现在是 explorer agent”，而是它有没有自己的 session、goal、summary、lineage 和后续可回放记录。`createGoal()` 则是 goal-driven workflow 的另一根锚点。它会把 goal 固化下来，并更新 session 的 activeGoalId。只要这一层稳定，plan、task、review 才不至于在聊天记录里飘。

再看 `443-576`，这里是 `savePlan()`、`syncTasks()`、`recordMemory()`、`updateSessionSummary()`、`appendMessage()`、`createCheckpoint()`、`startSubagentRun()`。这一段是“把运行过程里的各种账本写下来”的主干。你可以把它理解成五类账：

- `Plan`：规划账本
- `Task`：执行账本
- `MemoryRecord`：可复用事实账本
- `GraphMessage`：交互证据账本
- `PersistedCheckpoint`：流程回放账本

这里最重要的工程思想是：这些账本互相配合，但不是一回事。比如 `appendMessage()` 负责把用户、assistant、system、tool 的消息落下来，这样活动流和 UI 都能看见证据；`createCheckpoint()` 负责把某个 workflow node 的状态摘要落下来，这样你能从流程节点视角回看一次运行；`recordMemory()` 负责存稳定事实，不让它混进 message；`syncTasks()` 则是把 executor 的进度判断沉淀成结构化任务账本。你读这段代码时，一定要注意系统为什么没有把所有状态都丢进 session.summary。原因很简单：summary 是压缩视图，不是事实来源。

再看 `608-721`，也就是 `delegateToSubagent()` 和 `completeSubagentRun()`。这是 subagent 生命周期的核心链路。`delegateToSubagent()` 会创建 child session、创建 run、给 child 追加 system message，还会把父任务切成 `in_progress`。`completeSubagentRun()` 则会更新 run 状态、child summary、child goal 状态、父任务状态，并把结果追加回 parent session 的 system message。你最好把这里跟 `createChildSession()` 一起看，因为这三者合起来，才构成一条完整的 parent-child execution 链。没有这条链，subagent 很容易退化成“派出去了一个角色”，却没有真正的结果回流和账本更新。

然后看 `801-904`，也就是 `buildGraphState()`。如果你要找“为什么 UI、LangGraph、MiniMax hooks 看起来都在依赖同一份状态”，答案就在这里。这个方法会把 session、goal、plan、tasks、messages、toolInvocations、memory、subagentRuns、checkpoints 统一拼成 `AgentGraphState`。当前系统里很多上层逻辑并不是分别查十几张表，而是尽量通过这个装配点拿快照。所以如果你要理解“某次执行时模型到底看到了什么状态”，也应该从这里往回追，而不是直接从数据库表名开始猜。

最后看 `906-1104`，也就是 `getSubagentRunReplay()`、`getParentTaskExecutionTrace()`、`cleanupChildSessions()`。这一段是当前项目里非常工程化的一部分，因为它解决的是“运行结束之后怎么审计和收尾”。`getSubagentRunReplay()` 会把 child session 的任务、消息、checkpoint、工具调用一起聚合出来；`getParentTaskExecutionTrace()` 会从 parent 视角，把直接工具调用和 child replay 一起串起来；`cleanupChildSessions()` 则处理“哪些已完成 child session 可以自动归档，哪些要保留，为什么跳过”。这一段很值得你花时间，因为它说明当前项目不是只想把 agent 跑起来，而是已经在往“可回放、可恢复、可清理、可审计”的系统方向走。

把 `service.ts` 看懂之后，你应该得出一个很重要的结论：LangGraph 不是业务中心。它只是调度这些业务动作。真正的业务规则，比如“session 怎么建”“goal 怎么绑定”“subagent 结果怎么吸收”“memory 何时写入”“summary 怎么更新”，其实都在应用服务层。这一点是你后面继续迭代项目时最应该守住的边界。

---

## 主题三：LangGraph 在这里不是拿来炫框架的，它负责把 goal-driven 主循环编排成真实的状态机

现在开始读 `packages/runtime/src/langgraph.ts`。建议这次按下面顺序看：

- `packages/runtime/src/langgraph.ts:35-50`
- `packages/runtime/src/langgraph.ts:99-114`
- `packages/runtime/src/langgraph.ts:441-939`
- `packages/runtime/src/langgraph.ts:944-969`

先看 `35-50`，这里定义了 `LangGraphExecuteResult`、`LangGraphExecutionPhase`、`LangGraphToolCall`。这些类型很重要，因为它们规定了“模型侧 executor 允许向 runtime 输出什么”。尤其是 `executionPhase`，它把执行阶段显式拆成 `explain / modify / finalize`。这不是为了好看，而是为了解决 mixed request 的执行纪律问题。比如“先解释这个文件，再加两行注释”这种请求，如果没有 phase，模型经常会在“我已经解释完了”和“我到底该不该继续 edit”之间摇摆。把 phase 显式化之后，runtime 才能在不同阶段应用不同控制规则。

再看 `99-114`。`AgentLangGraphAnnotation` 定义了 graph 里真正流转的 state。这里你会看到和 `AgentGraphState` 不是一回事。`AgentGraphState` 是 runtime 快照，而 annotation state 里额外加了 `sessionId`、`userMessage`、`latestReview`、`latestPlanId`、`latestSubagentRunId`、`executionLog`。这是一个很值得你记住的分层：运行时业务快照是一层，graph 编排过程需要携带的“编排元数据”又是一层。两层不能混，否则你很容易把“暂时的编排字段”也误当成 durable business state。

然后从 `441` 开始往下看，这是整个 graph 的主实现。`createAgentLangGraph()` 会创建一条固定工作流，并把各节点接成 `START -> intake -> clarify -> plan -> delegate -> execute -> review -> summarize -> continue-or-close -> END`。当前最小版本没有复杂条件分支，但这不代表它没价值。恰恰相反，这种固定链路能让你非常清楚地看到“一个 prompt 进入系统后，最少会经过哪些阶段”。你读这段代码时，建议按节点一个一个看。

`449-490` 的 `intakeNode` 负责两个动作：把用户消息写进 message ledger；如果当前 session 还没有 active goal，就调用 `goalFactory` 建第一个 goal。也就是说，goal 不是在 UI 层顺手塞进去的，而是在 graph 入口里真正建立的。

`500-539` 的 `planNode` 把 planner hook 的结构化输出交给 `service.savePlan()`，并留下 checkpoint。这里 graph 只是“组织顺序”，并不自己构造 Plan 实体。这个分工很关键，因为它避免了“同一个业务动作在 service 和 graph 各写一份”。

`541-583` 的 `delegateNode` 判断要不要派生 subagent。它把 delegate hook 的结果转成真正的 child session / subagent run，并把 `latestSubagentRunId` 带回 graph state。你如果要理解“UI 里为什么能看到 replay/delegation 面板”，可以从这里往后追。

最重要的是 `585-823` 的 `executeNode`。这一段你一定要慢慢看，因为它不是简单的“调 executor 一次然后结束”，而是一个受控的多轮执行环：

1. 让 executor hook 基于当前 `runtimeState` 输出结构化执行草案
2. 先同步 tasks / memory
3. 如果没有 toolCalls，就判断是否该收尾或强制继续
4. 如果有 toolCalls，就通过 `toolExecutor` 真实执行
5. 把工具结果写回 tool message
6. 刷新 runtimeState，再进入下一轮

这里还有两个非常关键的控制点。第一是 `shouldForceModifyContinuation`，也就是 `633-673` 这段逻辑。它解决的是 mixed explain + edit 请求里，模型只解释不改文件的情况。第二是后半段的 tool-use control loop 和 reread budget，它决定模型是否可以继续读、什么时候必须转去 edit、什么时候应该被 loop guard 拦住。

`825-904` 的 `reviewNode` 和 `summarizeNode` 也不能跳过。很多 agent 系统做到 execute 就停了，但这里显式做了 review 和 summary。review 是判断 goal 是否真的满足，summary 是为了 session 恢复和 UI 可见性。你后面在 workbench 顶部看到 session summary，底层就是这一步维护的。

最后看 `914-969`。这段把所有节点编译成 LangGraph，并且明确用 `thread_id = sessionId`。这是当前 durable execution 的关键钩子。因为一旦 thread_id 和 session 挂钩，后面你做恢复、继续追问、checkpoint 回放，就不会是“另起一条无关的图线程”。

这整个文件看完之后，你要形成一个稳定理解：LangGraph 在这里不是业务层，也不是模型层。它是“编排层”。它决定节点顺序、携带编排状态、管理 thread 恢复，并把每个阶段的结果通过 service 落到 durable state 上。这个边界一旦看懂，你后面无论是替换 provider、继续加 subagent 策略，还是改 UI，都不容易把层次打乱。

---

## 主题四：真正让 agent 不那么“假装在干活”的，是 execute 控制环、工具合同和预算化 reread 策略

如果你现在只想挑一个最有工程味、最接近真实 agent 难点的主题来啃，我建议你优先读这一节。因为这里讲的是当前项目里最重要的一层：`tool-use control loop`。建议顺序如下：

- `packages/runtime/src/langgraph.ts:143-322`
- `packages/runtime/src/langgraph.ts:585-823`
- `packages/runtime/src/tooling.ts:18-83`
- `packages/tools/src/builtin.ts:178-368`

先从 `langgraph.ts:143-322` 开始。这里是 execute 控制环的一组辅助函数。`buildToolCallKey()` 用来做完全相同工具调用的去重；`readToolCallPath()` 从工具输入里抽出“这次到底在读/改哪个路径”；`hasExplicitViewRange()` 和 `readExplicitViewRangeKey()` 识别 view 是否带了显式范围；`ViewReadBudgetState` 维护某个路径的读取预算；`inferExecutionPhase()` 负责在模型没显式给 phase 时兜底判断；`looksLikeModificationRequest()` 和 `hasPendingModificationWork()` 用来决定 explain 阶段结束后，是不是应该强制继续 modify。这一组函数看起来零散，但其实是同一个目标：把“什么时候继续读、什么时候继续改、什么时候已经在打转”从模型的隐式感觉，收束成 runtime 能执行的规则。

接着看 `langgraph.ts:585-823`。这就是 execute 控制环本体。你要重点理解它不是一个 while true，而是一个有预算的多轮循环。它有 `maxToolRounds = 5` 和 `maxToolCallsPerRound = 4`，这已经说明当前系统默认不相信模型会天然收敛，而是先给执行层留硬边界。每轮先拿 executor 的结构化输出，再按顺序做几件事：同步 task、同步 memory、决定是否该直接收尾、决定是否该强制下一轮 modify、决定是否该真实调工具。这个顺序不能看乱，因为一旦你把 tool execution 提前到 task/memory 同步之前，或者把 modify continuation 放到 tool execution 之后，系统行为会明显变得不稳定。

这一段里最关键的两个策略，你应该反复看。

第一是 `633-673` 的 `shouldForceModifyContinuation`。这是为 mixed explain + edit 请求加的一层硬约束。它的判断条件不是“模型说自己解释完了”，而是：

- 当前没有新的 toolCalls
- 当前仍处于 `explain` phase
- 这次 invoke 里已经做过工具调用
- 但还没有任何 `edit/write` 成功
- 用户消息本身包含修改意图
- plan/task 里仍然存在待做的修改工作
- 且还有后续轮次可跑

只要这些条件满足，runtime 就会追加一条 `EXECUTION_POLICY` system message，强制下一轮切到 modify phase。这个策略的工程价值很高，因为它把“是否应该继续动手”从模型自觉，推进成了执行层纪律。

第二是 `724-764` 这段 budgeted reread policy。你之前已经意识到“读过一次就永久不许再读”太粗暴，这个版本已经升级成预算式策略：

- 第一次完整读取允许
- 完整读取之后允许 1 次 focused reread
- focused reread 必须带新的范围
- focused reread 只允许发生在 explain phase
- 进入 modify/finalize 后不再回头 reread
- 第 3 次再读才真正触发拦截

这其实非常接近真实 agent 系统里的折中：既不能让模型无穷重复读取，也不能因为怕循环就剥夺它合理精读的能力。你后面如果继续迭代，这里就是最值得继续演化的地方。

再看 `packages/runtime/src/tooling.ts:18-83`。`RuntimeToolExecutor` 只有几十行，但地位很关键。它做了两件事：第一，根据 session 当前的 `activeAgentMode` 去拿 `DEFAULT_TOOL_POLICIES`，也就是 planning mode/build mode 的真实权限边界；第二，把每次工具调用的开始和结束都写进 `toolInvocations`。这让工具调用不再是黑盒，而是有审计记录、有状态、有输入输出留痕。execute 控制环之所以能基于“最近工具调用”做判断，也是因为这里在落账。

最后看 `packages/tools/src/builtin.ts:178-368`。这一段是文件工具合同的关键。`parseLineRangeAlias()` 把 `lineRange: "1-70"` 这种外部风格解析成内部标准字段；`normalizeViewInput()` 统一兼容 `path/file_path/filePath`、`startLine/endLine`、`offset/limit`、`lineRange`；`viewTool()` 则真正实现了显式分页合同。这些细节看起来像“工具参数兼容”，但它背后其实是 agent 执行稳定性的前提。因为一旦工具合同过于含糊，模型和 runtime 对“我到底读了哪一段内容”就会产生错位，随后 loop guard、reread budget、edit anchor 判断都会被污染。

这一整节你一定要得出一个清晰结论：当前项目里最重要的 agent 能力，不只是“会发 toolCalls”，而是“能在工具循环里维持最小执行纪律”。这层如果后面继续做强，就会越来越接近成熟 agent IDE 的核心差异化。

---

## 主题五：MiniMax 适配层真正有价值的地方，不是能调接口，而是把不稳定输出收口成可执行结构

很多人看 provider 接入时只会关注 `fetch()` 那一段，但当前项目里更值得你花时间的是适配层里“结构化输出怎么被修、被裁、被兜住”。建议按下面顺序看：

- `apps/ide-web/src/minimax.ts:436-499`
- `apps/ide-web/src/minimax.ts:596-654`
- `apps/ide-web/src/minimax.ts:774-925`
- `apps/ide-web/src/minimax.ts:943-1047`
- `apps/ide-web/src/minimax.ts:1102-1275`

先看 `436-499` 的 `sanitizeExecutorCandidate()`。这段代码是整个 executor 适配里最现实的一步。你要意识到，模型输出“看起来是 JSON”并不代表它已经适合进 runtime。常见问题有：

- task 只有 id/status，缺标题和输入摘要
- memory 有 key 但 value 为空
- toolCalls 的 name 对，但 input 不是 object
- executionPhase 写成别名或漂移值

这里的策略不是把脏数据原样扔给 schema，而是先做一层“能补则补，补不了就丢”。比如 task 可以从当前 `AgentGraphState` 里的已有 task 或 plan step 补回 `title` 和 `inputSummary`；补不回来的项直接过滤掉。这个选择很重要，因为它体现了一种非常工程化的态度：provider 输出是不可信输入，适配层要把“不稳定性”尽量留在边缘，而不是让 runtime 核心层承受它。

再看 `596-654`，也就是 `executorSchema`。这里其实定义了“MiniMax executor 被允许输出什么”。你可以把它理解成 `LangGraphExecuteResult` 在 provider 侧的约束镜像。尤其是 `executionPhase`、`tasks`、`memory`、`toolCalls` 这四块，基本决定了模型能不能和 runtime 正常对话。当前 schema 既限制了枚举值，也限制了数组长度，还要求关键字段非空。这一层配合前面的 sanitizer，形成了“先宽容归一化，再严格验证”的组合。

然后看 `774-925`。这段 `previewMessageForDigest()`、`previewToolInvocationOutputForDigest()`、`buildStateDigest()` 是当前适配层里很值得讲的一段，因为它直接影响 executor 下一轮会不会打转。你之前已经碰到过一个典型问题：如果最近的 `view` 结果被截得太短，模型虽然知道自己读过文件，但拿不到足够上下文，就会继续 `view`。这里的解决方式不是把全部上下文无脑塞给模型，而是对不同信号做不同预算：普通 message 保持短，`tool=view` 的 message/output 则保留更长片段。这个设计非常像真实系统里的 token budget 取舍：不是越长越好，而是要把预算优先花在真正决定下一步动作的证据上。

再看 `943-1047` 的 `callMiniMaxJson()`。这段代码值得你至少读两遍。它把 provider 输出处理拆成三层：

1. 请求模型，抽取 JSON object
2. `JSON.parse()` 直接失败时，先走一次 syntax repair
3. parse 成功但 schema 不合法时，再走 sanitizer + Zod + schema repair

这个设计的关键不是“修复 JSON 很酷”，而是它承认模型输出会在不同层面出错。你不能只做 schema repair，因为很多错误连 parse 都过不了；你也不能只做 syntax repair，因为 parse 过了之后仍然可能有枚举漂移、超长数组、空字段。把这三层分开以后，排错和维护都会清晰很多。

最后看 `1102-1275` 的 `createMiniMaxHooks()`。这里把 `goalFactory`、`planner`、`delegate`、`executor`、`reviewer`、`summarizer` 一次性接成了 LangGraph hooks。读这段时你要重点看 `executor` 对应的 prompt，尤其是 `1194-1208` 左右的部分。这里已经把当前 runtime 的执行纪律明确写给模型了：

- `executionPhase` 只能是 explain/modify/finalize
- `toolCalls` 只能用 list/view/grep/write/edit
- 解释阶段尽量读取，修改阶段直接 edit/write
- `view` 支持显式范围
- reread policy 明确成“完整读一次后，只允许一次 focused reread”
- mixed request 推荐顺序是 `explain -> modify -> finalize`
- 有 toolCalls 时不要刷中间态废话

这说明当前项目已经不是“给模型一个 vague prompt，让它自己猜怎么协作”，而是在 provider 侧尽量把 runtime 规则投射进结构化协议。你后面如果换模型、换 provider，真正应该尽量复用的不是 API 地址，而是这种“结构化输出 + 预算控制 + repair 兜底”的思路。

---

## 主题六：浏览器工作台不是前端壳子，它其实是一个 server-driven 的 IDE 状态机

这一节建议你一起看三个文件，因为它们必须联动理解：

- `apps/ide-web/src/shell.ts:280-331`
- `apps/ide-web/src/shell.ts:397-550`
- `apps/ide-web/src/shell.ts:555-651`
- `apps/ide-web/src/shell.ts:671-1513`
- `apps/ide-web/src/browser.ts:35-67`
- `apps/ide-web/src/browser.ts:70-142`
- `apps/ide-web/src/browser.ts:147-640`
- `apps/ide-web/src/server.ts:113-428`

先看 `shell.ts:280-331` 的 `buildWorkspaceBrowserState()`。这是当前工作台里的“最小文件浏览器”状态构造器。它一方面扫描 workspace 生成受控文件树，另一方面读取当前选中文件，给 editor 面板准备完整内容和预览。你要注意，这一步是在服务端做的，不是浏览器自己去扫磁盘。这是因为当前 UI 是 server-driven shell：服务端负责计算“当前应该显示什么”，浏览器负责把动作回传。

接着看 `shell.ts:397-550` 的 `buildIdeShellState()`。这是整个 workbench 的状态拼装中心。它会同时查 session 列表、graph state、messages、checkpoints、tool invocations、subagent runs、workspace 文件树、terminal 历史，然后统一拼成 `IdeShellState`。这说明当前 UI 不是“前端自己去凑几个接口”，而是有一份明确的工作台状态协议。你在页面上看到的 session strip、conversation、goal、plan、replay、delegation、inspector、editor、terminal，本质上都只是 `IdeShellState` 的不同视图。

然后看 `shell.ts:555-651` 的 `reduceIdeShellNavigation()`。这段很重要，因为它把“用户点击了什么”收成稳定的导航动作。当前系统里不是每个按钮都自己写一套逻辑，而是先抽象成：

- `focus-panel`
- `select-session`
- `open-file`
- `open-replay`
- `open-parent-task`
- `inspect-timeline`
- `toggle-conversation-pane`
- `toggle-terminal-pane`

这个 reducer 的价值在于：服务端和浏览器都可以围绕同一套导航协议工作，刷新、前进后退、切 session、切 pane 时不会各自维护一套容易漂移的状态。

再看 `shell.ts:671-1513`。这一大段是 render 层。你不需要一口气看完所有 HTML 字符串，但要重点看几个函数：`renderWorkbenchHeader()`、`renderMessagePanel()`、`renderFilesPanel()`、`renderTerminalSection()`、`renderWorkbenchPanel()`。其中 `renderWorkbenchPanel()` 最值得你细看，因为它明确把当前 agent IDE 的高频三件事放在同一个主工作区里：

- Conversation：继续和 agent 对话
- Explorer + Editor：看文件、改文件
- Terminal：在当前 workspace 运行命令

这也是为什么这套 UI 后来从“tab 式信息页”继续收敛成 `workspace-first` 布局。当前项目里真正高频的不是反复切 tab，而是边看 agent、边改文件、边跑命令。

接着看 `browser.ts`。`35-67` 和 `70-95` 分别是序列化和解析导航参数；`98-132` 把 DOM `data-action` 解析成导航动作；`147-640` 则是浏览器运行时脚本。这里最关键的是三个提交函数：`submitPrompt()`、`submitFileSave()`、`submitTerminalCommand()`。它们都不会自己在前端修改大量局部状态，而是把请求发给服务端，再根据返回的下一次导航重新拉一份页面。你应该把这理解成“页面是 server-driven 重建的”，而不是 SPA 局部 diff。这也是为什么刷新和切 session 后，很多状态还能保持。

最后看 `server.ts:113-428`。这个文件是浏览器工作台的 HTTP 边界。`buildIdeShellStateResponse()` 负责从 URL 解析导航，再调用 `buildIdeShellState()`。`createIdeShellRequestHandler()` 同时处理四类请求：

- `/__ide__/state`：拿当前 shell state
- `/__ide__/invoke`：提交 prompt
- `/__ide__/save-file`：保存文件
- `/__ide__/terminal/run`：跑命令

以及文档请求 `/`。尤其值得你注意的是，invoke/save/terminal 这些接口返回的不是直接渲染好的消息片段，而是“下一次导航应该去哪”。浏览器收到以后会再根据这个导航取最新文档。这个设计虽然比纯前端状态管理粗一些，但优点是现在这版工作台的状态边界非常清晰，适合当前阶段快速验证 agent/runtime/UI 三层联动。

你把这一节看懂之后，就会知道当前 UI 为什么虽然还不算成熟，但已经不只是“聊天记录页”。它实际上已经是一套小型的 IDE 状态机：服务端构建状态，浏览器发动作，服务端回导航，再重建工作台。

---

## 主题七：测试和排错不要只看“最后一句 assistant 说了什么”，要学会沿着证据链往回查

最后一节我建议你重点看一个小文件，再配合系统里的几类日志理解排错方式：

- `apps/ide-web/src/browser.test.ts:1-140`
- 结合 `packages/runtime/src/service.ts:801-904`
- 结合 `packages/runtime/src/langgraph.ts:585-823`
- 结合 `packages/runtime/src/tooling.ts:18-83`

先看 `apps/ide-web/src/browser.test.ts:1-140`。这个文件不测试模型，也不测试后端路由本身。它测试的是同目录 `browser.ts` 里的浏览器运行时辅助逻辑。你可以把它理解成“工作台前端导航协议的单元测试”。这几个测试分别验证了：

- `20-45`：`serializeIdeShellNavigation()` 和 `parseIdeShellNavigation()` 能否互相还原
- `47-64`：`data-action` 数据集能不能被还原成导航动作，并约简成下一次导航输入
- `66-85`：pane toggle 是否能正确写回导航参数
- `88-112`：浏览器文档里是否真的注入了运行时脚本和必要标记
- `114-139`：当文件面板可用时，HTML 里是否真的包含保存文件表单

这个测试文件很适合你自学，因为它短，而且能帮助你建立一个判断：当前 `browser.ts` 测的不是视觉样式，而是“浏览器运行时协议”是否成立。也就是说，它关心的是 URL 参数、`data-action`、HTML 注入、表单是否具备，而不是 CSS 好不好看。

然后你要理解，这个项目里真正排错时，不能只看浏览器页面最后弹出来那句提示。你前面已经碰到过几类典型问题：

- 模型一直 `view` 同一个文件，却不进入 `edit`
- 前端只提示“Agent 调用失败”，但真实错误被掩盖
- mixed explain + edit 请求解释完就收尾，文件根本没改

这类问题如果只看最后一条 assistant 消息，基本定位不出来。正确做法应该沿着三条证据链查：

第一条是 `messages`。它能告诉你用户、assistant、system、tool 这四类消息最终留下了什么语义痕迹。比如有没有 `LOOP_GUARD`，有没有 `EXECUTION_POLICY`，有没有 tool result message。

第二条是 `toolInvocations`。它能告诉你工具到底有没有真实执行，执行了几次，输入输出是什么，状态是 started/completed/failed。很多“看起来像在执行”的问题，真正一查这里就会发现只是刷消息，根本没调工具。

第三条是 `checkpoints`。它能告诉你 graph 走到了哪个节点，每个节点用什么 summary 落点。比如 execute 节点到底是“已执行 4 次工具调用”，还是“跳过 execute”，这些信息只看消息流不一定清楚。

而 `service.ts:801-904` 的 `buildGraphState()` 又把这些证据收成了一份统一快照，所以 `LangGraph executor`、`MiniMax state digest`、`IDE activity log` 实际上看的是同一批底层事实。`langgraph.ts:585-823` 则是这些证据真正被消费和追加的地方，因为 execute 每轮都会：

- 读取当前 `runtimeState`
- 决定要不要继续
- 真正调工具
- 再把 tool result 写回 message ledger

`tooling.ts:18-83` 则把工具执行留痕这一步收住了。没有这层，很多 bug 都只能停留在“感觉 agent 没干活”，而不能落到“哪个工具没执行、为什么被 policy 拦了、输出到底是什么”。

所以这一节你要记住的不是某个测试断言，而是一种排错方法：

1. 先看用户请求是什么，是否混合了 explain / modify / summarize 多种意图
2. 再看 `toolInvocations`，确认工具有没有真实执行
3. 再看 `messages`，确认 system nudge、tool result、assistant 总结各自发生在哪一步
4. 再看 `checkpoints`，确认 graph 节点走到了哪
5. 最后再回去看 MiniMax prompt / sanitizer / executor phase，是 provider 输出问题，还是 runtime control loop 问题

这套方法其实就是你后面继续迭代这个项目时最应该掌握的基本功。因为 agent 系统很容易让人陷入“好像什么都可能是模型的问题”的错觉，但真正能把系统做稳的人，通常都会先把证据链理清，再决定到底该改 provider、改 control loop、改工具合同，还是改 UI 错误边界。

---

## 建议你的下一步阅读顺序

如果你准备花几天把项目真正看懂，我建议按这个顺序来：

1. 先通读本文件一遍，先记住“每一层解决什么问题”。
2. 再按主题一去看：
   - `packages/runtime/src/store.ts`
   - `packages/runtime/src/graph.ts`
   - `packages/db/src/runtime-store.ts`
   - `apps/ide-web/src/bootstrap.ts`
3. 然后读主题二的 `packages/runtime/src/service.ts`，重点把 session / goal / plan / task / subagent 生命周期看懂。
4. 再读主题三和主题四，把 `packages/runtime/src/langgraph.ts` 和 `packages/tools/src/builtin.ts` 串起来。
5. 然后读主题五的 `apps/ide-web/src/minimax.ts`，重点看结构化输出、digest、repair。
6. 最后读主题六和主题七，把 `shell.ts / browser.ts / server.ts / browser.test.ts` 串起来。

如果你真的按这个顺序来，后面再继续做 Monaco、PTY、更多 subagent orchestration 时，就不会只是“往项目里加功能”，而是会更清楚自己到底在扩哪一层、会不会破坏现有边界。
