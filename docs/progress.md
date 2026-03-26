# 项目总进度

这份文档按仓库里的 `agent-self-check` 和 `goal-driven-delivery` 标准维护。
它的目标不是营造“好像做了很多”的感觉，而是明确现在到底做到了哪一步、还有哪些关键门槛没过。

## 当前阶段

当前处于：`Phase 2 执行层` 持续加固阶段。

一句话概括：

- 骨架、硬约束、持久化方向、MySQL/Redis 基础设施、runtime 应用服务已经落到执行层一部分
- LangGraph 的最小编排、durable checkpointer、bootstrap 组合根都已经进入执行层
- `2026-03-21` 已经用 Docker 起真实 `MySQL + Redis` 跑通 persistence smoke，不再只是单测
- IDE UI 仍未完成，但已经从最小 inspector shell 推进到更像 opencode 的单主工作区 workbench：顶部收纳 session/context，中间主舞台交给 agent、文件编辑和终端
- 当前工作台布局已经不再坚持“左右两栏平均分信息”，而是明确把 `agent + editor + terminal` 设成高频主交互，更接近“工作区优先”的 agent IDE
- 当前浏览器工作台已经能直接查看 `workbench / goal / plan / activity / replay / delegation / inspector`
- 当前浏览器工作台已经支持提交 prompt，并在同一 session 上走 LangGraph / runtime，而不是只能看记录
- 当前浏览器工作台已经支持浏览当前 workspace 文件列表，并在主工作区里直接编辑、保存文本文件，不再只有会话记录和只读预览
- 当前浏览器工作台已经补上最小可用的终端命令面板：可以在当前 workspace 内执行命令，并把最近的 stdout / stderr 历史保留在工作区里
- 仓库这轮新增了 `docs/project-deep-dive.md`，并给 `bootstrap / service / langgraph / minimax / server / browser / shell` 这些关键文件补了面向自学的中文注释，方便暂停功能迭代时反向吃透实现链路
- 仓库这轮又新增了 `docs/langgraph-in-project.md`，专门把 LangGraph 官方 API、项目内自定义适配层、MySQL checkpointer 和浏览器到 graph 的完整调用链拆开讲；同时也给 `graph.ts / langgraph.ts / langgraph-checkpointer.ts / dev-server.ts / minimax.ts` 补了更细的中文教学注释，方便单独准备面试里的 LangGraph 问答
- `docs/interview-notes.md` 这轮又把 LangGraph 相关内容重写成了训练稿结构：每个问题都带“可直接回答的话术 + 具体代码位置 + 追问点”，更适合拿去给别的模型做面试陪练
- 当前浏览器工作台这轮又做了一次 `UI 稳定性修复`：workbench 改成固定区域 + 内部滚动，避免 workspace explorer 把整页撑长，也避免编辑区和终端区继续互相重叠
- 当前浏览器工作台已经把左侧 `agent` 区和右下 `terminal` 区做成可开关面板，而且开关状态已经进入 server-driven 导航协议；这意味着刷新页面、切换 session、提交 prompt / 保存文件 / 运行命令之后，工作区布局不会乱跳
- LangGraph 的 `execute` 节点已经接入最小真实工具循环：模型可以返回 `toolCalls`，runtime 会真实执行 `list / view / grep / write / edit`，再把工具结果回写到消息和 tool invocation 日志里
- `execute` 节点针对“重复读取同一个文件、却不继续 edit”的打转问题又加了一层 runtime 约束：最近工具调用摘要会喂回 executor，连续重复的相同工具调用会被 loop guard 拦截，不再无限重复 `view`
- 这条执行链这轮又从“硬 guard”推进到了“budgeted reread policy”：`view` 合同现在显式支持 `startLine/endLine` 和 `offset/limit`，MiniMax prompt 也会输出 `executionPhase`；runtime 不再粗暴地禁止同一路径二次读取，而是改成“首次完整读取允许、之后允许 1 次 focused reread、第 3 次再拦”，同时要求 reread 必须带新范围并且仍处于 `explain` phase
- 第一批内建文件工具开始兼容更常见的外部 agent 参数风格：`file_path`、`old_string/oldString`、`new_string/newString`、`replace_all`
- 这轮又继续把“修改后怎么验证”从 benchmark prompt 下沉到了 runtime：`LangGraphExecutionPhase` 新增了显式 `verify` phase，`executeNode` 现在会在真实 `edit/write` 之后检查“是否已经做过最小验证”；如果还没有验证，就通过 `VERIFICATION_POLICY` system message 强制下一轮进入 verify，而不是直接 finalize
- 这条验证策略不仅拦“改完就收尾”，还会拦“验证失败后硬收尾”：如果最新改动后的第一次 verify 失败，runtime 会继续要求下一轮基于失败输出继续 modify 或再次 verify，而不是允许模型把失败测试当成最终结果直接包装掉
- 工具合同层也跟着补了最小验证所需的 bash 参数兼容：`bash` 现在除了 `command/cwd/timeoutMs`，还兼容 `cmd`、`script`、`working_directory`、`workingDirectory` 和 `timeout_ms`，避免验证命令本身卡在协议阻抗上
- 为了防止这条验证策略误伤低风险编辑，这轮还专门补了区分：纯注释/文档型修改不会被错误地强制进入 verify phase，但“修 bug / 改默认值 / 调参数 / 补校验”这类行为性修改会被要求在 finalize 前至少做一次最小验证
- planning mode 工具拦截、第一批真实工具、subagent delegation / child session 生命周期也已经进入执行层，而不只是 schema/合同层
- `MiniMax` 的 LangGraph hooks 适配层已经写好，包含配置读取、结构化 JSON 解析和 smoke 脚本
- `MiniMax` 适配层已经补了枚举归一化，对 `pending / completed / 进行中 / research / model` 这类常见别名有更强容错
- `MiniMax` 适配层进一步补成了三层防线：prompt 约束、本地 sanitizer 归一化/裁剪、以及一次受限的 JSON repair 重试，不再把结构化输出完全寄托在模型自觉上
- `MiniMax` 适配层这轮又补了一层更底的语法修复：以前只会修 Zod 校验失败，现在连 `JSON.parse` 级别的脏 JSON 也会先走一次 syntax repair，再进入 schema 校验，避免 planner/executor 因为丢一个逗号就直接 500
- `MiniMax` executor 的本地兜底继续加强了：如果模型只返回 `task id + status`，会优先从当前 runtime state 里的旧 task / plan step 补全 `title` 和 `inputSummary`；补不齐的脏 task 和空 memory 项会被直接丢弃
- `2026-03-21` 已经在真实 `MiniMax` API key + 本地 `MySQL/Redis` 基础设施下跑通 `pnpm smoke:minimax`，拿到第一条外部模型链路证据
- `packages/evals/src/minimax-smoke.ts` 已支持 `--session` 和 `--latest`，可以复用已有 session 继续追问，而不是每次都新建会话
- 工作区级 `.env / .env.local` 自动加载已经接入 `dev-server`、`MiniMax smoke` 和持久化 smoke，`.env.example` 不再只是说明文件
- 本地基础设施已经有 `compose.yaml + pnpm infra:*`，可以一键启动 `MySQL 8.4 + Redis 7`
- 仓库这轮新增了 `packages/evals/src/swebench-lite.ts` 这个 headless benchmark runner：它不会绕浏览器 UI，而是直接创建 session、调用 `runtime.langGraph.invoke(...)`、收集工作区 `git diff`，并输出给官方 harness 可消费的 `predictions.json`
- 仓库这轮还新增了 `packages/evals/scripts/export_swebench_lite_subset.py` 和 `docs/swebench-lite.md`，前者负责导出一个小批量 Lite 实例，后者把“导出实例 -> 跑 runner -> 用官方 harness 评分”的链路固定成可复现步骤
- benchmark 路径这轮单独引入了 `toolApprovalDecider`：平时 IDE 路径仍然保持 `bash` 需要显式批准，但在 headless benchmark runner 里，会只对 `bash` 做受控自动批准，允许 agent 在实例工作区里跑最小验证命令
- benchmark 路径没有复用浏览器工作台，而是刻意做成 `repo cache + instance workspace` 两层目录：前者缓存仓库克隆，后者为每个实例还原 `base_commit` 并生成 patch。这样一次 5 条实例的批处理不会互相污染，也更接近官方 harness 的评测语义
- `2026-03-25` 已经用这条 headless runner 真实跑完第一批 5 条 SWE-bench Lite 实例：`completed=4 / failed=1 / withPatch=0`。这说明 benchmark 基线链路已经打通，但当前 agent baseline 仍然偏弱，主要问题已经从“跑不起来”转成“会规划和读文件，但还不稳定地产出 patch”
- `2026-03-25` 这轮继续补了两类直接影响 patch 产出的执行层约束：`edit` 工具新增了 `oldText/newText` 兼容，execute control loop 也新增了“已 view 过同一路径后，如果还继续对同一路径发纯只读 toolCalls，就直接强制切到 modify”这条策略
- 同一天又在同一批 5 条实例上重跑了一轮 baseline，结果提升到了：`completed=5 / failed=0 / withPatch=3`。这说明这轮优化不是 prompt 层幻觉，而是真正提升了 patch 产出率
- 这批 `withPatch=3` 的结果已经送进官方 SWE-bench harness 做第一轮正式评分，拿到的结果是：`completed_instances=3 / resolved_instances=1`，唯一 resolve 的实例是 `pytest-dev__pytest-5227`。这说明“能产出 patch”和“能被官方 harness 判定为解决问题”之间仍然有明显距离，当前 baseline 还远没到可宣称稳健的程度
- 第一轮官方 harness 也把下一步优化目标钉得很明确：`pallets__flask-4045 / pallets__flask-4992` 是空 patch，`psf__requests-2148 / psf__requests-2674` 虽然能产出 patch，但官方仍判 unresolved。所以当前最有价值的工作不是盲目扩实例数，而是继续压 `execute` 控制环，把“定位到目标文件后稳定进入 edit/write”这一步做扎实
- 针对两条 Flask 空 patch，这轮又继续做了执行层收紧：`grep` 新增 `pattern / keyword` 别名兼容，也开始正确处理“单文件路径 grep”；benchmark prompt 额外加入了“如果同文件里已经找到类似校验/参数处理，就把它当成最终 anchor，停止横向搜索，最多再做一次局部 reread，然后立刻 edit”的规则；同时 `execute` 也不再因为模型口头声称自己进入了 `modify` phase 就放行收尾，而是会检查当前 invoke 是否真的已有成功的 `edit/write`
- 这轮针对 `pallets__flask-4045` 的单实例重跑已经拿到了真实 patch：agent 最终在 `src/flask/blueprints.py` 的 `Blueprint.__init__` 里补上了“blueprint name 不能包含 dot”的校验逻辑，说明这条执行链已经不再停留在空 patch
- benchmark 路径这轮还单独放宽了图运行预算：headless runner 现在会把 `maxToolRounds` 提到 `8`，因为 SWE-bench 这类混合“定位 -> 精读 -> 修改 -> 最小验证”的任务，平均需要比日常 IDE 交互更长的工具链；如果继续沿用偏保守的交互预算，会过早在“已经找到目标文件，但还没真正 edit”之前收尾
- 这两条 Flask 实例随后又重新送进官方 harness 做二次评分，结果变成了：`completed=2 / resolved=1 / empty_patch=0`。`pallets__flask-4992` 已经被官方判定 resolve，`pallets__flask-4045` 虽然 patch 能正确 apply、也能通过新增的目标测试，但仍然漏掉了一个旧回归用例 `tests/test_blueprints.py::test_route_decorator_custom_endpoint_with_dots`。这说明当前执行链问题已经明显收敛：对 Flask 来说，瓶颈不再是“改不出来”，而是“patch 是否足够完整，不会伤到旁边语义”
- 为了继续压 `pallets__flask-4045`，这轮没有直接把 `test_patch` 泄露给 agent，而是把剩余问题抽成了两条新的 benchmark prompt 规则：一条要求把每个 `FAIL_TO_PASS` 当成独立验收项，另一条要求“如果问题文本明确说某类校验已经在别处存在，也应该加在这里”，就把同模块里的 sibling validation 一起统一到同一显式异常语义。这个改动落在 `packages/evals/src/swebench-lite.ts`
- 加了这组新规则之后，`pallets__flask-4045` 的单实例 rerun 已经从“只在 Blueprint.__init__ 补一刀”推进成了“同时修改 `Blueprint.__init__`、`endpoint` dot 校验和 `view_func.__name__` dot 校验”，全部统一成显式 `ValueError`
- 这版新的 `4045` patch 已经再次送进官方 harness，结果文件是 `.benchmarks/official/SWE-bench/minimax:MiniMax-M2.7.opencode-flask4045-rerun-20260325T200900Z.json`，最终 `resolved=1 / unresolved=0 / empty_patch=0`。这说明当前针对 4045 的剩余瓶颈已经被关掉了
- 在此基础上，这轮又把“最新已 resolve 的 `4045` patch + 已 resolve 的 `4992` patch”重新合并回原始 5 条 predictions，并再次送进官方 harness。新的整批结果文件是 `.benchmarks/official/SWE-bench/minimax:MiniMax-M2.7.opencode-five-patched-20260325T203300Z.json`，最终分数提升到了：`completed_instances=5 / resolved_instances=3 / unresolved_instances=2 / empty_patch_instances=0 / error_instances=0`
- 这次整批 5 条里，已经被官方判定 resolve 的是：`pallets__flask-4045`、`pallets__flask-4992`、`pytest-dev__pytest-5227`。仍然 unresolved 的是：`psf__requests-2148` 和 `psf__requests-2674`
- 两条 `requests` 实例的失败模式也不一样：`psf__requests-2148` 已经能正确 apply patch，而且 `9/10` 个 `FAIL_TO_PASS` 目标测试通过，说明它更像“修复不完整”；`psf__requests-2674` 则是目标测试都过了，但又打挂了 `6` 个 `PASS_TO_PASS`，说明它更像“修对了主症状，但副作用控制不住”
- 这组结果很关键，因为它把 benchmark 的问题空间进一步缩小了：当前瓶颈不再是“产不出 patch”或“大面积空 patch”，而是两类更具体的正确性问题
  1. `requests-2148` 这种“离 resolve 只差最后一个目标测试”
  2. `requests-2674` 这种“目标测试过了，但引入了旧行为回归”

