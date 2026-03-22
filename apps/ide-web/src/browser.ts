import type { IdePanelId } from "./shell.js";
import {
  normalizeIdePanelId,
  reduceIdeShellNavigation,
  renderIdeShellDocument,
  type IdeShellAction,
  type IdeShellNavigationInput,
  type IdeShellState,
} from "./shell.js";

const NAVIGATION_SCRIPT_ID = "ide-shell-navigation";
const STATE_SCRIPT_ID = "ide-shell-state";
const INVOKE_PATH = "/__ide__/invoke";
const SAVE_FILE_PATH = "/__ide__/save-file";
const TERMINAL_RUN_PATH = "/__ide__/terminal/run";

function isIdePanelId(value: string | undefined): value is IdePanelId {
  return value === "workbench"
    || value === "goal"
    || value === "plan"
    || value === "activity-log"
    || value === "subagent-replay"
    || value === "parent-task-delegation"
    || value === "inspector";
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003C");
}

function injectBeforeClosingBody(document: string, markup: string): string {
  return document.replace("</body>", `${markup}\n  </body>`);
}

export function serializeIdeShellNavigation(
  input: IdeShellNavigationInput,
): URLSearchParams {
  const params = new URLSearchParams();

  params.set("workspacePath", input.workspacePath);

  if (input.selectedSessionId) {
    params.set("selectedSessionId", input.selectedSessionId);
  }
  if (input.selectedFilePath) {
    params.set("selectedFilePath", input.selectedFilePath);
  }
  if (input.selectedRunId) {
    params.set("selectedRunId", input.selectedRunId);
  }
  if (input.selectedParentTaskId) {
    params.set("selectedParentTaskId", input.selectedParentTaskId);
  }
  if (input.selectedTimelineIndex !== undefined) {
    params.set("selectedTimelineIndex", String(input.selectedTimelineIndex));
  }
  if (input.focusedPanel) {
    params.set("focusedPanel", input.focusedPanel);
  }
  if (input.conversationPane === "collapsed") {
    params.set("conversationPane", "collapsed");
  }
  if (input.terminalPane === "collapsed") {
    params.set("terminalPane", "collapsed");
  }

  return params;
}

export function parseIdeShellNavigation(
  source: URL | URLSearchParams,
  defaults?: { workspacePath?: string },
): IdeShellNavigationInput {
  const params = source instanceof URL ? source.searchParams : source;
  const workspacePath = params.get("workspacePath") ?? defaults?.workspacePath;

  if (!workspacePath) {
    throw new Error("workspacePath is required to build IDE shell navigation");
  }

  const selectedTimelineIndexRaw = params.get("selectedTimelineIndex");
  const focusedPanelRaw = params.get("focusedPanel") ?? undefined;

  return {
    workspacePath,
    selectedSessionId: params.get("selectedSessionId") ?? undefined,
    selectedFilePath: params.get("selectedFilePath") ?? undefined,
    selectedRunId: params.get("selectedRunId") ?? undefined,
    selectedParentTaskId: params.get("selectedParentTaskId") ?? undefined,
    selectedTimelineIndex:
      selectedTimelineIndexRaw !== null ? Number(selectedTimelineIndexRaw) : undefined,
    focusedPanel: normalizeIdePanelId(focusedPanelRaw),
    conversationPane: params.get("conversationPane") === "collapsed" ? "collapsed" : "open",
    terminalPane: params.get("terminalPane") === "collapsed" ? "collapsed" : "open",
  };
}

export function parseIdeShellActionDataset(
  dataset: Record<string, string | undefined>,
): IdeShellAction | null {
  switch (dataset.action) {
    case "focus-panel":
      return isIdePanelId(dataset.panel)
        ? { type: "focus-panel", panel: dataset.panel }
        : null;
    case "select-session":
      return dataset.sessionId
        ? { type: "select-session", sessionId: dataset.sessionId }
        : null;
    case "open-file":
      return dataset.filePath
        ? { type: "open-file", filePath: dataset.filePath }
        : null;
    case "open-replay":
      return dataset.runId
        ? { type: "open-replay", runId: dataset.runId }
        : null;
    case "open-parent-task":
      return dataset.parentTaskId
        ? { type: "open-parent-task", parentTaskId: dataset.parentTaskId }
        : null;
    case "inspect-timeline":
      return dataset.index !== undefined
        ? { type: "inspect-timeline", index: Number(dataset.index) }
        : null;
    case "toggle-conversation-pane":
      return { type: "toggle-conversation-pane" };
    case "toggle-terminal-pane":
      return { type: "toggle-terminal-pane" };
    default:
      return null;
  }
}

