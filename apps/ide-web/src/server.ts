import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { GoalDrivenRuntimeService } from "@agent-ide/runtime";

import {
  parseIdeShellNavigation,
  renderIdeShellBrowserDocument,
} from "./browser.js";
import { buildIdeShellState, type IdeShellBuildOptions, type IdeShellNavigationInput } from "./shell.js";
import type { WorkbenchTerminalBackend } from "./terminal.js";

export interface IdeShellServerOptions {
  defaultWorkspacePath: string;
  documentPath?: string;
  statePath?: string;
  invokePath?: string;
  saveFilePath?: string;
  terminalRunPath?: string;
  invoke?: (input: IdeShellInvokeRequest) => Promise<IdeShellInvokeResult>;
  saveFile?: (input: IdeShellSaveFileRequest) => Promise<IdeShellSaveFileResult>;
  terminal?: WorkbenchTerminalBackend;
  runTerminal?: (input: IdeShellTerminalRunRequest) => Promise<IdeShellTerminalRunResult>;
}

export interface IdeShellStateResponse {
  navigation: IdeShellNavigationInput;
  state: Awaited<ReturnType<typeof buildIdeShellState>>;
}

export interface IdeShellInvokeRequest {
  workspacePath: string;
  prompt: string;
  sessionId?: string;
  selectedFilePath?: string;
  conversationPane?: "open" | "collapsed";
  terminalPane?: "open" | "collapsed";
}

export interface IdeShellInvokeResult {
  sessionId: string;
}

export interface IdeShellSaveFileRequest {
  workspacePath: string;
  filePath: string;
  content: string;
  sessionId?: string;
  conversationPane?: "open" | "collapsed";
  terminalPane?: "open" | "collapsed";
}

export interface IdeShellSaveFileResult {
  filePath: string;
  sessionId?: string;
}

export interface IdeShellTerminalRunRequest {
  workspacePath: string;
  command: string;
  sessionId?: string;
  selectedFilePath?: string;
  conversationPane?: "open" | "collapsed";
  terminalPane?: "open" | "collapsed";
}

export interface IdeShellTerminalRunResult {
  sessionId?: string;
  selectedFilePath?: string;
}

function writeResponse(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  method?: string,
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });

  if (method !== "HEAD") {
    response.end(body);
    return;
  }

  response.end();
}