## 按硬门槛看进度

### 1. Memory

状态：`部分完成`

已经有：

- `MemoryRecord` 领域模型
- `memory_records` MySQL schema
- `MySqlMemoryRepository`
- runtime service 里可写入、可读取 session/workspace memory

还没有：

- 真正的 memory retrieval 策略注入到完整 agent 执行链路
- memory 生成/压缩规则
- memory 相关场景测试

### 2. Multi-session

状态：`部分完成`

已经有：

- `Session` 领域模型
- `sessions` MySQL schema
- create / get / list / rename / archive / updateSummary / setActiveGoal
- list child sessions
- session summary Redis cache
- runtime service 里已经有 `create -> rename -> child lineage -> archive -> list` 的多会话场景测试

还没有：

- fork session
- checkpoint 驱动的 resume/fork
- session API / UI
- 更完整的 multi-session 场景测试

### 3. Subagent

状态：`部分完成`

已经有：

- `SubagentRun` 领域模型
- `subagent_runs` schema
- 默认 agent profile 和 tool policy
- `MySqlSubagentRunRepository`
- runtime service 里可以创建和完成 subagent run 记录
- 可以从父 session 真实创建 child session
- 可以在 delegation 时复制 active goal 到 child session
- delegation 时会给 child session 追加 system message 说明委托上下文
- 完成 subagent run 时可以把结果吸收到父 session
- 可以按需要归档 child session，并同步更新 child goal / summary
- delegation 和 completion 现在会联动父 task 状态
- 可以通过 `getSubagentRunReplay()` 聚合 child session 的 message / checkpoint / tool invocation / task
- 可以通过 `getParentTaskExecutionTrace()` 聚合 parent task、自身工具调用、delegated runs 与 child replay
- 可以通过 `cleanupChildSessions()` 批量归档已结束 child session，并返回跳过原因
- `completeSubagentRun()` 已支持按策略自动 cleanup
- `apps/ide-web/src/panels.ts` 已能生成 `subagent replay` 和 `parent task delegation` 面板状态
- `apps/ide-web/src/shell.ts` 已经把 `agent conversation + workspace explorer/editor + terminal` 组织进单主工作区，不再把 messages/files 拆成两个主 tab
- `apps/ide-web/src/shell.ts` 现在进一步把左/右侧边栏压缩成顶部信息条和横向 session strip，避免无效信息占用主编辑区宽度
- `apps/ide-web/src/shell.ts` 现在把 workspace explorer、editor、terminal 都收成固定区域和独立滚动容器，当前 workbench 至少具备 agent IDE 的基础“聊、看、改、跑”能力
- `apps/ide-web/src/browser.ts` 已经把点击导航、prompt 提交、文件保存和终端命令提交都接进浏览器运行时，页面不再只是只读壳层
- `apps/ide-web/src/browser.ts / server.ts / shell.ts` 现在会共同维护 pane visibility：`conversationPane / terminalPane` 会通过 URL navigation、浏览器动作 reducer 和 POST 边界一起传递，保证工作区布局状态可恢复
- `apps/ide-web/src/server.ts` 已经提供最小 HTTP 边界，既支持浏览器取 shell HTML / JSON state，也支持 POST prompt / save-file / terminal-run
- `apps/ide-web/src/dev-server.ts` 已经把 prompt 提交接到 `runtime.langGraph.invoke()`，并支持无 session 时自动创建 session
- `packages/runtime/src/langgraph.ts` 已经把 executor 的结构化 `toolCalls` 接进 `RuntimeToolExecutor`，不再只是把“正在读取文件”写成一条消息
- `packages/runtime/src/langgraph.ts` 现在会把工具输出回写成 `tool` message，并同步留下 `tool_invocations`，这样 replay / activity 才真的有执行证据
- `packages/runtime/src/langgraph.ts` 现在会同时做两层控制：一层拦截完全相同的重复工具调用，另一层按路径维护 `view` 的 reread budget，并通过 `LOOP_GUARD` system message 把约束显式反馈给下一轮 executor
- loop guard 现在只针对“成功的重复工具调用”生效，失败的工具调用会把错误信息留给下一轮修参，不会被误判成成功循环
- `apps/ide-web/src/minimax.ts` 现在会把最近的工具调用摘要带进 `runtimeState` digest，并显式要求 executor 输出 `executionPhase`，把 mixed explain + edit 任务拆成 `explain -> modify -> finalize` 这种更清晰的执行相位
- `packages/runtime/src/langgraph.ts` 这轮又补了一层 mixed explain + edit 续跑策略：如果模型在 `explain` phase 先给了解释、但还没真实执行 `edit/write`，runtime 不会直接收尾，而是追加一条 `EXECUTION_POLICY` system message，强制下一轮切到 `modify` phase 继续落改动
- `apps/ide-web/src/server.ts` 和 `apps/ide-web/src/browser.ts` 也补了更稳的 API 错误边界：invoke/save-file/terminal-run 这类 IDE API 现在会返回结构化 JSON error，浏览器端不再盲目 `response.json()`，真实错误不会再被二次 `SyntaxError` 掩盖成一句模糊的“Agent 调用失败”
- 已有 subagent delegation / absorb / replay / cleanup 的局部测试

