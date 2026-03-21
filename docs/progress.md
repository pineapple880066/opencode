# 项目总进度

这份文档按仓库里的 `agent-self-check` 和 `goal-driven-delivery` 标准维护。
它的目标不是营造“好像做了很多”的感觉，而是明确现在到底做到了哪一步、还有哪些关键门槛没过。

## 当前阶段

当前处于：`Phase 1 基础层` 和 `Phase 2 执行层` 的交界位置。

一句话概括：

- 骨架、硬约束、持久化方向、MySQL/Redis 基础设施、runtime 应用服务雏形正在形成
- 真正的 LangGraph 执行、tool executor、subagent 执行、planning mode 工具拦截、IDE UI 还没有完成

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
- session summary Redis cache

还没有：

- fork session
- checkpoint 驱动的 resume/fork
- session API / UI
- multi-session 场景测试

### 3. Subagent

状态：`只有合同，未真正实现`

已经有：

- `SubagentRun` 领域模型
- `subagent_runs` schema
- 默认 agent profile 和 tool policy

还没有：

- subagent runtime 执行
- child session 创建与回收
- subagent delegation service
- subagent 场景测试

### 4. Planning mode

状态：`只有合同，未真正实现`

已经有：

- `plan` agent mode
- tool policy 模型
- plan mode 的 allow / deny 规则定义

还没有：

- 真正接到 tool dispatch 的拦截执行
- “受限工具被拒绝”的场景测试
- UI / runtime 对 planning mode 的可视反馈

### 5. Goal-driven workflow

状态：`部分完成`

已经有：

- `Goal / Plan / Task / ReviewReport` 领域模型
- 对应 MySQL schema
- runtime service 里创建 goal、保存 plan、同步 task、review goal、更新 summary
- graph workflow 节点定义

还没有：

- 真正的 LangGraph 执行器
- 完整 review -> summarize -> continue 闭环自动化
- goal-driven 场景测试

## 当前已落地的代码层

### 文档和约束层

- `docs/agent-architecture.md`
- `docs/agent-definition-of-done.md`
- `docs/reading-guide.md`
- `.codex/skills/agent-self-check/SKILL.md`
- `.codex/skills/goal-driven-delivery/SKILL.md`

### 领域和 runtime 合同层

- `packages/core/src/domain.ts`
- `packages/runtime/src/graph.ts`
- `packages/runtime/src/store.ts`
- `packages/runtime/src/service.ts`

### 持久化和基础设施层

- `packages/db/sql/001_initial_schema.sql`
- `packages/db/src/config.ts`
- `packages/db/src/mysql.ts`
- `packages/db/src/redis.ts`
- `packages/db/src/cache.ts`
- `packages/db/src/repositories.ts`
- `packages/db/src/runtime-store.ts`

## 现在最应该继续做什么

按优先级排序：

1. 把 runtime service 再往前推进，补 checkpoint / message / subagent persistence
2. 把 tool dispatch 和 tool policy 真正接起来，先把 planning mode 做成硬限制
3. 引入 LangGraph，把当前 service 挂到真实 graph state machine 上
4. 再做最小 IDE 界面，把 session、goal、plan、activity log 展示出来

## 明确还不能说完成的地方

现在绝对不能说项目已经完成，因为：

- persistence 还没有 migration 和真实数据库集成验证
- subagent 还是合同层，不是运行时能力
- planning mode 还是策略定义，不是执行层拦截
- 没有场景测试
- 没有真实 IDE 交互层

## 下一次更新这份文档时应当回答的问题

1. 有没有新增“真正运行起来”的能力，而不只是合同？
2. 哪个硬门槛第一次被完整关闭了？
3. 有没有新的场景测试？
4. 有没有把“受保护术语”变成真实运行能力？