// 浏览器真正处理点击时，依然复用 shell 层的导航 reducer，
// 避免浏览器端和服务端各自维护一套不一致的导航规则。
export function reduceIdeShellBrowserAction(
  state: IdeShellState,
  action: IdeShellAction,
): IdeShellNavigationInput {
  return reduceIdeShellNavigation(state, action);
}

function buildBrowserRuntimeScript(): string {
  return `
(() => {
  const navigationScriptId = ${JSON.stringify(NAVIGATION_SCRIPT_ID)};
  const stateScriptId = ${JSON.stringify(STATE_SCRIPT_ID)};
  const invokePath = ${JSON.stringify(INVOKE_PATH)};
  const saveFilePath = ${JSON.stringify(SAVE_FILE_PATH)};
  const terminalRunPath = ${JSON.stringify(TERMINAL_RUN_PATH)};

  function readJsonScript(id) {
    const element = document.getElementById(id);
    if (!element) {
      return {};
    }

    try {
      return JSON.parse(element.textContent || "{}");
    } catch {
      return {};
    }
  }

  function serializeNavigation(input) {
    const params = new URLSearchParams();

    if (input.workspacePath) {
      params.set("workspacePath", input.workspacePath);
    }
    if (input.selectedSessionId) {
      params.set("selectedSessionId", input.selectedSessionId);
    }
    if (input.selectedFilePath) {
      params.set("selectedFilePath", input.selectedFilePath);
    }
    if (input.selectedRunId) {
      params.set("selectedRunId", input.selectedRunId);
    }
    if (input.selectedParentTaskId) {
      params.set("selectedParentTaskId", input.selectedParentTaskId);
    }
    if (input.selectedTimelineIndex !== undefined) {
      params.set("selectedTimelineIndex", String(input.selectedTimelineIndex));
    }
    if (input.focusedPanel) {
      params.set("focusedPanel", input.focusedPanel);
    }
    if (input.conversationPane === "collapsed") {
      params.set("conversationPane", "collapsed");
    }
    if (input.terminalPane === "collapsed") {
      params.set("terminalPane", "collapsed");
    }

    return params.toString();
  }

  function isPanelId(value) {
    return value === "workbench"
      || value === "goal"
      || value === "plan"
      || value === "activity-log"
      || value === "subagent-replay"
      || value === "parent-task-delegation"
      || value === "inspector";
  }

  function parseAction(target) {
    const action = target.dataset.action;

    switch (action) {
      case "focus-panel":
        return isPanelId(target.dataset.panel)
          ? { type: "focus-panel", panel: target.dataset.panel }
          : null;
      case "select-session":
        return target.dataset.sessionId
          ? { type: "select-session", sessionId: target.dataset.sessionId }
          : null;
      case "open-file":
        return target.dataset.filePath
          ? { type: "open-file", filePath: target.dataset.filePath }
          : null;
      case "open-replay":
        return target.dataset.runId
          ? { type: "open-replay", runId: target.dataset.runId }
          : null;
      case "open-parent-task":
        return target.dataset.parentTaskId
          ? { type: "open-parent-task", parentTaskId: target.dataset.parentTaskId }
          : null;
      case "inspect-timeline":
        return target.dataset.index !== undefined
          ? { type: "inspect-timeline", index: Number(target.dataset.index) }
          : null;
      case "toggle-conversation-pane":
        return { type: "toggle-conversation-pane" };
      case "toggle-terminal-pane":
        return { type: "toggle-terminal-pane" };
      default:
        return null;
    }
  }

  function reduceNavigation(state, action) {
    switch (action.type) {
      case "focus-panel":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: state.selectedSessionId,
          selectedFilePath: state.selectedFilePath,
          selectedRunId: state.selectedRunId,
          selectedParentTaskId: state.selectedParentTaskId,
          selectedTimelineIndex: state.selectedTimelineIndex,
          focusedPanel: action.panel,
          conversationPane: state.conversationPane,
          terminalPane: state.terminalPane,
        };
      case "select-session":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: action.sessionId,
          selectedFilePath: state.selectedFilePath,
          focusedPanel: "workbench",
          conversationPane: state.conversationPane,
          terminalPane: state.terminalPane,
        };
      case "open-file":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: state.selectedSessionId,
          selectedFilePath: action.filePath,
          selectedRunId: state.selectedRunId,
          selectedParentTaskId: state.selectedParentTaskId,
          focusedPanel: "workbench",
          conversationPane: state.conversationPane,
          terminalPane: state.terminalPane,
        };
      case "open-replay":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: state.selectedSessionId,
          selectedFilePath: state.selectedFilePath,
          selectedRunId: action.runId,
          selectedParentTaskId: state.selectedParentTaskId,
          focusedPanel: "subagent-replay",
          conversationPane: state.conversationPane,
          terminalPane: state.terminalPane,
        };
      case "open-parent-task":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: state.selectedSessionId,
          selectedFilePath: state.selectedFilePath,
          selectedRunId: state.selectedRunId,
          selectedParentTaskId: action.parentTaskId,
          focusedPanel: "parent-task-delegation",
          conversationPane: state.conversationPane,
          terminalPane: state.terminalPane,
        };
      case "inspect-timeline":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: state.selectedSessionId,
          selectedFilePath: state.selectedFilePath,
          selectedRunId: state.selectedRunId,
          selectedParentTaskId: state.selectedParentTaskId,
          selectedTimelineIndex: action.index,
          focusedPanel: "inspector",
          conversationPane: state.conversationPane,
          terminalPane: state.terminalPane,
        };
      case "toggle-conversation-pane":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: state.selectedSessionId,
          selectedFilePath: state.selectedFilePath,
          selectedRunId: state.selectedRunId,
          selectedParentTaskId: state.selectedParentTaskId,
          selectedTimelineIndex: state.selectedTimelineIndex,
          focusedPanel: state.focusedPanel,
          conversationPane: state.conversationPane === "open" ? "collapsed" : "open",
          terminalPane: state.terminalPane,
        };
      case "toggle-terminal-pane":
        return {
          workspacePath: state.workspacePath,
          selectedSessionId: state.selectedSessionId,
          selectedFilePath: state.selectedFilePath,
          selectedRunId: state.selectedRunId,
          selectedParentTaskId: state.selectedParentTaskId,
          selectedTimelineIndex: state.selectedTimelineIndex,
          focusedPanel: state.focusedPanel,
          conversationPane: state.conversationPane,
          terminalPane: state.terminalPane === "open" ? "collapsed" : "open",
        };
      default:
        return readJsonScript(navigationScriptId);
    }
  }

  async function navigate(nextNavigation, pushHistory) {
    const url = new URL(window.location.href);
    url.search = serializeNavigation(nextNavigation);

    const response = await fetch(url.toString(), {
      headers: {
        "x-agent-ide-browser-runtime": "shell",
      },
    });
    const html = await response.text();

    if (!response.ok) {
      throw new Error(html || \`HTTP \${response.status}\`);
    }

    if (pushHistory) {
      window.history.pushState({ navigation: nextNavigation }, "", url);
    }

    document.open();
    document.write(html);
    document.close();
  }

  async function submitPrompt(form) {
    const formData = new FormData(form);
    const prompt = String(formData.get("prompt") || "").trim();
    const workspacePath = String(formData.get("workspacePath") || "").trim();
    const sessionId = String(formData.get("sessionId") || "").trim();
    const selectedFilePath = String(formData.get("selectedFilePath") || "").trim();
    const conversationPane = String(formData.get("conversationPane") || "").trim();
    const terminalPane = String(formData.get("terminalPane") || "").trim();

    if (!prompt) {
      window.alert("请输入要让 agent 执行的 prompt。");
      return;
    }
    if (!workspacePath) {
      window.alert("当前缺少 workspacePath，无法提交 prompt。");
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true;
      submitButton.textContent = "Running...";
    }

    try {
      const response = await fetch(invokePath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspacePath,
          sessionId: sessionId || undefined,
          selectedFilePath: selectedFilePath || undefined,
          conversationPane: conversationPane === "collapsed" ? "collapsed" : "open",
          terminalPane: terminalPane === "collapsed" ? "collapsed" : "open",
          prompt,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || \`HTTP \${response.status}\`);
      }

      await navigate(payload.navigation, true);
    } finally {
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = false;
        submitButton.textContent = "Run Agent";
      }
    }
  }

  async function submitFileSave(form) {
    const formData = new FormData(form);
    const workspacePath = String(formData.get("workspacePath") || "").trim();
    const sessionId = String(formData.get("sessionId") || "").trim();
    const filePath = String(formData.get("filePath") || "").trim();
    const content = String(formData.get("content") || "");
    const conversationPane = String(formData.get("conversationPane") || "").trim();
    const terminalPane = String(formData.get("terminalPane") || "").trim();

    if (!workspacePath) {
      window.alert("当前缺少 workspacePath，无法保存文件。");
      return;
    }
    if (!filePath) {
      window.alert("当前没有选中文件，无法保存。");
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";
    }

    try {
      const response = await fetch(saveFilePath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspacePath,
          sessionId: sessionId || undefined,
          filePath,
          content,
          conversationPane: conversationPane === "collapsed" ? "collapsed" : "open",
          terminalPane: terminalPane === "collapsed" ? "collapsed" : "open",
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || \`HTTP \${response.status}\`);
      }

      await navigate(payload.navigation, true);
    } finally {
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = false;
        submitButton.textContent = "Save File";
      }
    }
  }

  async function submitTerminalCommand(form) {
    const formData = new FormData(form);
    const workspacePath = String(formData.get("workspacePath") || "").trim();
    const sessionId = String(formData.get("sessionId") || "").trim();
    const selectedFilePath = String(formData.get("selectedFilePath") || "").trim();
    const command = String(formData.get("command") || "").trim();
    const conversationPane = String(formData.get("conversationPane") || "").trim();
    const terminalPane = String(formData.get("terminalPane") || "").trim();

    if (!workspacePath) {
      window.alert("当前缺少 workspacePath，无法执行命令。");
      return;
    }
    if (!command) {
      window.alert("请输入要在 workspace 里执行的命令。");
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true;
      submitButton.textContent = "Running...";
    }

    try {
      const response = await fetch(terminalRunPath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspacePath,
          sessionId: sessionId || undefined,
          selectedFilePath: selectedFilePath || undefined,
          conversationPane: conversationPane === "collapsed" ? "collapsed" : "open",
          terminalPane: terminalPane === "collapsed" ? "collapsed" : "open",
          command,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || \`HTTP \${response.status}\`);
      }

      await navigate(payload.navigation, true);
    } finally {
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = false;
        submitButton.textContent = "Run Command";
      }
    }
  }

  const initialNavigation = readJsonScript(navigationScriptId);
  window.history.replaceState({ navigation: initialNavigation }, "", window.location.href);

  document.addEventListener("click", (event) => {
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) {
      return;
    }

    const actionTarget = rawTarget.closest("[data-action]");
    if (!(actionTarget instanceof HTMLElement)) {
      return;
    }

    const action = parseAction(actionTarget);
    if (!action) {
      return;
    }

    event.preventDefault();

    const currentState = readJsonScript(stateScriptId);
    const nextNavigation = reduceNavigation(currentState, action);

    void navigate(nextNavigation, true).catch((error) => {
      console.error("[agent-ide] browser navigation failed", error);
      window.alert("IDE shell 导航失败，请查看控制台日志。");
    });
  });

  document.addEventListener("submit", (event) => {
    const rawTarget = event.target;
    if (!(rawTarget instanceof HTMLFormElement)) {
      return;
    }

    event.preventDefault();

    if (rawTarget.dataset.ideSubmit === "invoke") {
      void submitPrompt(rawTarget).catch((error) => {
        console.error("[agent-ide] browser invoke failed", error);
        window.alert("Agent 调用失败，请查看控制台日志。");
      });
      return;
    }

    if (rawTarget.dataset.ideSubmit === "save-file") {
      void submitFileSave(rawTarget).catch((error) => {
        console.error("[agent-ide] browser file save failed", error);
        window.alert("文件保存失败，请查看控制台日志。");
      });
      return;
    }

    if (rawTarget.dataset.ideSubmit === "terminal-run") {
      void submitTerminalCommand(rawTarget).catch((error) => {
        console.error("[agent-ide] browser terminal run failed", error);
        window.alert("终端命令执行失败，请查看控制台日志。");
      });
    }
  });

  window.addEventListener("popstate", (event) => {
    const nextNavigation = event.state && event.state.navigation
      ? event.state.navigation
      : readJsonScript(navigationScriptId);

    void navigate(nextNavigation, false).catch((error) => {
      console.error("[agent-ide] browser history restore failed", error);
    });
  });
})();
  `.trim();
}

// 这里返回的是真正给浏览器吃的文档：
// 同一份 shell HTML 会附带当前导航、当前状态，以及一个最小浏览器运行时脚本。
export function renderIdeShellBrowserDocument(
  state: IdeShellState,
  navigation: IdeShellNavigationInput,
): string {
  const runtimeMarkup = `
    <script id="${NAVIGATION_SCRIPT_ID}" type="application/json">${safeJsonForHtml(navigation)}</script>
    <script id="${STATE_SCRIPT_ID}" type="application/json">${safeJsonForHtml(state)}</script>
    <script>${buildBrowserRuntimeScript()}</script>
  `;
  const document = renderIdeShellDocument(state).replace(
    "<body>",
    '<body data-browser-runtime="ide-shell">',
  );

  return injectBeforeClosingBody(document, runtimeMarkup);
}
