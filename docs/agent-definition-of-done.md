# Agent IDE 完成定义

这份文档不是建议，而是门槛。只要下面的必要项没满足，就不能宣称系统或某个阶段已经完成。

## 核心完成规则

一个功能只有在同时满足下面几点时，才算真正完成：

- 能力本身真的存在
- 该持久化的部分已经持久化
- 有场景测试覆盖这项能力
- 在 IDE 或 API 层可以看见、检查或恢复这项能力
- 如果还有延期项，必须明确写出剩余缺口

## 强制能力门槛

### 1. Memory

必须满足：

- 短期 session 状态可以持久化
- session summary 可以持久化
- 长期项目 memory 独立存在，不只是聊天记录
- runtime 里有明确的 memory 读取位置

不算完成的情况：

- 只存聊天消息
- 只在内存里保留一个滚动 summary
- 说“memory 以后再补”

必须提供的证据：

- memory 的 schema 或存储合同
- runtime 在执行前或执行中读取 memory 的路径
- 能证明重启后 state 还在的场景测试

### 2. Multi-session

必须满足：

- session 是持久化实体
- session 可以创建、恢复、重命名、归档、列出
- session 有 summary 和 status
- session lineage 能表达 fork 或 parent-child 关系

不算完成的情况：

- UI 里只是一个聊天窗口加几个 tab
- 只存标题，不存可恢复状态

必须提供的证据：

- session schema
- session repository 函数
- 至少覆盖 create -> resume -> archive 或 fork 的场景测试

### 3. Subagent

必须满足：

- subagent 有独立身份
- subagent 有显式 tool policy
- subagent 有边界清晰的上下文
- parent 和 child 的执行记录可以关联起来

不算完成的情况：

- 只是 prompt 前缀换了个角色名字
- 在同一份状态里跑多一轮，却没有 ownership 边界

必须提供的证据：

- subagent runtime 合同
- parent-child 持久化字段
- 覆盖 delegation 和结果回传的场景测试

### 4. Planning mode

必须满足：

- planning mode 有专门的 policy
- write、edit、patch、shell 工具会被拦截
- runtime 能明确暴露当前正处于 planning mode
- plan 是绑定到 active goal 的

不算完成的情况：

- 只在 prompt 里说“不要改文件”
- UI 上写了 plan mode，但底层没有真正限制

必须提供的证据：

- policy 定义
- tool dispatch 层的权限执行
- 能证明受限工具被拒绝的场景测试

### 5. Goal-driven workflow

必须满足：

- goal 是独立存储实体
- goal 有 success criteria
- plan 和 task 都能回指到 goal
- review 会明确判断 goal 是否满足

不算完成的情况：

- 随手写的 todo 文本
- 没有 success criteria 的临时任务列表

必须提供的证据：

- goal schema
- runtime 里从 plan 到 execute 再到 review 的状态流转
- 从 goal 打开到 goal 完成的场景测试

## 质量门槛

每个阶段还必须同时满足：

- 核心 runtime 表面有类型安全合同
- 每个关键新能力都有可回放或可脚本化的场景测试
- 日志或 trace 足够支撑排错
- 如果工作未完成，必须明确写出当前假设和缺口

## Anti-slop 规则

下面这些话一旦出现，就应该阻止“已经做完”的说法：

- “先这样也够用” 被用来掩盖缺失的持久化
- “模型一般会自己遵守” 被用来代替策略执行
- “之后手测一下就行” 被用来代替场景测试
- “UI 会让用户看明白” 被用来代替 runtime 合同
- “subagent” 实际只是另一个 prompt

## 每次结束重大任务前都必须自检

必须老实回答下面这些问题：

1. 我实现的是能力本身，还是只画了个草图？
2. 如果进程重启，这个能力还在吗？
3. 这个行为是代码强制执行的，还是只是写在 prompt 里？
4. 这件事能用自动化场景或回放来验证吗？
5. 如果我叫它 subagent，它真的有独立策略和作用域吗？
6. 如果我叫它 planning mode，它真的不能改工作区吗？
7. 如果我叫它 goal-driven，goal 实体在哪，review 又在哪？
8. 明天换个人来用，最先坏掉的会是什么？

只要其中有一项回答站不住，这个任务就不算完成。

## 阶段性检查点

### Foundation 里程碑

必须满足：

- 核心实体定义清楚
- runtime graph 状态定义清楚
- persistence 合同已经存在
- 仓库内已经有 self-check 工作流

### Runtime 里程碑

必须满足：

- sessions 能持久化
- memory 能持久化
- planning mode 有真实执行限制
- subagent run 能持久化
- goal 状态能贯穿 plan、execute、review

### IDE 里程碑

必须满足：

- session 列表可用
- active goal 和 plan 可见
- subagent 活动可检查
- run log 可检查
- 未完成工作会被明确暴露出来
