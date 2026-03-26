// 从 LangGraph 里导入几个最核心的东西。
// `START` 表示图的起点。
// `END` 表示图的终点。
// `StateSchema` 用来定义 state 的结构。
// `GraphNode` 用来约束节点函数的类型。
// `StateGraph` 用来把节点和边连成一张图。
import { END, GraphNode, START, StateGraph, StateSchema } from "@langchain/langgraph";

// 用 zod 来声明字段类型。
import * as z from "zod";

// 这是“输入 state”。
// 它表示：这个图在一开始只要求你传入一个 `question` 字符串。
const InputState = new StateSchema({
  // `question` 的类型是字符串。
  question: z.string(),
});

// 这是“输出 state”。
// 它表示：这个图最终只会对外返回一个 `answer` 字符串。
const OutputState = new StateSchema({
  // `answer` 的类型是字符串。
  answer: z.string(),
});

// 这是“图内部真正流转的完整 state”。
// 因为节点在中间处理时，既要读 `question`，也要写 `answer`，
// 所以内部 state 同时包含这两个字段。
const OverallState = new StateSchema({
  // 这是用户问题。
  question: z.string(),
  // 这是节点算出来的答案。
  answer: z.string(),
});

// 这里定义一个节点函数。
// 这个节点接收当前 state，然后返回一个“state 更新”对象。
const answerNode: GraphNode<typeof OverallState> = (state) => {
  // 返回值不是“修改原对象”，而是“告诉 LangGraph 我要更新哪些字段”。
  return {
    // 这里把原来的 question 原样带回去，方便你看到 state 是怎么传递的。
    question: state.question,
    // 这里根据输入问题拼一个最简单的回答。
    answer: `你刚才问的是: ${state.question}`,
  };
};

// 这里开始真正组装图。
const graph = new StateGraph({
  // 指定图的输入 schema。
  input: InputState,
  // 指定图的输出 schema。
  output: OutputState,
  // 指定图内部流转时使用的完整 schema。
  state: OverallState,
})
  // 给图添加一个名字叫 `answerNode` 的节点。
  .addNode("answerNode", answerNode)
  // 指定执行顺序：从起点进入 `answerNode`。
  .addEdge(START, "answerNode")
  // 指定执行顺序：`answerNode` 跑完后到终点。
  .addEdge("answerNode", END)
  // `compile()` 会把“定义阶段的图”编译成“可执行的图”。
  .compile();

// 用一个单独的 `main` 函数来承载异步逻辑。
// 这样能避免当前仓库的 CJS 运行方式不支持顶层 `await` 的问题。
async function main() {
  // `invoke()` 表示执行一次图。
  // 这里传进去的是“输入 state”，只需要满足 `InputState` 就行。
  const result = await graph.invoke({
    // 这里给图一个具体问题。
    question: "LangGraph 到底是干嘛的？",
  });

  // 打印最终结果。
  // 因为这个图声明了 `output: OutputState`，
  // 所以你最终看到的只会是输出 schema 里的字段，也就是 `answer`。
  console.log(result);
}

// 立即执行 `main()`。
void main();
