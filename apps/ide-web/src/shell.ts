import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import type { Task } from "@agent-ide/core";
import type {
  GoalDrivenRuntimeService,
  GraphMessage,
  PersistedCheckpoint,
  ToolInvocationLog,
} from "@agent-ide/runtime";

import {
  buildParentTaskDelegationPanelState,
  buildSubagentReplayPanelState,
  type ParentTaskDelegationPanelState,
  type ReplayTimelineItem,
  type SubagentReplayPanelState,
} from "./panels.js";
import type { WorkbenchTerminalBackend, WorkbenchTerminalEntry } from "./terminal.js";

export type IdePanelId =
  | "workbench"
  | "goal"
  | "plan"
  | "activity-log"
  | "subagent-replay"
  | "parent-task-delegation"
  | "inspector";

export interface IdeShellNavigationInput {
  workspacePath: string;
  selectedSessionId?: string;
  selectedFilePath?: string;
  selectedRunId?: string;
  selectedParentTaskId?: string;
  selectedTimelineIndex?: number;
  focusedPanel?: IdePanelId;
}

export interface IdeShellSessionItem {
  id: string;
  title: string;
  status: string;
  agentMode: string;
  isSelected: boolean;
  activeGoalTitle?: string;
}

export interface IdeShellMessageItem {
  id: string;
  role: GraphMessage["role"];
  content: string;
  createdAt: string;
}

export interface IdeShellGoalPanelState {
  id: string;
  title: string;
  description: string;
  status: string;
  successCriteria: string[];
}

export interface IdeShellPlanPanelState {
  id: string;
  summary: string;
  status: string;
  steps: Array<{
    id?: string;
    title: string;
    description: string;
    status: string;
    evidence?: string;
  }>;
}

export interface IdeShellWorkspaceEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
}

export interface IdeShellFilePreviewState {
  path: string;
  content: string;
  previewContent: string;
  totalLines: number;
  truncated: boolean;
}

export interface IdeShellActivityItem {
  id: string;
  kind: "message" | "checkpoint" | "tool";
  title: string;
  detail: string;
  createdAt: string;
  status?: string;
}

export interface IdeShellInspectorState {
  title: string;
  detail: string;
  source: "timeline";
}

export interface IdeShellTerminalEntryState {
  id: string;
  command: string;
  status: WorkbenchTerminalEntry["status"];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  combinedOutput: string;
}

export interface IdeShellState {
  workspacePath: string;
  focusedPanel: IdePanelId;
  sessions: IdeShellSessionItem[];
  selectedSessionId?: string;
  selectedSessionTitle?: string;
  selectedSessionStatus?: string;
  selectedSessionAgentMode?: string;
  selectedGoalTitle?: string;
  selectedSessionTaskCount: number;
  selectedSessionSubagentRunCount: number;
  selectedFilePath?: string;
  selectedRunId?: string;
  selectedParentTaskId?: string;
  selectedTimelineIndex?: number;
  availableRunIds: string[];
  availableParentTaskIds: string[];
  selectedSessionSummary?: string;
  selectedSessionOpenLoops: string[];
  selectedSessionNextActions: string[];
  selectedSessionImportantFacts: string[];
  messages: IdeShellMessageItem[];
  workspaceEntries: IdeShellWorkspaceEntry[];
  filePreview?: IdeShellFilePreviewState;
  goalPanel?: IdeShellGoalPanelState;
  planPanel?: IdeShellPlanPanelState;
  activityLog: IdeShellActivityItem[];
  replayPanel?: SubagentReplayPanelState;
  delegationPanel?: ParentTaskDelegationPanelState;
  inspector?: IdeShellInspectorState;
  terminalEntries: IdeShellTerminalEntryState[];
}

export type IdeShellAction =
  | { type: "focus-panel"; panel: IdePanelId }
  | { type: "select-session"; sessionId: string }
  | { type: "open-file"; filePath: string }
  | { type: "open-replay"; runId: string }
  | { type: "open-parent-task"; parentTaskId: string }
  | { type: "inspect-timeline"; index: number };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function describeTimelineItem(item: ReplayTimelineItem): string {
  return `${item.timestamp} ${item.title}${item.status ? ` [${item.status}]` : ""}`;
}

function findDelegatedParentTasks(tasks: Task[], runIdsByParentTask: Set<string>): Task[] {
  return tasks
    .filter((task) => runIdsByParentTask.has(task.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

export interface IdeShellBuildOptions {
  terminal?: WorkbenchTerminalBackend;
}

export function normalizeIdePanelId(value: string | undefined): IdePanelId | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "messages" || value === "files") {
    return "workbench";
  }

  if (
    value === "workbench"
    || value === "goal"
    || value === "plan"
    || value === "activity-log"
    || value === "subagent-replay"
    || value === "parent-task-delegation"
    || value === "inspector"
  ) {
    return value;
  }

  return undefined;
}

function resolveWithinWorkspace(workspacePath: string, candidatePath = "."): string {
  const normalizedRoot = path.resolve(workspacePath);
  const target = path.resolve(normalizedRoot, candidatePath);

  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`路径越界: ${candidatePath}`);
  }

  return target;
}

function toWorkspaceRelative(workspacePath: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(workspacePath), absolutePath);
  return relative || ".";
}

async function collectWorkspaceEntries(
  workspacePath: string,
  currentPath: string,
  depth: number,
  output: IdeShellWorkspaceEntry[],
  options: { maxDepth: number; maxEntries: number },
): Promise<void> {
  if (depth > options.maxDepth || output.length >= options.maxEntries) {
    return;
  }

  const directoryEntries = await readdir(currentPath, { withFileTypes: true });
  const sortedEntries = directoryEntries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .sort((left, right) => {
      if (left.isDirectory() && !right.isDirectory()) {
        return -1;
      }
      if (!left.isDirectory() && right.isDirectory()) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });

  for (const entry of sortedEntries) {
    if (output.length >= options.maxEntries) {
      return;
    }

    const absolutePath = path.join(currentPath, entry.name);
    output.push({
      path: toWorkspaceRelative(workspacePath, absolutePath),
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
      depth,
    });

    if (entry.isDirectory()) {
      await collectWorkspaceEntries(workspacePath, absolutePath, depth + 1, output, options);
    }
  }
}

