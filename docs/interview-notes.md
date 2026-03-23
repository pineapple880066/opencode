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
