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
}

export interface IdeShellInvokeResult {
  sessionId: string;
}

export interface IdeShellSaveFileRequest {
  workspacePath: string;
  filePath: string;
  content: string;
  sessionId?: string;
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

        const invokeResult = await options.invoke({
          workspacePath,
          prompt,
          sessionId: input.sessionId?.trim() || undefined,
          selectedFilePath: input.selectedFilePath?.trim() || undefined,
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
      const message = error instanceof Error ? error.message : "Unknown Error";
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