还没有：

- 更复杂的 subagent runtime 执行
- 更完整的自动清理策略持久化，例如按 workspace 配置、按 agent mode 配置
- 更完整的浏览器运行时和交互层展示，比如局部更新、错误边界、输入中的 loading 状态、真正的 Monaco 工作流和真正 PTY 级终端
- 更完整的 subagent 场景测试

### 4. Planning mode

状态：`部分完成`

已经有：

- `plan` agent mode
- tool policy 模型
- plan mode 的 allow / deny 规则定义
- `ToolRegistry` 会在 dispatch 前真正检查 policy
- 被 deny 的工具现在会抛出明确错误，而不是只靠 prompt 自觉
- 第一批真实工具已经接入：`list / view / grep / write / edit / bash`
- `RuntimeToolExecutor` 会在执行前后记录 tool invocation
- 已有最小验证：`build` 模式真实执行文件工具，`plan` 模式真实拒绝写工具，`bash` 需要显式批准

还没有：

- 更完整的工具覆盖和回归测试
- UI / runtime 对 planning mode 的可视反馈

### 5. Goal-driven workflow

状态：`部分完成`

已经有：

- `Goal / Plan / Task / ReviewReport` 领域模型
- 对应 MySQL schema
- runtime service 里创建 goal、保存 plan、同步 task、review goal、更新 summary
- graph workflow 节点定义
- 最小 LangGraph adapter 已接入，能用 `thread_id` 驱动 `intake -> clarify -> plan -> delegate -> execute -> review -> summarize -> continue-or-close`
- LangGraph 节点已经真实调用 runtime service，并把每个节点结果同步写入 checkpoint
- 自定义 `PersistentLangGraphCheckpointSaver` 已实现
- 已有 `langgraph_checkpoints / langgraph_checkpoint_writes` MySQL schema
- LangGraph runtime 现在可以显式注入持久化 checkpointer，而不是默认依赖 `MemorySaver`
- `packages/db/src/bootstrap.ts` 已经把数据库创建、schema 应用、必需表检查串起来
- `apps/ide-web/src/bootstrap.ts` 已经把 MySQL、Redis、runtime store、tool registry、LangGraph 接成启动链路
- `packages/evals/src/persistence-smoke.ts` 已经可以跑真实基础设施 smoke
- `2026-03-21` 用 Docker 启动真实 `MySQL 8.4 + Redis 7` 跑通了 smoke：
  创建数据库成功、初始 schema 应用成功、Redis `PONG`、LangGraph 持久化写入 `10` 条 checkpoints 和 `25` 条 checkpoint writes
