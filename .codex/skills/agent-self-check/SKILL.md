---
name: agent-self-check
description: 这个 skill 用于本仓库中的重要工作，在宣布完成前强制对照 docs/agent-definition-of-done.md 做最终自检。 Use this for substantial repository work before claiming completion.
---

# Agent Self Check

这个 skill 的存在目的只有一个：防止这个仓库出现“表面做了，其实没做扎实”的交付。

## 什么时候用

只要工作涉及下面任意内容，就应该使用这个 skill：

- architecture
- runtime
- persistence
- tools
- sessions
- memory
- planning mode
- subagents
- milestone completion

## 强制工作流

1. 在宣布任何重大任务完成前，先读 `docs/agent-definition-of-done.md`。
2. 用那份文档里的五个强制能力门槛检查当前工作：
   - memory
   - multi-session
   - subagent
   - planning mode
   - goal-driven workflow
3. 如果当前任务只覆盖了系统的一部分，必须明确说出哪些门槛还没完成。
4. 只要 persistence、policy enforcement 或 scenario testing 还缺失，就不能说项目或里程碑已经完成。
5. 用词必须精确：
   - 如果只是脚手架，就说“已搭骨架”
   - 如果只有合同和类型，就说“已定义合同”
   - 只有在有测试或强验证证据时，才能说“已实现并验证”

## 收尾前必须自问的问题

在对重要工作给出最终回复前，必须先在内部回答：

1. 这次到底改了哪些代码或文档？
2. 哪些部分还只是合同层，没有落到运行实现？
3. 哪些行为已经在 runtime 代码里被强制执行？
4. 当前的验证证据是什么？
5. 还有哪些 definition-of-done 门槛是开着的？

只要还有门槛没关，就要直说还没完成，不能把工作包装成“已经做完”。

## 本仓库专属规则

在这个仓库里，`planning mode`、`subagent`、`memory` 这三个词属于“受保护术语”。
不要随便用。每个词都必须对应一个具体的持久化实体，或明确的 runtime 约束行为。
