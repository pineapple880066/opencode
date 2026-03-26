// 从 LangGraph 里导入做聊天 agent 最常用的一组工具。
// `MessagesValue` 很重要，因为聊天 agent 最适合把消息列表放进 state。
import { END, GraphNode, MessagesValue, START, StateGraph, StateSchema } from "@langchain/langgraph";

// 这里定义图里的 state。
// 整个最小 agent 只维护一份东西：`messages`。
const State = new StateSchema({
  // `MessagesValue` 是 LangGraph 内置的消息字段类型。
  // 它会帮你处理消息列表的追加和格式转换。
  messages: MessagesValue,
});

// 这里只声明我们这次真正会用到的 MiniMax 响应字段。
// 你可以先把它理解成“从接口返回的大对象里，挑我们关心的最小部分出来”。
type MiniMaxChatCompletionResponse = {
  // `choices` 是模型候选输出列表。
  choices?: Array<{
    // 每个候选里都有一条 message。
    message?: {
      // 这里是模型真正返回的文本。
      content?: string;
      // 这里是角色，通常是 assistant。
      role?: string;
    };
  }>;
  // 如果接口报错，很多兼容接口会把错误信息放在这里。
  error?: {
    // 这是错误消息文本。
    message?: string;
  };
};

// LangGraph 里的消息类型和 OpenAI 兼容接口里的角色名不完全一样。
// 所以这里做一个最简单的映射。
function toMiniMaxRole(kind: string): "user" | "assistant" | "system" {
  // LangChain / LangGraph 里的 AI 消息类型是 `ai`。
  if (kind === "ai") {
    // MiniMax OpenAI 兼容接口里要写成 `assistant`。
    return "assistant";
  }

  // 系统消息在两边都很好理解，这里直接映射到 `system`。
  if (kind === "system") {
    return "system";
  }

  // 其他情况我们都按用户消息处理。
  return "user";
}

// 这里定义“模型节点”。
// 它做的事情很单纯：拿到当前 messages，调用一次 MiniMax，再把回答塞回 messages。
const callModel: GraphNode<typeof State> = async (state) => {
  // 读取 MiniMax API Key。
  const apiKey = process.env.MINIMAX_API_KEY;

  // 读取 MiniMax 的 base URL。
  // 根据官方 OpenAI 兼容文档，默认入口是 `https://api.minimaxi.com/v1`。
  const baseUrl = process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1";

  // 读取模型名。
  // 这里默认给一个简单又常见的值；如果你的套餐没有，就改成你账号里能用的模型。
  const model = process.env.MINIMAX_MODEL ?? "MiniMax-M2.5";

  // 如果没有 API Key，就直接报错。
  if (!apiKey) {
    throw new Error("Missing MINIMAX_API_KEY. Export it before running this file.");
  }

  // 把 LangGraph 的消息对象转换成 MiniMax OpenAI 兼容接口能吃的消息格式。
  const messages = state.messages.map((message) => ({
    // 角色要先转换。
    role: toMiniMaxRole(message.getType()),
    // `content` 通常是字符串。
    // 如果不是字符串，我们先简单转成 JSON 字符串，保证这个最小示例先能跑。
    content:
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
  }));

  // 发起 HTTP 请求。
  // 这里我们走的是 MiniMax 官方文档里说明的 OpenAI 兼容入口。
  // 用 `fetch` 而不是 SDK，是为了让你更容易看懂“节点里到底做了什么”。
  const response = await fetch(`${baseUrl}/chat/completions`, {
    // 请求方法是 POST。
    method: "POST",
    // 请求头里告诉服务端：我发的是 JSON，而且我带了 Bearer Token。
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    // 请求体里放模型名、消息列表，以及一个最简单的 temperature。
    body: JSON.stringify({
      model,
      messages,
      // MiniMax 官方文档说明 OpenAI 兼容接口里 `temperature` 取值范围是 (0, 1]，
      // 并推荐使用 1.0，所以这里直接写成 1。
      temperature: 1,
    }),
  });

  // 解析 JSON 响应。
  const data = (await response.json()) as MiniMaxChatCompletionResponse;

  // 如果 HTTP 状态码不是 2xx，就把服务端错误抛出来。
  if (!response.ok) {
    throw new Error(data.error?.message ?? `MiniMax request failed with status ${response.status}.`);
  }

  // 从返回结果里拿到第一条候选答案的文本。
  // MiniMax 官方文档提到 OpenAI 兼容接口的 `content` 里可能带 `<think>` 标签，
  // 这个最小示例先不做清洗，直接原样保留，方便你后面观察真实返回。
  const assistantText = data.choices?.[0]?.message?.content ?? "MiniMax 没有返回文本内容。";

  // 节点返回的依然不是“改原 state”，而是“返回一个 state 更新对象”。
  return {
    // 我们往 `messages` 里追加一条 assistant 消息。
    messages: [
      {
        // 角色是 assistant。
        role: "assistant",
        // 内容就是刚才从 MiniMax 拿到的文本。
        content: assistantText,
      },
    ],
  };
};

// 这里把模型节点装配成一张最小图。
const graph = new StateGraph(State)
  // 先把模型节点挂上去。
  .addNode("callModel", callModel)
  // 从起点进入模型节点。
  .addEdge(START, "callModel")
  // 模型节点跑完以后直接结束。
  .addEdge("callModel", END)
  // 编译成可执行图。
  .compile();

// 依然用 `main` 函数承载异步逻辑。
async function main() {
  // 执行一次图。
  const result = await graph.invoke({
    // 初始 state 里只放一条用户消息。
    messages: [
      {
        // 这条消息的角色是 user。
        role: "user",
        // 这条消息的内容就是你的问题。
        content: "用三句话解释 LangGraph 的核心概念。",
      },
    ],
  });

  // 拿到消息列表里的最后一条消息。
  const lastMessage = result.messages.at(-1);

  // 把最后一条消息打印出来。
  console.log(
    typeof lastMessage?.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage?.content, null, 2),
  );
}

// 立即执行 `main()`。
void main();