- 这次真实验证还额外逼出了并修复了 3 个基础设施问题：
  workspace 长路径唯一索引超 MySQL key length、ISO 时间串和 DATETIME 的适配、MySQL JSON 列返回形态适配
- `apps/ide-web/src/minimax.ts` 已经把外部模型接入点收敛成 `LangGraphHooks`
- `packages/evals/src/minimax-smoke.ts` 已经提供真实模型 smoke 入口
- `packages/db/src/env.ts` 已经把工作区级配置自动加载收敛成公共 helper
- `2026-03-21` 已经用真实 `MiniMax` API key 跑通一次 smoke，拿到了 goal / plan / execute / review / summarize 的外部模型证据
- 当前自动化验证已经到 `69` 个测试，全绿
- `MiniMax` 适配层已经补上“超限数组自动裁剪”和“校验失败后 repair 重试”的回归测试
- `MiniMax` 适配层已经补上“executor 从现有 state 补全缺失 task 字段”和“smoke 复用 session 参数解析”的回归测试
- IDE 工作台已经补上“shell 渲染文件编辑表单”“浏览器保存文件”“服务端 save-file 边界”“无 session 时也能展示 workspace 文件预览”的测试
- LangGraph 已经补上“executor 先 `view` 再 `edit`，并真实改动临时文件”的工具循环测试
- LangGraph 已经补上“重复 `view` 会被 loop guard 拦截，并推动后续 `edit`”的回归测试
- LangGraph 已经补上“失败的重复工具调用不会误触发 loop guard”的回归测试
- `RuntimeToolExecutor` 已经补上“edit 兼容 `file_path + oldString/newString` 风格参数”的回归测试
- `RuntimeToolExecutor` 已经补上“edit 兼容 `oldText/newText` 风格参数”的回归测试
- `RuntimeToolExecutor` 已经补上“bash 兼容 `cmd / working_directory / timeout_ms` 风格参数”的回归测试
- MiniMax hooks 已经补上“executor 返回 `toolCalls` 请求 runtime 走真实工具循环”的回归测试
- LangGraph 已经补上“行为性修改在真实 edit 后，没有 verify 不会直接 finalize；verify 失败后也不会直接收尾”的回归测试
- LangGraph 已经补上“纯注释修改不会被错误地强制进入 verify phase”的回归测试
- MiniMax hooks 已经补上“executionPhase 会把 validation 这类别名归一化成 verify”的回归测试
- benchmark 适配层已经补上“导出 CLI 参数解析”“JSON/JSONL 实例文件解析”“SWE-bench prompt 约束”和“默认 runId 格式”的回归测试
- 第一轮 5 条 SWE-bench Lite baseline 也逼出了 3 个真实问题：
  repo cache 不能用 partial clone 派生实例工作区、provider 瞬时 500 需要重试、agent 在 benchmark 场景下仍存在“只读不改”和工具参数别名不稳的问题