async function buildWorkspaceBrowserState(
  workspacePath: string,
  selectedFilePath?: string,
): Promise<{
  entries: IdeShellWorkspaceEntry[];
  selectedFilePath?: string;
  preview?: IdeShellFilePreviewState;
}> {
  try {
    const normalizedRoot = path.resolve(workspacePath);
    const entries: IdeShellWorkspaceEntry[] = [];
    await collectWorkspaceEntries(normalizedRoot, normalizedRoot, 0, entries, {
      maxDepth: 3,
      maxEntries: 160,
    });

    const selectableFiles = entries.filter((entry) => entry.kind === "file");
    const nextSelectedFilePath =
      selectedFilePath && selectableFiles.some((entry) => entry.path === selectedFilePath)
        ? selectedFilePath
        : selectableFiles[0]?.path;

    if (!nextSelectedFilePath) {
      return {
        entries,
        selectedFilePath: undefined,
      };
    }

    const previewPath = resolveWithinWorkspace(normalizedRoot, nextSelectedFilePath);
    const rawContent = await readFile(previewPath, "utf8");
    const lines = rawContent.split(/\r?\n/);
    const limitedContent = lines.slice(0, 220).join("\n");

    return {
      entries,
      selectedFilePath: nextSelectedFilePath,
      preview: {
        path: nextSelectedFilePath,
        content: rawContent,
        previewContent: limitedContent,
        totalLines: lines.length,
        truncated: lines.length > 220,
      },
    };
  } catch {
    return {
      entries: [],
      selectedFilePath: undefined,
    };
  }
}

function formatRoleLabel(role: GraphMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
    case "user":
    default:
      return "User";
  }
}

function createComposerPlaceholder(state: IdeShellState): string {
  if (state.selectedSessionId) {
    return "继续描述你想让 agent 在当前 session 里推进什么...";
  }

  return "描述你想让 agent 做什么；如果当前没有 session，会自动创建一个新 session...";
}

function buildActivityLog(
  messages: GraphMessage[],
  checkpoints: PersistedCheckpoint[],
  toolInvocations: ToolInvocationLog[],
): IdeShellActivityItem[] {
  const messageItems: IdeShellActivityItem[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    title: `${formatRoleLabel(message.role)} message`,
    detail: truncate(message.content, 400),
    createdAt: message.createdAt,
  }));
  const checkpointItems: IdeShellActivityItem[] = checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    kind: "checkpoint",
    title: `checkpoint @ ${checkpoint.node}`,
    detail: checkpoint.summary,
    createdAt: checkpoint.createdAt,
  }));
  const toolItems: IdeShellActivityItem[] = toolInvocations.map((log) => ({
    id: log.id,
    kind: "tool",
    title: `tool: ${log.toolName}`,
    detail: truncate(log.outputJson ?? log.inputJson, 400),
    createdAt: log.createdAt,
    status: log.status,
  }));

  return [...messageItems, ...checkpointItems, ...toolItems].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

// 这里不是最终的前端框架组件，而是当前 server-driven IDE 的状态层。
// 它把 runtime 里的 session、message、goal、plan、activity 聚合成真正可交互的工作台状态。
export async function buildIdeShellState(
  service: GoalDrivenRuntimeService,
  input: IdeShellNavigationInput,
  options: IdeShellBuildOptions = {},
): Promise<IdeShellState> {
  const sessions = await service.listSessionsByWorkspacePath(input.workspacePath);
  const selectedSession = sessions.find((session) => session.id === input.selectedSessionId) ?? sessions[0];
  const terminalEntries = options.terminal
    ? await options.terminal.listEntries(input.workspacePath, { limit: 10 })
    : [];

  if (!selectedSession) {
    const workspaceBrowser = await buildWorkspaceBrowserState(input.workspacePath, input.selectedFilePath);
    return {
      workspacePath: input.workspacePath,
      focusedPanel: normalizeIdePanelId(input.focusedPanel) ?? "workbench",
      sessions: [],
      selectedSessionTaskCount: 0,
      selectedSessionSubagentRunCount: 0,
      availableRunIds: [],
      availableParentTaskIds: [],
      selectedSessionOpenLoops: [],
      selectedSessionNextActions: [],
      selectedSessionImportantFacts: [],
      messages: [],
      workspaceEntries: workspaceBrowser.entries,
      selectedFilePath: workspaceBrowser.selectedFilePath,
      filePreview: workspaceBrowser.preview,
      activityLog: [],
      terminalEntries: terminalEntries.map((entry) => ({
        id: entry.id,
        command: entry.command,
        status: entry.status,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        exitCode: entry.exitCode,
        combinedOutput: entry.combinedOutput,
      })),
    };
  }

  const [graphState, messages, checkpoints, toolInvocations, availableRuns, workspaceBrowser] = await Promise.all([
    service.buildGraphState(selectedSession.id),
    service.listMessages(selectedSession.id),
    service.listCheckpoints(selectedSession.id),
    service.listToolInvocations(selectedSession.id),
    service.listSubagentRuns(selectedSession.id),
    buildWorkspaceBrowserState(input.workspacePath, input.selectedFilePath),
  ]);

  const sessionsState: IdeShellSessionItem[] = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    status: session.status,
    agentMode: session.activeAgentMode,
    isSelected: session.id === selectedSession.id,
    activeGoalTitle: session.id === selectedSession.id ? graphState?.activeGoal.title : undefined,
  }));

  const runsSorted = [...availableRuns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const selectedRunId =
    input.selectedRunId && runsSorted.some((run) => run.id === input.selectedRunId)
      ? input.selectedRunId
      : runsSorted[0]?.id;
  const replayPanel = selectedRunId
    ? await buildSubagentReplayPanelState(service, selectedRunId)
    : undefined;

  const parentTaskIdsWithDelegations = new Set(
    availableRuns.flatMap((run) => (run.parentTaskId ? [run.parentTaskId] : [])),
  );
  const delegatedParentTasks = findDelegatedParentTasks(graphState?.tasks ?? [], parentTaskIdsWithDelegations);
  const selectedParentTaskId =
    input.selectedParentTaskId && delegatedParentTasks.some((task) => task.id === input.selectedParentTaskId)
      ? input.selectedParentTaskId
      : delegatedParentTasks[0]?.id;
  const delegationPanel = selectedParentTaskId
    ? await buildParentTaskDelegationPanelState(service, selectedParentTaskId)
    : undefined;

  const inspector =
    replayPanel &&
    input.selectedTimelineIndex !== undefined &&
    replayPanel.timeline[input.selectedTimelineIndex]
      ? {
          title: describeTimelineItem(replayPanel.timeline[input.selectedTimelineIndex]),
          detail: replayPanel.timeline[input.selectedTimelineIndex]!.detail,
          source: "timeline" as const,
        }
      : undefined;

  return {
    workspacePath: input.workspacePath,
    focusedPanel: normalizeIdePanelId(input.focusedPanel) ?? "workbench",
    sessions: sessionsState,
    selectedSessionId: selectedSession.id,
    selectedSessionTitle: selectedSession.title,
    selectedSessionStatus: selectedSession.status,
    selectedSessionAgentMode: selectedSession.activeAgentMode,
    selectedGoalTitle: graphState?.activeGoal.title,
    selectedSessionTaskCount: graphState?.tasks.length ?? 0,
    selectedSessionSubagentRunCount: availableRuns.length,
    selectedFilePath: workspaceBrowser.selectedFilePath,
    selectedRunId,
    selectedParentTaskId,
    selectedTimelineIndex: inspector ? input.selectedTimelineIndex : undefined,
    availableRunIds: runsSorted.map((run) => run.id),
    availableParentTaskIds: delegatedParentTasks.map((task) => task.id),
    selectedSessionSummary: selectedSession.summary.shortSummary,
    selectedSessionOpenLoops: selectedSession.summary.openLoops,
    selectedSessionNextActions: selectedSession.summary.nextActions,
    selectedSessionImportantFacts: selectedSession.summary.importantFacts,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
    workspaceEntries: workspaceBrowser.entries,
    filePreview: workspaceBrowser.preview,
    goalPanel: graphState
      ? {
          id: graphState.activeGoal.id,
          title: graphState.activeGoal.title,
          description: graphState.activeGoal.description,
          status: graphState.activeGoal.status,
          successCriteria: graphState.activeGoal.successCriteria,
        }
      : undefined,
    planPanel: graphState?.currentPlan
      ? {
          id: graphState.currentPlan.id,
          summary: graphState.currentPlan.summary,
          status: graphState.currentPlan.status,
          steps: graphState.currentPlan.steps.map((step) => ({
            id: step.id,
            title: step.title,
            description: step.description,
            status: step.status,
            evidence: step.evidence,
          })),
        }
      : undefined,
    activityLog: buildActivityLog(messages, checkpoints, toolInvocations),
    replayPanel,
    delegationPanel,
    inspector,
    terminalEntries: terminalEntries.map((entry) => ({
      id: entry.id,
      command: entry.command,
      status: entry.status,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      exitCode: entry.exitCode,
      combinedOutput: entry.combinedOutput,
    })),
  };
}

