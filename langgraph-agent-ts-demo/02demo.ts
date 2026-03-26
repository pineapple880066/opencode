import { END, GraphNode, MessagesValue, START, StateGraph, StateSchema } from "@langchain/langgraph";

// state只维护 `messages`
const State = new StateSchema({
    messages: MessagesValue,
});

type MiniMaxChatCompletionResponse = {
    choices?: Array<{
        message?: {
            content?: string;
            role?: string;
        };
    }>;

    error?: {
        message?: string;
    };
};

function toMiniMaxRole(kind: string): "user" | "assistant" | "system" {
    if (kind === "ai") {
        return "assistant"
    }

    if (kind === "system") {
        return "system"
    }

    return "user"
}

const callModel: GraphNode<typeof State> = async (state) => {
    const apiKey = process.env.MINIMAX_API_KEY;

    const baseUrl = process.env.MINIMAX_BASE_URL;

    const model = process.env.MINIMAX_MODEL;

    if (!apiKey) {
        throw new Error("Missing MINIMAX_API_KEY. Export it before running this file.");
    }
    if (!baseUrl) {
        throw new Error("Missing MINIMAX_BASE_URL. Export it before running this file.");
    }
    if (!model) {
        throw new Error("Missing MINIMAX_MODEL. Export it before running this file.");
    }

    const messages = state.messages.map((message) => ({
        role: toMiniMaxRole(message.getType()),
        content:
            typeof message.content === "string"
                ? message.content :
                JSON.stringify(message.content),
    }));

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: 1.0,
        }),
    });

    const data = (await response.json()) as MiniMaxChatCompletionResponse

    if (!response.ok) {
        throw new Error(data.error?.message ?? `MiniMax request failed with status ${response.status}.`)
    }

    const assistantText = data.choices?.[0]?.message?.content ?? "MiniMax 没有返回文本内容"

    return {
        messages: [
            {
                role: "assistant",
                content: assistantText,
            },
        ],
    };
};

const graph = new StateGraph(State)
    .addNode("callModel", callModel)
    .addEdge(START, "callModel")
    .addEdge("callModel", END)
    .compile();

async function main() {
    const result = await graph.invoke({
        messages: [
            {
                role: "user",
                content: "用三句话概括 langgraph 的核心概念",
            },
        ],
    });

    const lastMessage = result.messages.at(-1);

    console.log(
        typeof lastMessage?.content === "string"
            ? lastMessage.content
            : JSON.stringify(lastMessage?.content, null, 2),
    );
}

void main();