- 第二轮 baseline 说明这轮执行层优化已经起效：`pytest-dev__pytest-5227` 和两条 `requests` 实例都已经能产出真实 patch，但 `pallets__flask-4045 / pallets__flask-4992` 仍然是空 patch，下一步优化重点已经比较明确

还没有：

- versioned migration / rollback 机制
- 完整 review -> summarize -> continue 闭环自动化
- goal-driven 场景测试

## 当前已落地的代码层

### 文档和约束层

- `docs/agent-architecture.md`
- `docs/agent-definition-of-done.md`
- `docs/reading-guide.md`
- `docs/langgraph-in-project.md`
- `docs/project-deep-dive.md`
- `docs/interview-notes.md`
- `docs/local-infra.md`
- `.codex/skills/agent-self-check/SKILL.md`
- `.codex/skills/goal-driven-delivery/SKILL.md`

### 领域和 runtime 合同层

- `packages/core/src/domain.ts`
- `packages/runtime/src/graph.ts`
- `packages/runtime/src/store.ts`
- `packages/runtime/src/service.ts`
- `packages/runtime/src/tooling.ts`
- `packages/runtime/src/tooling.test.ts`
- `packages/runtime/src/subagents.test.ts`
- `packages/runtime/src/multi-session.test.ts`
- `packages/runtime/src/langgraph.ts`
- `packages/runtime/src/langgraph.test.ts`