// 这里把用户点击抽象成导航动作，再压回下一次 build 所需的输入。
// 后面无论接浏览器事件、React 状态还是桌面端事件，都应该复用这套导航协议。
export function reduceIdeShellNavigation(
  current: IdeShellState,
  action: IdeShellAction,
): IdeShellNavigationInput {
  switch (action.type) {
    case "focus-panel":
      return {
        workspacePath: current.workspacePath,
        selectedSessionId: current.selectedSessionId,
        selectedFilePath: current.selectedFilePath,
        selectedRunId: current.selectedRunId,
        selectedParentTaskId: current.selectedParentTaskId,
        selectedTimelineIndex: current.selectedTimelineIndex,
        focusedPanel: action.panel,
      };
    case "select-session":
      return {
        workspacePath: current.workspacePath,
        selectedSessionId: action.sessionId,
        selectedFilePath: current.selectedFilePath,
        focusedPanel: "workbench",
      };
    case "open-file":
      return {
        workspacePath: current.workspacePath,
        selectedSessionId: current.selectedSessionId,
        selectedFilePath: action.filePath,
        selectedRunId: current.selectedRunId,
        selectedParentTaskId: current.selectedParentTaskId,
        focusedPanel: "workbench",
      };
    case "open-replay":
      return {
        workspacePath: current.workspacePath,
        selectedSessionId: current.selectedSessionId,
        selectedFilePath: current.selectedFilePath,
        selectedRunId: action.runId,
        selectedParentTaskId: current.selectedParentTaskId,
        focusedPanel: "subagent-replay",
      };
    case "open-parent-task":
      return {
        workspacePath: current.workspacePath,
        selectedSessionId: current.selectedSessionId,
        selectedFilePath: current.selectedFilePath,
        selectedRunId: current.selectedRunId,
        selectedParentTaskId: action.parentTaskId,
        focusedPanel: "parent-task-delegation",
      };
    case "inspect-timeline":
      return {
        workspacePath: current.workspacePath,
        selectedSessionId: current.selectedSessionId,
        selectedFilePath: current.selectedFilePath,
        selectedRunId: current.selectedRunId,
        selectedParentTaskId: current.selectedParentTaskId,
        selectedTimelineIndex: action.index,
        focusedPanel: "inspector",
      };
  }
}

function renderNavigation(state: IdeShellState): string {
  return `
    <nav class="top-nav">
      ${[
        { id: "workbench", label: "Workbench" },
        { id: "goal", label: "Goal" },
        { id: "plan", label: "Plan" },
        { id: "activity-log", label: "Activity" },
        { id: "subagent-replay", label: "Replay" },
        { id: "parent-task-delegation", label: "Delegation" },
        { id: "inspector", label: "Inspector" },
      ]
        .map(
          (item) => `
            <button
              class="nav-button${state.focusedPanel === item.id ? " is-active" : ""}"
              data-action="focus-panel"
              data-panel="${item.id}"
            >
              ${item.label}
            </button>
          `,
        )
        .join("")}
    </nav>
  `;
}

function renderWorkbenchHeader(state: IdeShellState): string {
  return `
    <header class="workbench-header">
      <section class="hero-band panel">
        <div>
          <p class="eyebrow">Agent IDE</p>
          <h1>${escapeHtml(state.selectedSessionTitle ?? "Agent Workbench")}</h1>
          <p class="workspace-label">${escapeHtml(state.workspacePath)}</p>
        </div>
        <div class="status-pills hero-pills">
          <span class="pill">${escapeHtml(state.selectedSessionAgentMode ?? "build")}</span>
          <span class="pill">${escapeHtml(state.selectedSessionStatus ?? "idle")}</span>
          <span class="pill">${state.sessions.length} sessions</span>
          <span class="pill">${state.workspaceEntries.length} files</span>
        </div>
      </section>
      <section class="session-strip-card panel">
        <div class="section-heading">
          <h2>Sessions</h2>
          <span>${state.sessions.length}</span>
        </div>
        ${
          state.sessions.length > 0
            ? `
              <div class="session-strip">
                ${state.sessions
                  .map(
                    (session) => `
                      <button
                        class="session-chip${session.isSelected ? " is-selected" : ""}"
                        data-action="select-session"
                        data-session-id="${session.id}"
                      >
                        <strong>${escapeHtml(session.title)}</strong>
                        <span>${escapeHtml(session.agentMode)} · ${escapeHtml(session.status)}</span>
                        ${session.activeGoalTitle ? `<em>${escapeHtml(session.activeGoalTitle)}</em>` : ""}
                      </button>
                    `,
                  )
                  .join("")}
              </div>
            `
            : `<p class="muted">当前还没有 session。直接在 Messages 面板里提交 prompt，系统会自动创建新的 build session。</p>`
        }
      </section>
      <section class="meta-strip">
        <article class="meta-card">
          <span class="meta-label">Goal</span>
          <strong>${escapeHtml(state.selectedGoalTitle ?? "暂无 active goal")}</strong>
        </article>
        <article class="meta-card">
          <span class="meta-label">Tasks / Subagents</span>
          <strong>${state.selectedSessionTaskCount} / ${state.selectedSessionSubagentRunCount}</strong>
        </article>
        <article class="meta-card meta-card-wide">
          <span class="meta-label">Summary</span>
          <p>${escapeHtml(state.selectedSessionSummary ?? "当前 session 还没有 summary。")}</p>
        </article>
      </section>
    </header>
  `;
}

