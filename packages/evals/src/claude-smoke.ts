import { pathToFileURL } from "node:url";

import { loadWorkspaceEnv } from "@agent-ide/db";
import { z } from "zod";

const claudeEnvSchema = z.object({
  CLAUDE_API_KEY: z.string().min(1),
  CLAUDE_BASE_URL: z.string().url().default("https://api.anthropic.com"),
  CLAUDE_MODEL: z.string().min(1),
  CLAUDE_PROTOCOL: z.enum(["anthropic", "openai_compat"]).default("anthropic"),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  CLAUDE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1200),
  CLAUDE_THINKING_BUDGET: z.coerce.number().int().min(0).default(0),
});

interface ClaudeSmokeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol: "anthropic" | "openai_compat";
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: number;
}

interface ClaudeSmokeInvocation {
  prompt: string;
  protocol?: "anthropic" | "openai_compat";
  showHelp: boolean;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readClaudeSmokeInvocation(argv: string[] = process.argv.slice(2)): ClaudeSmokeInvocation {
  const args = [...argv];
  const promptParts: string[] = [];
  let protocol: ClaudeSmokeInvocation["protocol"];
  let showHelp = false;

  while (args.length > 0) {
    const current = args.shift();
    if (!current) {
      continue;
    }

    if (current === "--anthropic") {
      protocol = "anthropic";
      continue;
    }

    if (current === "--openai-compat") {
      protocol = "openai_compat";
      continue;
    }

    if (current === "--help" || current === "-h") {
      showHelp = true;
      continue;
    }

    promptParts.push(current);
  }

  return {
    showHelp,
    prompt:
      promptParts.join(" ").trim()
      || "Return a compact JSON object with fields ok, provider, model, and note. The note should mention that this is a protocol smoke test.",
    protocol,
  };
}

function printHelp(): void {
  console.log("Usage: pnpm smoke:claude -- [--anthropic|--openai-compat] \"prompt\"");
  console.log("");
  console.log("Required env:");
  console.log("  CLAUDE_API_KEY");
  console.log("  CLAUDE_MODEL");
  console.log("");
  console.log("Optional env:");
  console.log("  CLAUDE_BASE_URL");
  console.log("  CLAUDE_PROTOCOL=anthropic|openai_compat");
  console.log("  CLAUDE_TIMEOUT_MS");
  console.log("  CLAUDE_MAX_OUTPUT_TOKENS");
  console.log("  CLAUDE_THINKING_BUDGET");
}

function readClaudeSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
  invocation?: ClaudeSmokeInvocation,
): ClaudeSmokeConfig {
  const parsed = claudeEnvSchema.parse({
    CLAUDE_API_KEY: env.CLAUDE_API_KEY,
    CLAUDE_BASE_URL: env.CLAUDE_BASE_URL,
    CLAUDE_MODEL: env.CLAUDE_MODEL,
    CLAUDE_PROTOCOL: invocation?.protocol ?? env.CLAUDE_PROTOCOL,
    CLAUDE_TIMEOUT_MS: env.CLAUDE_TIMEOUT_MS,
    CLAUDE_MAX_OUTPUT_TOKENS: env.CLAUDE_MAX_OUTPUT_TOKENS,
    CLAUDE_THINKING_BUDGET: env.CLAUDE_THINKING_BUDGET,
  });

  return {
    apiKey: parsed.CLAUDE_API_KEY,
    baseUrl: parsed.CLAUDE_BASE_URL,
    model: parsed.CLAUDE_MODEL,
    protocol: parsed.CLAUDE_PROTOCOL,
    timeoutMs: parsed.CLAUDE_TIMEOUT_MS,
    maxOutputTokens: parsed.CLAUDE_MAX_OUTPUT_TOKENS,
    thinkingBudget: parsed.CLAUDE_THINKING_BUDGET,
  };
}

function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = trimTrailingSlash(baseUrl);
  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }
  if (normalized.endsWith("/messages")) {
    return normalized;
  }
  return `${normalized}/v1/messages`;
}

function resolveOpenAiCompatUrl(baseUrl: string): string {
  const normalized = trimTrailingSlash(baseUrl);
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  return `${normalized}/v1/chat/completions`;
}

function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    return fenced.trim();
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }

  return raw.trim();
}

async function callAnthropicMessagesApi(
  config: ClaudeSmokeConfig,
  prompt: string,
  fetchImpl: typeof fetch,
): Promise<{ rawText: string; parsedJson: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxOutputTokens,
      system: "You are running a protocol smoke test. Respond with JSON only.",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    };

    if (config.thinkingBudget > 0) {
      body.thinking = {
        type: "enabled",
        budget_tokens: config.thinkingBudget,
      };
    }

    const response = await fetchImpl(resolveAnthropicMessagesUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Claude Anthropic-compatible request failed: ${response.status} ${rawText}`);
    }

    const payload = JSON.parse(rawText) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: unknown;
      id?: string;
    };
    const text = (payload.content ?? [])
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n")
      .trim();

    return {
      rawText: text,
      parsedJson: JSON.parse(extractJsonBlock(text)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAiCompatApi(
  config: ClaudeSmokeConfig,
  prompt: string,
  fetchImpl: typeof fetch,
): Promise<{ rawText: string; parsedJson: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(resolveOpenAiCompatUrl(config.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "You are running a protocol smoke test. Respond with JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    const rawResponse = await response.text();
    if (!response.ok) {
      throw new Error(`Claude OpenAI-compatible request failed: ${response.status} ${rawResponse}`);
    }

    const payload = JSON.parse(rawResponse) as {
      choices?: Array<{ message?: { content?: string } }>;
      id?: string;
      usage?: unknown;
    };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? "";

    return {
      rawText: text,
      parsedJson: JSON.parse(extractJsonBlock(text)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const invocation = readClaudeSmokeInvocation();
  if (invocation.showHelp) {
    printHelp();
    return;
  }
  const config = readClaudeSmokeConfig(process.env, invocation);
  const fetchImpl = globalThis.fetch;

  if (!fetchImpl) {
    throw new Error("fetch is not available in the current runtime");
  }

  const result =
    config.protocol === "anthropic"
      ? await callAnthropicMessagesApi(config, invocation.prompt, fetchImpl)
      : await callOpenAiCompatApi(config, invocation.prompt, fetchImpl);

  console.log(
    JSON.stringify(
      {
        ok: true,
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        model: config.model,
        rawText: result.rawText,
        parsedJson: result.parsedJson,
      },
      null,
      2,
    ),
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl && import.meta.url === entryUrl) {
  void main().catch((error) => {
    console.error("[agent-ide] Claude smoke failed", error);
    process.exit(1);
  });
}
