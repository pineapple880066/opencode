# LangGraph TypeScript Minimal Demo

这个目录只做一件事：用最短路径理解 LangGraph 的骨架。

你先只记住 5 个词：

1. `state`
2. `node`
3. `edge`
4. `compile()`
5. `invoke()`

## 你现在的环境

这个仓库根目录已经有这些依赖了，所以这里不用再新装：

- `@langchain/langgraph`
- `@langchain/core`
- `typescript`
- `tsx`
- `zod`

你只要在仓库根目录执行：

```bash
pnpm exec tsx langgraph-agent-ts-demo/01-basic-graph.ts
```

## 学习顺序

### 第 1 步：先看纯图

文件：`01-basic-graph.ts`

目标：先别碰模型，先看 LangGraph 的最小骨架。

你会看到：

- `StateSchema` 定义状态结构
- `GraphNode` 定义节点函数
- `StateGraph` 负责把节点和边连起来
- `START -> answerNode -> END`
- `invoke()` 触发一次执行

跑法：

```bash
pnpm exec tsx langgraph-agent-ts-demo/01-basic-graph.ts
```

## 第 2 步：把同样的图换成最小 agent

文件：`02-min-agent.ts`

目标：把节点里的逻辑换成一次真实模型调用。

这一版已经改成适配 MiniMax 大陆接口。

这个例子依然只有一个节点，所以结构非常直白：

`messages -> callModel -> messages`

跑之前先设置环境变量：

```bash
export MINIMAX_API_KEY="你的 key"
```

MiniMax 官方 OpenAI 兼容入口默认是：

```bash
export MINIMAX_BASE_URL="https://api.minimaxi.com/v1"
```

如果你的账号没有默认模型，就额外设置：

```bash
export MINIMAX_MODEL="MiniMax-M2.5"
```

然后运行：

```bash
pnpm exec tsx langgraph-agent-ts-demo/02-min-agent.ts
```

## 你应该重点观察什么

### 在 `01-basic-graph.ts` 里

- 输入 state 长什么样
- 节点接收什么，返回什么
- `invoke()` 为什么只传输入 state
- 为什么最后拿到的是输出 state

### 在 `02-min-agent.ts` 里

- `messages` 为什么适合做聊天 agent 的 state
- 节点为什么不改原 state，而是返回“更新”
- LangGraph 本身不负责帮你调用某个厂商模型，模型调用是你在节点里自己写的
- 为什么我们只是把 MiniMax API 调用塞进了一个节点里，整个程序就已经算一个最小 agent 了

## 一句话理解

LangGraph 本质上就是：

“定义一份状态，然后写几个函数节点，让状态按你指定的边流过去。”

你如果把这句话吃透，后面再学多节点、条件分支、工具调用，就不会乱。