function renderMessagePanel(state: IdeShellState): string {
  return `
    <section class="panel message-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Conversation</p>
          <h2>${escapeHtml(state.selectedSessionTitle ?? "New Session")}</h2>
        </div>
        <div class="status-pills">
          <span class="pill">${escapeHtml(state.selectedSessionAgentMode ?? "build")}</span>
          <span class="pill">${escapeHtml(state.selectedSessionStatus ?? "draft")}</span>
        </div>
      </div>
      <div class="message-list">
        ${
          state.messages.length > 0
            ? state.messages
                .map(
                  (message) => `
                    <article class="message-card role-${message.role}">
                      <div class="message-meta">
                        <strong>${escapeHtml(formatRoleLabel(message.role))}</strong>
                        <span>${escapeHtml(message.createdAt)}</span>
                      </div>
                      <p>${escapeHtml(message.content)}</p>
                    </article>
                  `,
                )
                .join("")
            : `
              <div class="empty-state">
                <h3>还没有消息</h3>
                <p>在下面输入 prompt，就会在当前 workspace 里启动或继续一个 agent session。</p>
              </div>
            `
        }
      </div>
      <form class="composer" data-ide-submit="invoke">
        <input type="hidden" name="workspacePath" value="${escapeHtml(state.workspacePath)}" />
        ${
          state.selectedSessionId
            ? `<input type="hidden" name="sessionId" value="${escapeHtml(state.selectedSessionId)}" />`
            : ""
        }
        <label class="composer-label" for="ide-prompt">Prompt</label>
        <textarea
          id="ide-prompt"
          name="prompt"
          rows="4"
          placeholder="${escapeHtml(createComposerPlaceholder(state))}"
          required
        ></textarea>
        <div class="composer-footer">
          <p class="muted">
            ${escapeHtml(
              state.selectedSessionId
                ? `提交后会继续沿用当前 session：${state.selectedSessionTitle ?? state.selectedSessionId}`
                : "当前没有 session，提交后会自动创建一个新的 build session。",
            )}
          </p>
          <button type="submit" class="primary-button">Run Agent</button>
        </div>
      </form>
    </section>
  `;
}

function renderFilesPanel(state: IdeShellState): string {
  return `
    <section class="panel detail-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Workspace</p>
          <h2>Files</h2>
        </div>
        <span class="pill">${state.workspaceEntries.length} entries</span>
      </div>
      <div class="two-column-section files-grid">
        <div>
          <div class="section-heading">
            <h3>Explorer</h3>
            <span>${escapeHtml(state.workspacePath)}</span>
          </div>
          ${
            state.workspaceEntries.length > 0
              ? `
                <ul class="file-tree">
                  ${state.workspaceEntries
                    .map(
                      (entry) => `
                        <li class="file-tree-item depth-${entry.depth}">
                          ${
                            entry.kind === "file"
                              ? `
                                <button
                                  class="file-select${state.selectedFilePath === entry.path ? " is-selected" : ""}"
                                  data-action="open-file"
                                  data-file-path="${entry.path}"
                                >
                                  <span>${escapeHtml(entry.name)}</span>
                                  <small>${escapeHtml(entry.path)}</small>
                                </button>
                              `
                              : `
                                <div class="file-directory">
                                  <strong>${escapeHtml(entry.name)}</strong>
                                  <small>${escapeHtml(entry.path)}</small>
                                </div>
                              `
                          }
                        </li>
                      `,
                    )
                    .join("")}
                </ul>
              `
              : `<p class="muted">当前 workspace 还没有可展示的文件，或者文件树尚未加载成功。</p>`
          }
        </div>
        <div>
          <div class="section-heading">
            <h3>Editor</h3>
            <span>${escapeHtml(state.filePreview?.path ?? "未选择文件")}</span>
          </div>
          ${
            state.filePreview
              ? `
                <form class="file-editor-form" data-ide-submit="save-file">
                  <input type="hidden" name="workspacePath" value="${escapeHtml(state.workspacePath)}" />
                  <input type="hidden" name="filePath" value="${escapeHtml(state.filePreview.path)}" />
                  ${
                    state.selectedSessionId
                      ? `<input type="hidden" name="sessionId" value="${escapeHtml(state.selectedSessionId)}" />`
                      : ""
                  }
                  <label class="composer-label" for="ide-file-editor">File Content</label>
                  <textarea
                    id="ide-file-editor"
                    class="editor-textarea"
                    name="content"
                    rows="22"
                    spellcheck="false"
                  >${escapeHtml(state.filePreview.content)}</textarea>
                  <div class="composer-footer">
                    <p class="muted">
                      ${state.filePreview.totalLines} line(s)${state.filePreview.truncated ? "，当前文件较长，之前的预览会截断，但编辑区已加载完整内容" : ""}
                    </p>
                    <button type="submit" class="primary-button">Save File</button>
                  </div>
                </form>
              `
              : `<p class="muted">点左边的文件后，这里会显示可编辑文本区域，并把内容保存回当前 workspace。</p>`
          }
        </div>
      </div>
    </section>
  `;
}