function isJsonApiPath(pathname: string, options: IdeShellServerOptions): boolean {
  return pathname === (options.statePath ?? "/__ide__/state")
    || pathname === (options.invokePath ?? "/__ide__/invoke")
    || pathname === (options.saveFilePath ?? "/__ide__/save-file")
    || pathname === (options.terminalRunPath ?? "/__ide__/terminal/run");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf-8").trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

async function buildIdeShellStateResponse(
  service: GoalDrivenRuntimeService,
  requestUrl: URL,
  options: IdeShellServerOptions,
): Promise<IdeShellStateResponse> {
  const navigation = parseIdeShellNavigation(requestUrl, {
    workspacePath: options.defaultWorkspacePath,
  });
  const buildOptions: IdeShellBuildOptions = {
    terminal: options.terminal,
  };
  const state = await buildIdeShellState(service, navigation, buildOptions);

  return {
    navigation,
    state,
  };
}

// 这里是最小浏览器运行时对应的 HTTP 边界。
// 服务端负责把 navigation 转成 shell state，再输出 HTML 或 JSON，浏览器只处理点击和请求回放。
export function createIdeShellRequestHandler(
  service: GoalDrivenRuntimeService,
  options: IdeShellServerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const documentPath = options.documentPath ?? "/";
  const statePath = options.statePath ?? "/__ide__/state";
  const invokePath = options.invokePath ?? "/__ide__/invoke";
  const saveFilePath = options.saveFilePath ?? "/__ide__/save-file";
  const terminalRunPath = options.terminalRunPath ?? "/__ide__/terminal/run";

  return async (request, response) => {
    // 这个 request handler 是浏览器工作台的服务端边界。
    // 它同时处理两类请求：
    // 1. 取页面 / 取状态：返回 HTML 或 shell state JSON
    // 2. 执行动作：invoke、save-file、terminal-run
    //
    // 这里刻意不做复杂前端状态管理，而是把“当前页面应该是什么样”
    // 委托给 buildIdeShellState + renderIdeShellBrowserDocument。
    // 所以浏览器和服务端共享的是“导航协议”，而不是两套互相漂移的状态树。
    if (!request.url) {
      writeResponse(response, 400, "text/plain; charset=utf-8", "Bad Request", request.method);
      return;
    }

    try {
      const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
      const requestUrl = new URL(request.url, origin);

      if (requestUrl.pathname === saveFilePath) {
        if (request.method !== "POST") {
          writeResponse(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", request.method);
          return;
        }

        if (!options.saveFile) {
          writeResponse(
            response,
            501,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: "IDE shell save-file handler is not configured",
            }),
            request.method,
          );
          return;
        }

        const body = await readJsonBody(request);
        const input = typeof body === "object" && body !== null ? (body as Partial<IdeShellSaveFileRequest>) : {};
        const workspacePath = input.workspacePath?.trim() || options.defaultWorkspacePath;
        const filePath = input.filePath?.trim();

        if (!filePath) {
          writeResponse(
            response,
            400,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: "filePath is required",
            }),
            request.method,
          );
          return;
        }

        if (typeof input.content !== "string") {
          writeResponse(
            response,
            400,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: "content is required",
            }),
            request.method,
          );
          return;
        }

        const saveResult = await options.saveFile({
          workspacePath,
          filePath,
          content: input.content,
          sessionId: input.sessionId?.trim() || undefined,
          conversationPane: input.conversationPane === "collapsed" ? "collapsed" : "open",
          terminalPane: input.terminalPane === "collapsed" ? "collapsed" : "open",
        });

        writeResponse(
          response,
          200,
          "application/json; charset=utf-8",
          JSON.stringify({
            filePath: saveResult.filePath,
            navigation: {
              workspacePath,
              selectedSessionId: saveResult.sessionId ?? (input.sessionId?.trim() || undefined),
              selectedFilePath: saveResult.filePath,
              focusedPanel: "workbench",
              conversationPane: input.conversationPane === "collapsed" ? "collapsed" : "open",
              terminalPane: input.terminalPane === "collapsed" ? "collapsed" : "open",
            } satisfies IdeShellNavigationInput,
          }),
          request.method,
        );
        return;
      }

      if (requestUrl.pathname === terminalRunPath) {
        if (request.method !== "POST") {
          writeResponse(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", request.method);
          return;
        }

        if (!options.runTerminal) {
          writeResponse(
            response,
            501,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: "IDE shell terminal handler is not configured",
            }),
            request.method,
          );
          return;
        }

        const body = await readJsonBody(request);
        const input = typeof body === "object" && body !== null ? (body as Partial<IdeShellTerminalRunRequest>) : {};
        const workspacePath = input.workspacePath?.trim() || options.defaultWorkspacePath;
        const command = input.command?.trim();

        if (!command) {
          writeResponse(
            response,
            400,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: "command is required",
            }),
            request.method,
          );
          return;
        }

        const terminalResult = await options.runTerminal({
          workspacePath,
          command,
          sessionId: input.sessionId?.trim() || undefined,
          selectedFilePath: input.selectedFilePath?.trim() || undefined,
          conversationPane: input.conversationPane === "collapsed" ? "collapsed" : "open",
          terminalPane: input.terminalPane === "collapsed" ? "collapsed" : "open",
        });

        writeResponse(
          response,
          200,
          "application/json; charset=utf-8",
          JSON.stringify({
            navigation: {
              workspacePath,
              selectedSessionId: terminalResult.sessionId ?? (input.sessionId?.trim() || undefined),
              selectedFilePath: terminalResult.selectedFilePath ?? (input.selectedFilePath?.trim() || undefined),
              focusedPanel: "workbench",
              conversationPane: input.conversationPane === "collapsed" ? "collapsed" : "open",
              terminalPane: input.terminalPane === "collapsed" ? "collapsed" : "open",
            } satisfies IdeShellNavigationInput,
          }),
          request.method,
        );
        return;
      }

      if (requestUrl.pathname === invokePath) {
        if (request.method !== "POST") {
          writeResponse(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", request.method);
          return;
        }

        if (!options.invoke) {
          writeResponse(
            response,
            501,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: "IDE shell invoke handler is not configured",
            }),
            request.method,
          );
          return;
        }

        const body = await readJsonBody(request);
        const input = typeof body === "object" && body !== null ? (body as Partial<IdeShellInvokeRequest>) : {};
        const prompt = input.prompt?.trim();
        const workspacePath = input.workspacePath?.trim() || options.defaultWorkspacePath;

        if (!prompt) {
          writeResponse(
            response,
            400,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: "prompt is required",
            }),
            request.method,
          );
          return;
        }

        // invoke 路由是 agent 入口。
        // 它不直接返回一段 assistant 文本，而是返回“下一次导航应该怎么走”。
        // 这样浏览器收到响应后，会重新拉一份最新 shell 文档，
        // 页面看到的就是已经包含新消息、新 checkpoint、新工具痕迹的完整状态。
        const invokeResult = await options.invoke({
          workspacePath,
          prompt,
          sessionId: input.sessionId?.trim() || undefined,
          selectedFilePath: input.selectedFilePath?.trim() || undefined,
          conversationPane: input.conversationPane === "collapsed" ? "collapsed" : "open",
          terminalPane: input.terminalPane === "collapsed" ? "collapsed" : "open",
        });

        writeResponse(
          response,
          200,
          "application/json; charset=utf-8",
          JSON.stringify({
            sessionId: invokeResult.sessionId,
            navigation: {
              workspacePath,
              selectedSessionId: invokeResult.sessionId,
              selectedFilePath: input.selectedFilePath?.trim() || undefined,
              focusedPanel: "workbench",
              conversationPane: input.conversationPane === "collapsed" ? "collapsed" : "open",
              terminalPane: input.terminalPane === "collapsed" ? "collapsed" : "open",
            } satisfies IdeShellNavigationInput,
          }),
          request.method,
        );
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        writeResponse(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", request.method);
        return;
      }

      if (requestUrl.pathname === statePath) {
        const payload = await buildIdeShellStateResponse(service, requestUrl, options);
        writeResponse(
          response,
          200,
          "application/json; charset=utf-8",
          JSON.stringify(payload),
          request.method,
        );
        return;
      }

      if (requestUrl.pathname === documentPath) {
        const payload = await buildIdeShellStateResponse(service, requestUrl, options);
        const document = renderIdeShellBrowserDocument(payload.state, payload.navigation);
        writeResponse(response, 200, "text/html; charset=utf-8", document, request.method);
        return;
      }

      writeResponse(response, 404, "text/plain; charset=utf-8", "Not Found", request.method);
    } catch (error) {
      // 这里的 catch 不是简单兜底，而是专门区分：
      // - IDE API 请求：必须返回 JSON error，方便浏览器 runtime 解析
      // - 文档请求：返回纯文本 500 即可
      //
      // 之前如果这里一律回纯文本，浏览器端再去 response.json()，
      // 会先炸出一个新的 SyntaxError，把真实后端错误掩盖掉。
      const message = error instanceof Error ? error.message : "Unknown Error";
      console.error("[agent-ide] IDE shell request failed", {
        method: request.method,
        url: request.url,
        error,
      });

      if (request.url) {
        const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
        const requestUrl = new URL(request.url, origin);
        if (isJsonApiPath(requestUrl.pathname, options)) {
          writeResponse(
            response,
            500,
            "application/json; charset=utf-8",
            JSON.stringify({
              error: message,
            }),
            request.method,
          );
          return;
        }
      }

      writeResponse(response, 500, "text/plain; charset=utf-8", message, request.method);
    }
  };
}

export function createIdeShellServer(
  service: GoalDrivenRuntimeService,
  options: IdeShellServerOptions,
): Server {
  const handler = createIdeShellRequestHandler(service, options);

  return createServer((request, response) => {
    void handler(request, response);
  });
}
