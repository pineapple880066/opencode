---
name: goal-driven-delivery
description: 这个 skill 用于本仓库的功能开发，要求所有交付都绑定到明确的 goal、success criteria、plan、execution 和 review。 Use this for feature work tied to explicit goals and review.
---

# Goal Driven Delivery

这个仓库应该通过明确的 goal 闭环来推进，而不是一边写一边漂移。

## 默认循环

每个重要任务都应该走这条链路：

1. 定义 active goal。
2. 写出 success criteria。
3. 明确当前 plan 或 plan delta。
4. 只实现能推进这个 goal 的工作。
5. review 当前 goal 是否满足。
6. 把应该沉淀的内容写成 memory。
7. 如果这次改动改变了架构理解、实现进度或面试讲法，必须同步更新：
   - `docs/interview-notes.md`
   - `docs/progress.md`

## 最低表达结构

每个实现任务都应该能被表达成下面这个结构：

- goal
- success criteria
- current phase
- risks
- evidence
- next step

## 防漂移规则

- 在 runtime 合同还没稳定前，不要先冲去做 UI 美化。
- 在 policy enforcement 还没落地前，不要先大量加工具。
- 在 parent-child ownership 还没建模前，不要先做 subagent。
- 如果只是存了聊天记录，不要说 memory 已经有进展。
- 如果已经发生了关键实现变化，不要忘了同步更新面试文档和进度文档。

## 推荐用语

更推荐这样表达：

- "This step advances the active goal by..."
- "This remains blocked because..."
- "This is not complete yet because..."

尽量避免这样表达：

- "We can fix it later" when the missing piece is structural
- "Probably enough" when success criteria are unmet