function renderTerminalSection(state: IdeShellState): string {
  return `
    <section class="panel terminal-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Terminal</p>
          <h3>Workspace Command Runner</h3>
        </div>
        <span class="pill">${state.terminalEntries.length} entries</span>
      </div>
      <form class="terminal-form" data-ide-submit="terminal-run">
        <input type="hidden" name="workspacePath" value="${escapeHtml(state.workspacePath)}" />
        ${
          state.selectedSessionId
            ? `<input type="hidden" name="sessionId" value="${escapeHtml(state.selectedSessionId)}" />`
            : ""
        }
        ${
          state.selectedFilePath
            ? `<input type="hidden" name="selectedFilePath" value="${escapeHtml(state.selectedFilePath)}" />`
            : ""
        }
        <label class="composer-label" for="ide-terminal-command">Command</label>
        <div class="terminal-submit-row">
          <input
            id="ide-terminal-command"
            class="terminal-input"
            name="command"
            placeholder="例如：pnpm test -- --runInBand"
            autocomplete="off"
            required
          />
          <button type="submit" class="primary-button">Run Command</button>
        </div>
        <p class="muted">命令会在当前 workspace 内执行，并把最近的 stdout / stderr 历史保留在这个面板里。</p>
      </form>
      ${
        state.terminalEntries.length > 0
          ? `
            <div class="terminal-log workbench-scroll">
              ${state.terminalEntries
                .map(
                  (entry) => `
                    <article class="terminal-entry">
                      <div class="terminal-entry-meta">
                        <strong>${escapeHtml(entry.command)}</strong>
                        <span>${escapeHtml(entry.status)}</span>
                      </div>
                      <p class="muted">
                        ${escapeHtml(entry.startedAt)}
                        ${entry.exitCode !== undefined ? ` · exit ${entry.exitCode}` : ""}
                      </p>
                      <pre class="terminal-output">${escapeHtml(entry.combinedOutput || "[no output]")}</pre>
                    </article>
                  `,
                )
                .join("")}
            </div>
          `
          : `<div class="empty-state"><h3>终端历史为空</h3><p>先在上面执行一条命令，这里就会显示最近的输出结果。</p></div>`
      }
    </section>
  `;
}

function renderWorkbenchPanel(state: IdeShellState): string {
  return `
    <section class="panel workbench-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Workbench</p>
          <h2>${escapeHtml(state.selectedSessionTitle ?? "Agent Workbench")}</h2>
        </div>
        <div class="status-pills">
          <span class="pill">${escapeHtml(state.selectedSessionAgentMode ?? "build")}</span>
          <span class="pill">${escapeHtml(state.selectedSessionStatus ?? "draft")}</span>
          <span class="pill">${escapeHtml(state.selectedGoalTitle ?? "暂无 goal")}</span>
        </div>
      </div>
      <div class="workbench-grid">
        <section class="panel workbench-column conversation-shell">
          <div class="section-heading">
            <h3>Conversation</h3>
            <span>${state.messages.length} messages</span>
          </div>
          <div class="message-list workbench-scroll">
            ${
              state.messages.length > 0
                ? state.messages
                    .map(
                      (message) => `
                        <article class="message-card role-${message.role}">
                          <div class="message-meta">
                            <strong>${escapeHtml(formatRoleLabel(message.role))}</strong>
                            <span>${escapeHtml(message.createdAt)}</span>
                          </div>
                          <p>${escapeHtml(message.content)}</p>
                        </article>
                      `,
                    )
                    .join("")
                : `
                  <div class="empty-state">
                    <h3>还没有消息</h3>
                    <p>从这里启动 agent，或者继续当前 session。</p>
                  </div>
                `
            }
          </div>
          <form class="composer workbench-composer" data-ide-submit="invoke">
            <input type="hidden" name="workspacePath" value="${escapeHtml(state.workspacePath)}" />
            ${
              state.selectedSessionId
                ? `<input type="hidden" name="sessionId" value="${escapeHtml(state.selectedSessionId)}" />`
                : ""
            }
            ${
              state.selectedFilePath
                ? `<input type="hidden" name="selectedFilePath" value="${escapeHtml(state.selectedFilePath)}" />`
                : ""
            }
            <label class="composer-label" for="ide-prompt">Prompt</label>
            <textarea
              id="ide-prompt"
              name="prompt"
              rows="5"
              placeholder="${escapeHtml(createComposerPlaceholder(state))}"
              required
            ></textarea>
            <div class="composer-footer">
              <p class="muted">
                ${escapeHtml(
                  state.selectedSessionId
                    ? `提交后会继续沿用当前 session：${state.selectedSessionTitle ?? state.selectedSessionId}`
                    : "当前没有 session，提交后会自动创建一个新的 build session。",
                )}
              </p>
              <button type="submit" class="primary-button">Run Agent</button>
            </div>
          </form>
        </section>
        <section class="workspace-stack">
          <section class="panel workspace-top-shell">
            <div class="workspace-grid">
              <aside class="workspace-pane explorer-shell">
                <div class="section-heading">
                  <h3>Workspace Explorer</h3>
                  <span>${state.workspaceEntries.length} entries</span>
                </div>
                <div class="workbench-scroll">
                  ${
                    state.workspaceEntries.length > 0
                      ? `
                        <ul class="file-tree">
                          ${state.workspaceEntries
                            .map(
                              (entry) => `
                                <li class="file-tree-item depth-${entry.depth}">
                                  ${
                                    entry.kind === "file"
                                      ? `
                                        <button
                                          class="file-select${state.selectedFilePath === entry.path ? " is-selected" : ""}"
                                          data-action="open-file"
                                          data-file-path="${entry.path}"
                                        >
                                          <span>${escapeHtml(entry.name)}</span>
                                          <small>${escapeHtml(entry.path)}</small>
                                        </button>
                                      `
                                      : `
                                        <div class="file-directory">
                                          <strong>${escapeHtml(entry.name)}</strong>
                                          <small>${escapeHtml(entry.path)}</small>
                                        </div>
                                      `
                                  }
                                </li>
                              `,
                            )
                            .join("")}
                        </ul>
                      `
                      : `<p class="muted">当前 workspace 还没有可展示的文件，或者文件树尚未加载成功。</p>`
                  }
                </div>
              </aside>
              <section class="workspace-pane editor-shell">
                <div class="section-heading">
                  <h3>Editor</h3>
                  <span>${escapeHtml(state.filePreview?.path ?? "未选择文件")}</span>
                </div>
                ${
                  state.filePreview
                    ? `
                      <form class="file-editor-form" data-ide-submit="save-file">
                        <input type="hidden" name="workspacePath" value="${escapeHtml(state.workspacePath)}" />
                        <input type="hidden" name="filePath" value="${escapeHtml(state.filePreview.path)}" />
                        ${
                          state.selectedSessionId
                            ? `<input type="hidden" name="sessionId" value="${escapeHtml(state.selectedSessionId)}" />`
                            : ""
                        }
                        <label class="composer-label" for="ide-file-editor">File Content</label>
                        <textarea
                          id="ide-file-editor"
                          class="editor-textarea"
                          name="content"
                          rows="24"
                          spellcheck="false"
                        >${escapeHtml(state.filePreview.content)}</textarea>
                        <div class="composer-footer">
                          <p class="muted">
                            ${state.filePreview.totalLines} line(s)${state.filePreview.truncated ? "，这个文件在预览模式下曾被截断，但编辑区已经加载完整内容" : ""}
                          </p>
                          <button type="submit" class="primary-button">Save File</button>
                        </div>
                      </form>
                    `
                    : `<div class="empty-state"><h3>选择一个文件</h3><p>点左边的文件后，这里会切到可编辑状态。</p></div>`
                }
              </section>
            </div>
          </section>
          ${renderTerminalSection(state)}
        </section>
      </div>
    </section>
  `;
}