### 持久化和基础设施层

- `compose.yaml`
- `packages/db/sql/001_initial_schema.sql`
- `packages/db/src/config.ts`
- `packages/db/src/env.ts`
- `packages/db/src/env.test.ts`
- `packages/db/src/mysql.ts`
- `packages/db/src/redis.ts`
- `packages/db/src/cache.ts`
- `packages/db/src/repositories.ts`
- `packages/db/src/runtime-store.ts`
- `packages/db/src/langgraph-checkpointer.ts`
- `packages/db/src/langgraph-checkpointer.test.ts`
- `packages/db/src/bootstrap.ts`
- `packages/tools/src/registry.ts`
- `packages/tools/src/builtin.ts`
- `apps/ide-web/src/bootstrap.ts`
- `apps/ide-web/src/panels.ts`
- `apps/ide-web/src/panels.test.ts`
- `apps/ide-web/src/shell.ts`
- `apps/ide-web/src/shell.test.ts`
- `apps/ide-web/src/browser.ts`
- `apps/ide-web/src/browser.test.ts`
- `apps/ide-web/src/server.ts`
- `apps/ide-web/src/server.test.ts`
- `apps/ide-web/src/dev-server.ts`
- `apps/ide-web/src/minimax.ts`
- `apps/ide-web/src/minimax.test.ts`
- `packages/evals/src/minimax-smoke.ts`
- `packages/evals/src/persistence-smoke.ts`
- `packages/evals/src/swebench-lite.ts`
- `packages/evals/src/swebench-lite.test.ts`
- `packages/evals/scripts/export_swebench_lite_subset.py`
- `docs/swebench-lite.md`

