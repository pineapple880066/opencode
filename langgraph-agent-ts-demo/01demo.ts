import { END, GraphNode, START, StateGraph, StateSchema } from "@langchain/langgraph"
import * as z from "zod"

// 输入state :  question
const InputState = new StateSchema({
    question: z.string(),
});

// 输出state    
const OutputState = new StateSchema({
    answer: z.string(),
});

// 内部流转 state
const OverallState = new StateSchema({
    question: z.string(),
    answer: z.string(),
});

// 节点函数
const answerNode: GraphNode<typeof OverallState> = (state) => {
    // 更新的字段：
    return {
        question: state.question,
        answer: `你刚才问的是: ${state.question}`,
    };
};

// 组装图
const graph = new StateGraph({
    input: InputState,
    output: OutputState,
    state: OverallState,
})
    .addNode("answerNode", answerNode)
      // 指定执行顺序：从起点进入 `answerNode`。
      .addEdge(START, "answerNode")
      // 指定执行顺序：`answerNode` 跑完后到终点。
      .addEdge("answerNode", END)
      // `compile()` 会把“定义阶段的图”编译成“可执行的图”。
    .compile();
      
async function main() {
    const result = await graph.invoke({ // 执行
        question: "LangGraph 到底是干什么的？"
    });

    console.log(result);
}

void main();