function renderGoalPanel(state: IdeShellState): string {
  if (!state.goalPanel) {
    return `
      <section class="panel detail-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Goal</p>
            <h2>当前还没有 active goal</h2>
          </div>
        </div>
        <p class="muted">先在 Messages 面板里提交 prompt，runtime 会尝试创建 goal 并生成 plan。</p>
      </section>
    `;
  }

  return `
    <section class="panel detail-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Goal</p>
          <h2>${escapeHtml(state.goalPanel.title)}</h2>
        </div>
        <span class="pill">${escapeHtml(state.goalPanel.status)}</span>
      </div>
      <p class="goal-description">${escapeHtml(state.goalPanel.description)}</p>
      <div class="section-heading">
        <h3>Success Criteria</h3>
        <span>${state.goalPanel.successCriteria.length}</span>
      </div>
      <ul class="bullet-list">
        ${state.goalPanel.successCriteria
          .map((criterion) => `<li>${escapeHtml(criterion)}</li>`)
          .join("")}
      </ul>
    </section>
  `;
}

function renderPlanPanel(state: IdeShellState): string {
  if (!state.planPanel) {
    return `
      <section class="panel detail-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Plan</p>
            <h2>当前还没有 current plan</h2>
          </div>
        </div>
        <p class="muted">当 planner hook 或 runtime service 保存 plan 之后，这里会展示步骤和状态。</p>
      </section>
    `;
  }

  return `
    <section class="panel detail-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Plan</p>
          <h2>${escapeHtml(state.planPanel.summary)}</h2>
        </div>
        <span class="pill">${escapeHtml(state.planPanel.status)}</span>
      </div>
      <ol class="step-list">
        ${state.planPanel.steps
          .map(
            (step) => `
              <li class="step-card">
                <div class="step-topline">
                  <strong>${escapeHtml(step.title)}</strong>
                  <span class="step-status">${escapeHtml(step.status)}</span>
                </div>
                <p>${escapeHtml(step.description)}</p>
                ${step.evidence ? `<small>${escapeHtml(step.evidence)}</small>` : ""}
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

function renderActivityLogPanel(state: IdeShellState): string {
  return `
    <section class="panel detail-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Activity</p>
          <h2>Runtime Activity Log</h2>
        </div>
        <span class="pill">${state.activityLog.length} items</span>
      </div>
      ${
        state.activityLog.length > 0
          ? `
            <ul class="activity-list">
              ${state.activityLog
                .map(
                  (item) => `
                    <li class="activity-item">
                      <div class="activity-meta">
                        <strong>${escapeHtml(item.title)}</strong>
                        <span>${escapeHtml(item.createdAt)}</span>
                      </div>
                      <p>${escapeHtml(item.detail)}</p>
                      <div class="activity-tags">
                        <span class="pill">${escapeHtml(item.kind)}</span>
                        ${item.status ? `<span class="pill">${escapeHtml(item.status)}</span>` : ""}
                      </div>
                    </li>
                  `,
                )
                .join("")}
            </ul>
          `
          : `<p class="muted">当前 session 还没有 activity log。</p>`
      }
    </section>
  `;
}

function renderReplayPanel(state: IdeShellState): string {
  if (!state.replayPanel) {
    return `
      <section class="panel detail-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Replay</p>
            <h2>当前没有可回放的 subagent run</h2>
          </div>
        </div>
        <p class="muted">当 delegation 发生之后，这里会展示 child session 的时间线和工具调用。</p>
      </section>
    `;
  }

  return `
    <section class="panel detail-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Replay</p>
          <h2>${escapeHtml(state.replayPanel.childSessionTitle)}</h2>
        </div>
        <div class="status-pills">
          <span class="pill">${escapeHtml(state.replayPanel.agentMode)}</span>
          <span class="pill">${escapeHtml(state.replayPanel.status)}</span>
        </div>
      </div>
      <p class="muted">${escapeHtml(state.replayPanel.resultSummary ?? "还没有结果摘要")}</p>
      <div class="two-column-section">
        <div>
          <div class="section-heading">
            <h3>Timeline</h3>
            <span>${state.replayPanel.timeline.length}</span>
          </div>
          <ul class="timeline-list">
            ${state.replayPanel.timeline
              .map(
                (item, index) => `
                  <li>
                    <button
                      class="timeline-item${state.selectedTimelineIndex === index ? " is-selected" : ""}"
                      data-action="inspect-timeline"
                      data-index="${index}"
                    >
                      <strong>${escapeHtml(item.title)}</strong>
                      <span>${escapeHtml(item.timestamp)}</span>
                    </button>
                  </li>
                `,
              )
              .join("")}
          </ul>
        </div>
        <div>
          <div class="section-heading">
            <h3>Task Tool Groups</h3>
            <span>${state.replayPanel.taskToolGroups.length}</span>
          </div>
          <ul class="tool-group-list">
            ${state.replayPanel.taskToolGroups
              .map(
                (group) => `
                  <li class="tool-group">
                    <strong>${escapeHtml(group.taskTitle)}</strong>
                    <span>${group.toolInvocations.length} tool call(s)</span>
                  </li>
                `,
              )
              .join("")}
          </ul>
        </div>
      </div>
    </section>
  `;
}

function renderDelegationPanel(state: IdeShellState): string {
  if (!state.delegationPanel) {
    return `
      <section class="panel detail-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Delegation</p>
            <h2>当前没有可展开的 delegated parent task</h2>
          </div>
        </div>
        <p class="muted">一旦 parent task 委托了 child session，这里会把直接工具调用和 delegated runs 串起来。</p>
      </section>
    `;
  }

  return `
    <section class="panel detail-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Delegation</p>
          <h2>${escapeHtml(state.delegationPanel.parentTaskTitle)}</h2>
        </div>
        <span class="pill">${escapeHtml(state.delegationPanel.parentSessionTitle)}</span>
      </div>
      <div class="two-column-section">
        <div>
          <div class="section-heading">
            <h3>Direct Tool Calls</h3>
            <span>${state.delegationPanel.directToolInvocations.length}</span>
          </div>
          <ul class="tool-group-list">
            ${state.delegationPanel.directToolInvocations
              .map(
                (log) => `
                  <li class="tool-group">
                    <strong>${escapeHtml(log.toolName)}</strong>
                    <span>${escapeHtml(log.status)}</span>
                  </li>
                `,
              )
              .join("")}
          </ul>
        </div>
        <div>
          <div class="section-heading">
            <h3>Delegated Runs</h3>
            <span>${state.delegationPanel.delegatedRuns.length}</span>
          </div>
          <ul class="delegated-run-list">
            ${state.delegationPanel.delegatedRuns
              .map(
                (run) => `
                  <li>
                    <button
                      class="delegated-run${state.selectedRunId === run.runId ? " is-selected" : ""}"
                      data-action="open-replay"
                      data-run-id="${run.runId}"
                    >
                      <strong>${escapeHtml(run.childSessionTitle)}</strong>
                      <span>${escapeHtml(run.agentMode)}</span>
                      <span>${escapeHtml(run.status)}</span>
                    </button>
                  </li>
                `,
              )
              .join("")}
          </ul>
        </div>
      </div>
    </section>
  `;
}

function renderInspector(state: IdeShellState): string {
  return `
    <section class="panel detail-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Inspector</p>
          <h2>Timeline Detail</h2>
        </div>
      </div>
      ${
        state.inspector
          ? `
            <h3>${escapeHtml(state.inspector.title)}</h3>
            <pre>${escapeHtml(state.inspector.detail)}</pre>
          `
          : "<p class=\"muted\">点开 replay timeline 里的任一项，这里会显示详细内容。</p>"
      }
    </section>
  `;
}

function renderMainPanel(panelId: IdePanelId, focusedPanel: IdePanelId, content: string): string {
  return `
    <div
      class="main-panel${focusedPanel === panelId ? " is-visible" : " is-hidden"}"
      data-panel="${panelId}"
    >
      ${content}
    </div>
  `;
}

// 这里输出的不是“好看一点的概览页”，而是一份真正能承担 agent IDE 主交互的 server-driven 文档。
export function renderIdeShellDocument(state: IdeShellState): string {
  return `
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent IDE Workbench</title>
    <style>
      :root {
        --bg: #efe7db;
        --panel: rgba(255, 251, 244, 0.9);
        --panel-strong: #fffaf2;
        --ink: #1f1a17;
        --muted: #756658;
        --line: #d7c6b2;
        --accent: #b4542d;
        --accent-soft: #f3d4c2;
        --accent-deep: #6b2c16;
        --shadow: 0 18px 48px rgba(81, 55, 34, 0.09);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(180, 84, 45, 0.08), transparent 24%),
          radial-gradient(circle at top right, rgba(107, 44, 22, 0.06), transparent 22%),
          linear-gradient(180deg, #f4ebdf 0%, var(--bg) 100%);
        font-family: Georgia, "Iowan Old Style", "Noto Serif SC", serif;
        overflow: auto;
      }
      button,
      textarea,
      input {
        font: inherit;
      }
      .shell {
        min-height: 100vh;
        height: auto;
        overflow: visible;
      }
      .content {
        width: min(1680px, 100%);
        margin: 0 auto;
        padding: 24px;
        display: grid;
        gap: 20px;
        align-content: start;
        min-height: 100vh;
        height: auto;
        grid-template-rows: auto auto auto;
        overflow: visible;
      }
      .workbench-header {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .panel,
      .sidebar-card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 20px;
        box-shadow: var(--shadow);
      }
      .hero-band {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        align-items: flex-start;
      }
      .hero-band h1 {
        margin: 0 0 10px;
        font-size: clamp(1.8rem, 3vw, 2.8rem);
        line-height: 1.02;
      }
      .eyebrow {
        margin: 0 0 10px;
        font-size: 0.78rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--accent);
      }
      .workspace-label,
      .muted {
        color: var(--muted);
      }
      .section-heading,
      .panel-header,
      .composer-footer,
      .message-meta,
      .activity-meta,
      .step-topline {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
      }
      .meta-strip {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .meta-card {
        background: rgba(255, 251, 244, 0.88);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 14px 16px;
        display: grid;
        gap: 8px;
        min-height: 96px;
      }
      .meta-card p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }
      .meta-label {
        font-size: 0.76rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
      }
      .section-heading h2,
      .section-heading h3,
      .panel-header h2,
      .panel-header h3 {
        margin: 0;
      }
      .top-nav {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .nav-button,
      .session-select,
      .timeline-item,
      .delegated-run,
      .ghost-button,
      .primary-button {
        border: 1px solid var(--line);
        background: var(--panel-strong);
        color: var(--ink);
        border-radius: 14px;
        padding: 12px 14px;
        cursor: pointer;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }
      .ghost-button {
        padding: 8px 12px;
        font-size: 0.92rem;
      }
      .primary-button {
        background: linear-gradient(180deg, #d8794f 0%, var(--accent) 100%);
        color: #fff7f1;
        border-color: var(--accent-deep);
      }
      .nav-button:hover,
      .session-select:hover,
      .timeline-item:hover,
      .delegated-run:hover,
      .ghost-button:hover,
      .primary-button:hover {
        transform: translateY(-1px);
      }
      .nav-button.is-active,
      .session-card.is-selected .session-select,
      .timeline-item.is-selected,
      .delegated-run.is-selected,
      .session-chip.is-selected {
        background: var(--accent-soft);
        border-color: var(--accent);
      }
      .status-pills,
      .activity-tags {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #fff4ea;
        color: var(--accent-deep);
        font-size: 0.85rem;
      }
      .session-list,
      .bullet-list,
      .context-list,
      .file-tree,
      .step-list,
      .timeline-list,
      .tool-group-list,
      .delegated-run-list,
      .activity-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 12px;
      }
      .context-list li,
      .step-card,
      .tool-group,
      .activity-item,
      .message-card,
      .empty-state {
        background: #fff8ef;
        border: 1px solid #ead8c5;
        border-radius: 16px;
        padding: 14px;
      }
      .context-list li {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      .session-select,
      .session-chip,
      .file-select,
      .timeline-item,
      .delegated-run {
        width: 100%;
        text-align: left;
        display: grid;
        gap: 6px;
      }
      .session-strip {
        display: flex;
        gap: 12px;
        overflow-x: auto;
        padding-bottom: 4px;
      }
      .session-chip {
        min-width: 240px;
        border: 1px solid #e4d3c0;
        background: #fffaf3;
        border-radius: 16px;
        padding: 14px;
        cursor: pointer;
      }
      .session-chip em {
        font-style: normal;
        color: var(--muted);
      }
      .file-directory {
        display: grid;
        gap: 4px;
        padding: 10px 12px;
        border-radius: 14px;
        background: #f7efe4;
        border: 1px solid #e7d8c8;
      }
      .file-tree-item.depth-1 { margin-left: 12px; }
      .file-tree-item.depth-2 { margin-left: 24px; }
      .file-tree-item.depth-3 { margin-left: 36px; }
      .file-select {
        border: 1px solid #e4d3c0;
        background: #fffaf3;
        border-radius: 14px;
        padding: 10px 12px;
        cursor: pointer;
      }
      .file-select.is-selected {
        border-color: var(--accent);
        background: var(--accent-soft);
      }
      .message-panel,
      .workbench-panel,
      .detail-panel {
        display: grid;
        gap: 18px;
        align-content: start;
        min-height: 0;
        height: 100%;
      }
      .workbench-panel {
        grid-template-rows: auto auto;
        overflow: visible;
      }
      .detail-panel {
        overflow: auto;
      }
      .workbench-grid {
        display: grid;
        grid-template-columns: minmax(360px, 0.92fr) minmax(520px, 1.28fr);
        gap: 18px;
        align-items: stretch;
        min-height: 0;
        height: clamp(720px, 72vh, 920px);
      }
      .workbench-column {
        display: grid;
        gap: 16px;
        align-content: start;
        min-height: 0;
      }
      .conversation-shell {
        grid-template-rows: auto minmax(0, 1fr) auto;
        overflow: hidden;
        height: 100%;
      }
      .workspace-stack {
        display: grid;
        grid-template-rows: minmax(0, 1fr) clamp(220px, 30vh, 320px);
        gap: 18px;
        min-height: 0;
        height: 100%;
        overflow: hidden;
      }
      .workspace-top-shell {
        padding: 18px;
        min-height: 0;
        overflow: hidden;
        height: 100%;
      }
      .workspace-grid {
        display: grid;
        grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
        gap: 16px;
        min-height: 0;
        height: 100%;
      }
      .workspace-pane {
        min-height: 0;
        display: grid;
        overflow: hidden;
        height: 100%;
      }
      .explorer-shell {
        grid-template-rows: auto minmax(0, 1fr);
      }
      .editor-shell {
        grid-template-rows: auto minmax(0, 1fr);
      }
      .workbench-scroll {
        min-height: 0;
        height: 100%;
        overflow: auto;
        padding-right: 6px;
      }
      .message-list {
        display: grid;
        gap: 12px;
        height: 100%;
      }
      .message-card.role-user {
        border-color: #e9cdbf;
      }
      .message-card.role-assistant {
        border-color: #d7d2bc;
      }
      .message-card.role-tool,
      .message-card.role-system {
        border-color: #ddd3c7;
        background: #fcf6ee;
      }
      .message-card p,
      .activity-item p,
      .step-card p,
      .goal-description {
        margin: 8px 0 0;
        line-height: 1.55;
      }
      .composer {
        display: grid;
        gap: 12px;
        padding-top: 8px;
        border-top: 1px solid var(--line);
      }
      .workbench-composer {
        align-self: end;
      }
      .file-editor-form {
        display: grid;
        gap: 12px;
        grid-template-rows: auto minmax(0, 1fr) auto;
        min-height: 0;
        height: 100%;
      }
      .composer-label {
        font-weight: 700;
      }
      textarea {
        width: 100%;
        min-height: 128px;
        resize: vertical;
        border-radius: 18px;
        border: 1px solid var(--line);
        padding: 16px;
        background: #fffdf8;
        color: var(--ink);
      }
      .editor-textarea {
        min-height: 0;
        height: 100%;
        resize: none;
        overflow: auto;
        font-family: "SFMono-Regular", "JetBrains Mono", "Menlo", monospace;
        line-height: 1.55;
      }
      .two-column-section {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 18px;
      }
      .files-grid {
        grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
        align-items: start;
      }
      .workbench-files-grid {
        align-items: stretch;
      }
      .explorer-pane,
      .editor-pane {
        min-height: 100%;
      }
      .terminal-panel {
        display: grid;
        gap: 16px;
        padding: 18px;
        min-height: 0;
        overflow: hidden;
        grid-template-rows: auto auto minmax(0, 1fr);
      }
      .terminal-form {
        display: grid;
        gap: 12px;
      }
      .terminal-submit-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
      }
      .terminal-input {
        width: 100%;
        border-radius: 16px;
        border: 1px solid var(--line);
        padding: 14px 16px;
        background: #fffdf8;
        color: var(--ink);
      }
      .terminal-log {
        display: grid;
        gap: 12px;
        min-height: 0;
      }
      .terminal-entry {
        background: #fff8ef;
        border: 1px solid #ead8c5;
        border-radius: 16px;
        padding: 14px;
        display: grid;
        gap: 10px;
      }
      .terminal-entry-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
      }
      .terminal-output {
        margin: 0;
        max-height: 220px;
        overflow: auto;
      }
      .main-panel.is-hidden {
        display: none;
      }
      .main-panel {
        min-height: 0;
        overflow: visible;
      }
      pre {
        white-space: pre-wrap;
        background: #fff4e8;
        border-radius: 16px;
        padding: 16px;
        border: 1px solid var(--line);
      }
      @media (max-width: 1280px) {
        .meta-strip {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 1180px) {
        body {
          overflow: auto;
        }
        .shell,
        .content {
          height: auto;
          overflow: visible;
        }
        .content {
          grid-template-rows: auto auto auto;
        }
        .workbench-grid {
          grid-template-columns: 1fr;
          height: auto;
        }
        .workspace-stack {
          grid-template-rows: auto auto;
          height: auto;
          overflow: visible;
        }
        .workspace-grid {
          grid-template-columns: 1fr;
          height: auto;
        }
        .conversation-shell,
        .workspace-top-shell,
        .workspace-pane,
        .terminal-panel,
        .workbench-panel,
        .detail-panel {
          height: auto;
          overflow: visible;
        }
        .workbench-scroll {
          height: auto;
          max-height: none;
        }
      }
      @media (max-width: 900px) {
        .hero-band {
          flex-direction: column;
        }
        .meta-strip {
          grid-template-columns: 1fr;
        }
        .files-grid {
          grid-template-columns: 1fr;
        }
        .terminal-submit-row {
          grid-template-columns: 1fr;
        }
        .content {
          padding: 16px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <main class="content">
        ${renderWorkbenchHeader(state)}
        ${renderNavigation(state)}
        ${renderMainPanel("workbench", state.focusedPanel, renderWorkbenchPanel(state))}
        ${renderMainPanel("goal", state.focusedPanel, renderGoalPanel(state))}
        ${renderMainPanel("plan", state.focusedPanel, renderPlanPanel(state))}
        ${renderMainPanel("activity-log", state.focusedPanel, renderActivityLogPanel(state))}
        ${renderMainPanel("subagent-replay", state.focusedPanel, renderReplayPanel(state))}
        ${renderMainPanel("parent-task-delegation", state.focusedPanel, renderDelegationPanel(state))}
        ${renderMainPanel("inspector", state.focusedPanel, renderInspector(state))}
      </main>
    </div>
  </body>
</html>
  `.trim();
}