## 现在最应该继续做什么

按优先级排序：

1. 把当前这批 5 条 SWE-bench Lite 结果真正送进官方 harness，拿到第一版评分报告，而不是只停在 patch 产出基线
2. 把当前 server-driven workbench 继续推进成更完整的浏览器交互层，比如更细的 panel 切换、局部更新、loading / error 反馈、新建 session 交互，以及真正的编辑器 / 终端面板
3. 继续扩展 subagent orchestration，比如更持久化的 cleanup policy、结果回放面板交互、child session 生命周期策略
4. 补更多 subagent / multi-session / LangGraph 场景测试，把当前 smoke 继续发展成稳定场景集
5. 补 versioned migration / rollback，别让 schema 演进只靠初始 SQL
6. 扩展真实模型 smoke 覆盖面，比如更复杂输入、planning mode、subagent 决策、跨 session 追问和异常返回

## 明确还不能说完成的地方

现在绝对不能说项目已经完成，因为：

- persistence 虽然已经有 bootstrap 和真实数据库 smoke，但还没有 versioned migration / rollback
- subagent 虽然已经进入运行时，而且已经能 replay / cleanup / trace，但还不是完整 orchestration 能力
- planning mode 虽然已经进入执行层，而且工具循环也已经接通，但还缺更完整的真实工具覆盖和 UI 可视反馈
- 只有局部测试和 smoke，还没有完整场景测试体系
- 目前虽然已经有可提交 prompt 的单主工作区 workbench，也已经能浏览 workspace 文件并执行最小终端命令，但还不是完整 IDE UI，也还没有真正的 Monaco 工作流、PTY 级终端和前端框架层的组件化交互
- MiniMax hooks 已经拿到第一条真实外部模型调用证据，但覆盖面还不够广
- SWE-bench Lite 适配层已经不只是“搭好”，而是已经真实跑完同一批 5 条实例两轮 baseline，并且官方 harness 结果也已经开始形成连续反馈链：首轮 5 条实例 `1/5 resolve`，随后 `pallets__flask-4992` 官方 resolve，再之后 `pallets__flask-4045` 也已经在单实例 rerun 上被官方判定 resolve。尽管如此，还不能说 benchmark 已完成，因为整体正式结果仍然偏低，通过率也远没有稳定

## 下一次更新这份文档时应当回答的问题

1. 有没有新增“真正运行起来”的能力，而不只是合同？
2. 哪个硬门槛第一次被完整关闭了？
3. 有没有新的场景测试？
4. 有没有把“受保护术语”变成真实运行能力？
