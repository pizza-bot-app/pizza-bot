import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, type SearchHit, type ThreadInfo } from "@/api-client";
import {
  Activity,
  Inbox,
  MessageCircle,
} from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatPane } from "./components/ChatPane.js";
import { Sidebar } from "./components/Sidebar.js";
import { ActivityRail } from "./components/ActivityRail.js";
import { StatusBar } from "./components/StatusBar.js";
import {
  useRunningThreadIds,
  useThreadSliceReadOnly,
} from "./use-thread-slice.js";
import { protocolStreamStore } from "./protocol-stream-store.js";
import { resolveApiBase, resolveApiHeaders } from "./api-config.js";
import { useAgentsAdmin, useGraphs, useSkillsAdmin, useMcpServersAdmin, useMemoriesAdmin, useModels, usePluginsAdmin, useProvidersAdmin, useStatus, useTodos, useTriggers } from "./use-app-data.js";
import { PIZZA_BOT_AGENT } from "@pizza-bot/core";
import { SkillsModule } from "./components/skills/SkillsModule.js";
import { AgentsModule } from "./components/agents/AgentsModule.js";
import { AgentNamesContext } from "./components/agent-names.js";
import { McpServersModule } from "./components/mcp/McpServersModule.js";
import { MemoriesModule } from "./components/memories/MemoriesModule.js";
import { TriggerModule } from "./components/schedules/TriggerModule.js";
import { GraphsModule } from "./components/graphs/GraphsModule.js";
import { GraphRunPane } from "./components/graphs/GraphRunPane.js";
import { TodosModule } from "./components/todos/TodosModule.js";
import type { WorkThreadHint } from "./components/todos/TodoDetail.js";
import { FlagThreadButton } from "./components/todos/FlagThreadButton.js";
import { flaggedThreadIds, openTodoForThread } from "./lib/todo-views.js";
import { recipientOptions, threadAgent } from "./lib/thread-agent.js";
import { subscribeSidebarRefresh } from "./sidebar-refresh.js";
import {
  SettingsModule,
  type SettingsCategory,
} from "./components/settings/SettingsModule.js";
import { PluginsModule } from "./components/plugins/PluginsModule.js";
import { ModuleHeader } from "./components/ModuleHeader.js";
import { ModuleTabs } from "./components/ModuleTabs.js";
import { useSettings } from "./use-settings.js";
import { L } from "./lexicon.js";
import { useChatFocus } from "./use-chat-focus.js";
import { usePromptHistory } from "./use-prompt-history.js";
import { useHotkey, HotkeyHelp } from "./hotkeys/index.js";
import { useIsMobile } from "./use-is-mobile.js";
import { availableModels, configuredModels } from "./model-options.js";
import { composerDraftStore } from "./composer-draft-store.js";
import { adminVisibility, type AppView } from "./admin-visibility.js";
import { AppNavigation } from "./components/AppNavigation.js";
import { LogsModule } from "./components/logs/LogsModule.js";
import { useDesktopConnection } from "./use-desktop-connection.js";
import { useDesktopNotifications } from "./desktop-notifications.js";
import { initialThreadId } from "./initial-thread-selection.js";
import { activeSelectionAfterDelete } from "./lib/list-nav.js";

function panesClass(showRail: boolean): string {
  return showRail ? "panes no-inspector" : "panes solo";
}

let paneCounter = 0;
const freshThreadId = () => `web-${Date.now().toString(36)}-${paneCounter++}`;

function NoConversation() {
  return (
    <div className="no-conversation">
      <MessageCircle size={48} strokeWidth={1} className="no-conversation-icon" />
      <h3 className="no-conversation-title">No conversation selected</h3>
      <p className="no-conversation-desc">
        Choose one from the sidebar, or use New to start a conversation.
      </p>
    </div>
  );
}

export function App() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const apiHeaders = useMemo(() => resolveApiHeaders(), []);
  const client = useMemo(
    () => new ApiClient({ baseUrl: apiBase, headers: apiHeaders }),
    [apiBase, apiHeaders],
  );

  const [view, setView] = useState<AppView>("inbox");
  const [pluginFocus, setPluginFocus] = useState<string | undefined>(undefined);
  const openPlugin = (pluginName: string) => {
    setPluginFocus(pluginName);
    setView("plugins");
  };
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategory>("general");
  const [automationsTab, setAutomationsTab] = useState<"cron" | "webhook">("cron");
  const visibleAdmin = adminVisibility(view);
  const desktopConnection = useDesktopConnection();
  const runningThreadIds = useRunningThreadIds();

  const agent = useMemo(
    () => ({
      id: PIZZA_BOT_AGENT.id,
      name: PIZZA_BOT_AGENT.name,
      avatar: PIZZA_BOT_AGENT.avatar,
      description: PIZZA_BOT_AGENT.description,
      suggestedPrompts: PIZZA_BOT_AGENT.suggestedPrompts.map((p) => ({ ...p })),
    }),
    [],
  );
  const skillsAdmin = useSkillsAdmin(client, visibleAdmin.skills || visibleAdmin.agents);
  // Names are needed wherever delegations or "Used by" lists render.
  const agentsAdmin = useAgentsAdmin(
    client,
    visibleAdmin.agents || visibleAdmin.skills || view === "inbox",
    visibleAdmin.agents,
  );
  const agentNames = useMemo(
    () => new Map(agentsAdmin.agents.agents.map((entry) => [entry.id, entry.name])),
    [agentsAdmin.agents],
  );
  const mcpAdmin = useMcpServersAdmin(client, 5_000, visibleAdmin.mcp);
  const memoriesAdmin = useMemoriesAdmin(client, 5_000, visibleAdmin.memories);
  const pluginsAdmin = usePluginsAdmin(client, visibleAdmin.plugins);
  const {
    models,
    refresh: refreshModels,
    retry: retryModels,
  } = useModels(client);
  const {
    models: allModels,
    refresh: refreshAllModels,
    retry: retryAllModels,
  } = useModels(client, true);
  const refreshModelCatalogs = useCallback(
    () => Promise.all([refreshModels(), refreshAllModels()]),
    [refreshAllModels, refreshModels],
  );
  const {
    status: serverStatus,
    reachable: serverReachable,
    refresh: refreshStatus,
  } = useStatus(client);
  const providersAdmin = useProvidersAdmin(
    client,
    refreshModelCatalogs,
    refreshStatus,
  );
  const retryModelCatalogs = useCallback(
    () => Promise.all([retryModels(), retryAllModels()]),
    [retryAllModels, retryModels],
  );
  const selectableModels = useMemo(
    () =>
      availableModels(
        configuredModels(models, providersAdmin.providers),
        serverStatus?.inference.providers,
      ),
    [models, providersAdmin.providers, serverStatus?.inference.providers],
  );

  const triggers = useTriggers(client, 5_000, visibleAdmin.triggers);
  const graphs = useGraphs(client, 5_000, visibleAdmin.graphs);
  const todos = useTodos(client);
  const refreshTodos = todos.refresh;
  const flaggedThreads = useMemo(() => flaggedThreadIds(todos.todos), [todos.todos]);
  const [todoFocus, setTodoFocus] = useState<{ id: string; token: number } | null>(null);
  const openTodo = useCallback((todoId: string) => {
    setTodoFocus((prev) => ({ id: todoId, token: (prev?.token ?? 0) + 1 }));
    setView("todos");
  }, []);

  const { theme, persona, features, agent: agentSettings } = useSettings(client);

  const [threadTitles, setThreadTitles] = useState<Map<string, string>>(() => new Map());
  const [threadModels, setThreadModels] = useState<Map<string, string>>(() => new Map());
  // A thread's graph is fixed at creation, so entries are only ever added.
  const [threadGraphIds, setThreadGraphIds] = useState<Map<string, string>>(() => new Map());
  const noteGraphThreads = useCallback((rows: ThreadInfo[]) => {
    setThreadGraphIds((prev) => {
      const added = rows.filter((row) => row.graphId && !prev.has(row.threadId));
      if (added.length === 0) return prev;
      const next = new Map(prev);
      for (const row of added) next.set(row.threadId, row.graphId!);
      return next;
    });
  }, []);
  const [selectedThreadModels, setSelectedThreadModels] = useState<Map<string, string>>(
    () => new Map(),
  );
  // A thread's agent is fixed at creation, so entries are only ever added.
  const [threadAgentIds, setThreadAgentIds] = useState<Map<string, string>>(() => new Map());
  const noteAgentThreads = useCallback((rows: Array<Pick<ThreadInfo, "threadId" | "agentId">>) => {
    setThreadAgentIds((prev) => {
      const added = rows.filter((row) => row.agentId && !prev.has(row.threadId));
      if (added.length === 0) return prev;
      const next = new Map(prev);
      for (const row of added) next.set(row.threadId, row.agentId!);
      return next;
    });
  }, []);
  // A new conversation's folder and recipient wait here until its first message creates it.
  const [threadDrafts, setThreadDrafts] = useState<Map<string, { folderId?: string; agentId?: string }>>(
    () => new Map(),
  );
  const threadDraftsRef = useRef(threadDrafts);
  threadDraftsRef.current = threadDrafts;

  // A Todo's work thread is listed only while it awaits the user, so both sets track each listing.
  const [backgroundThreadIds, setBackgroundThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [awaitingThreadIds, setAwaitingThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const noteBackgroundThreads = useCallback((threadIds: readonly string[]) => {
    setBackgroundThreadIds((prev) => {
      const added = threadIds.filter((threadId) => !prev.has(threadId));
      return added.length === 0 ? prev : new Set([...prev, ...added]);
    });
  }, []);

  const seedThreadMetadata = useCallback((rows: ThreadInfo[]) => {
    setThreadCount(rows.filter((row) => !row.background).length);
    noteGraphThreads(rows);
    noteAgentThreads(rows);
    noteBackgroundThreads(rows.filter((row) => row.background).map((row) => row.threadId));
    setAwaitingThreadIds((prev) => {
      const next = new Set(rows.filter((row) => row.awaitingAction).map((row) => row.threadId));
      return next.size === prev.size && [...next].every((threadId) => prev.has(threadId)) ? prev : next;
    });
    setThreadTitles((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const row of rows) {
        if (next.get(row.threadId) !== row.title) {
          next.set(row.threadId, row.title);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setThreadModels((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const row of rows) {
        if (row.modelId && next.get(row.threadId) !== row.modelId) {
          next.set(row.threadId, row.modelId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // On the first load, land on the most recent persisted conversation without
    // overriding a thread the user already opened.
    if (!didAutoOpenRef.current && activeThreadIdRef.current === null) {
      didAutoOpenRef.current = true;
      const threadId = initialThreadId(rows.filter((row) => !row.background));
      if (threadId) {
        setOpenedThreads((prev) =>
          prev.has(threadId) ? prev : new Set(prev).add(threadId),
        );
        setActiveThreadId(threadId);
      }
    }
  }, [noteAgentThreads, noteBackgroundThreads, noteGraphThreads]);

  // The thread-change stream also reports Todo edits, including the orchestrator's.
  const onThreadsLoaded = useCallback(
    (rows: ThreadInfo[]) => {
      seedThreadMetadata(rows);
      refreshTodos().catch((error: unknown) => console.error("todo refresh failed", error));
    },
    [refreshTodos, seedThreadMetadata],
  );
  // Outside the Inbox no Sidebar follows the stream, so the Todos view follows it itself.
  const viewingTodos = view === "todos";
  useEffect(() => {
    if (!viewingTodos) return;
    return subscribeSidebarRefresh(
      client,
      () => Promise.all([refreshTodos(), client.listThreads().then(seedThreadMetadata)]),
      (message, error) => console.error(message, error),
    );
  }, [client, refreshTodos, seedThreadMetadata, viewingTodos]);

  // Only the active pane renders; every thread's run remains owned by the store.
  // A thread is in this set once opened from a persisted source, meaning it should
  // hydrate on mount; a brand-new chat is the active thread but stays out until it persists.
  const [openedThreads, setOpenedThreads] = useState<Set<string>>(() => new Set());
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const didAutoOpenRef = useRef(false);
  const [searchTarget, setSearchTarget] = useState<{
    threadId: string;
    messageId: string;
    token: number;
  } | null>(null);
  const searchTargetToken = useRef(0);
  const [threadCount, setThreadCount] = useState(0);
  const [showRail, setShowRail] = useState(false);

  const isMobile = useIsMobile();
  const [mobileListVisible, setMobileListVisible] = useState(true);

  const focus = useChatFocus();
  const { composerRef, listRef, focusComposer, focusList } = focus;
  const shouldFocusComposerRef = useRef(false);
  const { cycler: history } = usePromptHistory();

  const openThread = useCallback((threadId: string, hydrate: boolean) => {
    if (hydrate) setOpenedThreads((prev) => (prev.has(threadId) ? prev : new Set(prev).add(threadId)));
    setActiveThreadId(threadId);
    setMobileListVisible(false);
  }, []);

  const openNotifiedThread = useCallback(
    (threadId: string) => {
      setView("inbox");
      setSearchTarget(null);
      openThread(threadId, true);
    },
    [openThread],
  );
  const openTodoThread = useCallback(
    (threadId: string, workThread?: WorkThreadHint) => {
      if (workThread) {
        noteAgentThreads([{ threadId, agentId: workThread.agentId }]);
        noteBackgroundThreads([threadId]);
        setThreadTitles((prev) =>
          prev.has(threadId) ? prev : new Map(prev).set(threadId, workThread.title),
        );
      }
      openNotifiedThread(threadId);
    },
    [noteAgentThreads, noteBackgroundThreads, openNotifiedThread],
  );
  const desktopNotifications = useDesktopNotifications(
    openNotifiedThread,
    activeThreadId,
  );

  const onSelectThread = useCallback((threadId: string) => {
    setSearchTarget(null);
    setActiveThreadId(threadId);
    setMobileListVisible(false);
  }, []);

  const onBackToList = useCallback(() => setMobileListVisible(true), []);

  const showMobileList = mobileListVisible || activeThreadId === null;

  // Entering mobile closes the desktop rail so resize cannot leave a blocking drawer.
  useEffect(() => {
    if (isMobile) {
      setShowRail(false);
    }
  }, [isMobile]);

  useEffect(() => {
    const narrowLayout = window.matchMedia("(max-width: 1180px)");
    const collapseRail = () => {
      if (narrowLayout.matches) setShowRail(false);
    };
    collapseRail();
    narrowLayout.addEventListener("change", collapseRail);
    return () => narrowLayout.removeEventListener("change", collapseRail);
  }, []);

  // A feature disabled while its view is open must not strand the user there.
  useEffect(() => {
    if (
      ((view === "automations" || view === "graphs") && !features.enableAutomations) ||
      (view === "memories" && !features.enableMemories)
    ) {
      setView("inbox");
    }
  }, [view, features.enableAutomations, features.enableMemories]);

  const onNewChat = useCallback((folderId?: string) => {
    shouldFocusComposerRef.current = true;
    setSearchTarget(null);
    setView("inbox");
    const threadId = freshThreadId();
    if (folderId) setThreadDrafts((prev) => new Map(prev).set(threadId, { folderId }));
    openThread(threadId, false);
  }, [openThread]);

  const setDraftRecipient = useCallback((threadId: string, agentId: string | undefined) => {
    setThreadDrafts((prev) => {
      const { agentId: _previous, ...rest } = prev.get(threadId) ?? {};
      return new Map(prev).set(threadId, agentId ? { ...rest, agentId } : rest);
    });
  }, []);

  /** Creates a drafted thread with its folder and recipient; only a recipient failure blocks the send. */
  const createDraftedThread = useCallback(
    async (threadId: string) => {
      const draft = threadDraftsRef.current.get(threadId);
      if (!draft?.folderId && !draft?.agentId) return;
      try {
        await client.createThread(threadId, draft.folderId, draft.agentId);
      } catch (error) {
        if (draft.agentId) throw error;
        console.error("create thread in folder failed", error);
      }
      if (draft.agentId) noteAgentThreads([{ threadId, agentId: draft.agentId }]);
      setThreadDrafts((prev) => {
        if (!prev.has(threadId)) return prev;
        const next = new Map(prev);
        next.delete(threadId);
        return next;
      });
    },
    [client, noteAgentThreads],
  );

  const onMessageAgent = useCallback(
    async (agentId: string) => {
      const home = await client.openAgentHome(agentId);
      noteAgentThreads([home]);
      setThreadTitles((prev) =>
        prev.get(home.threadId) === home.title ? prev : new Map(prev).set(home.threadId, home.title),
      );
      openNotifiedThread(home.threadId);
    },
    [client, noteAgentThreads, openNotifiedThread],
  );

  const onOpenSearchHit = useCallback(
    (hit: SearchHit) => {
      searchTargetToken.current += 1;
      setSearchTarget({
        threadId: hit.threadId,
        messageId: hit.messageId,
        token: searchTargetToken.current,
      });
      openThread(hit.threadId, true);
    },
    [openThread],
  );
  const onOpenGraphRun = useCallback(
    (run: ThreadInfo) => {
      noteGraphThreads([run]);
      setThreadTitles((prev) =>
        prev.get(run.threadId) === run.title ? prev : new Map(prev).set(run.threadId, run.title),
      );
      setSearchTarget(null);
      setView("inbox");
      openThread(run.threadId, true);
    },
    [noteGraphThreads, openThread],
  );

  const onSearchTargetHandled = useCallback((token: number) => {
    setSearchTarget((current) => (current?.token === token ? null : current));
  }, []);

  useEffect(() => {
    if (!shouldFocusComposerRef.current || view !== "inbox" || activeThreadId === null) return;
    shouldFocusComposerRef.current = false;
    focusComposer();
  }, [activeThreadId, focusComposer, view]);

  const onThreadDeleted = useCallback((threadId: string) => {
    protocolStreamStore.disposeThread(threadId);
    composerDraftStore.discard(threadId);
    setOpenedThreads((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
    setActiveThreadId((active) => activeSelectionAfterDelete(active, threadId));
    setThreadTitles((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Map(prev);
      next.delete(threadId);
      return next;
    });
    setThreadModels((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Map(prev);
      next.delete(threadId);
      return next;
    });
    setSelectedThreadModels((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Map(prev);
      next.delete(threadId);
      return next;
    });
  }, []);

  const [helpOpen, setHelpOpen] = useState(false);
  const openSettings = useCallback(() => setView("settings"), []);
  const openConnectionSettings = useCallback(() => {
    setSettingsCategory("connection");
    setView("settings");
  }, []);
  useHotkey("app.toggleRail", useCallback(() => setShowRail((v) => !v), []));
  useHotkey("app.newChat", useCallback(() => void onNewChat(), [onNewChat]));
  useHotkey("app.toggleHelp", useCallback(() => setHelpOpen((v) => !v), []));
  useHotkey("app.openSettings", openSettings);
  const onRename = useCallback(
    async (threadId: string, title: string) => {
      const updated = await client.setThreadTitle(threadId, title);
      setThreadTitles((prev) => new Map(prev).set(threadId, updated.title));
    },
    [client],
  );
  const onFork = useCallback(
    async (threadId: string, messageIndex: number) => {
      try {
        const fork = await client.forkThread(threadId, { messageIndex });
        setThreadTitles((prev) => new Map(prev).set(fork.threadId, fork.title));
        const modelId = fork.modelId;
        if (modelId) {
          setThreadModels((prev) => new Map(prev).set(fork.threadId, modelId));
        }
        openThread(fork.threadId, true);
      } catch (error) {
        console.error("branch failed", error);
      }
    },
    [client, openThread],
  );

  const activeThreadTitle = activeThreadId
    ? (threadTitles.get(activeThreadId) ?? "New conversation")
    : undefined;
  const activeModelId = activeThreadId
    ? selectedThreadModels.get(activeThreadId) ??
      threadModels.get(activeThreadId) ??
      selectableModels.default
    : undefined;
  const activeModel = selectableModels.models.find((model) => model.id === activeModelId);

  const activeGraphId = activeThreadId ? threadGraphIds.get(activeThreadId) : undefined;
  const activeDraft = activeThreadId ? threadDrafts.get(activeThreadId) : undefined;
  const activeAgentId = activeThreadId
    ? (threadAgentIds.get(activeThreadId) ?? activeDraft?.agentId)
    : undefined;
  const catalogAgents = agentsAdmin.agents.agents;
  const activeAgent = useMemo(
    () => threadAgent(activeAgentId, catalogAgents, agent),
    [activeAgentId, agent, catalogAgents],
  );
  const recipients = useMemo(
    () => recipientOptions(catalogAgents, agent.name),
    [agent.name, catalogAgents],
  );
  const activePersisted =
    activeThreadId !== null &&
    (threadTitles.has(activeThreadId) || threadAgentIds.has(activeThreadId));
  const active = useThreadSliceReadOnly(activeGraphId ? null : activeThreadId);
  const railVisible = showRail && !activeGraphId;
  const delegations = active.delegations;
  const status = active.status;
  const isRunning = status === "streaming";

  return (
    <TooltipProvider>
      <AgentNamesContext.Provider value={agentNames}>
      <div className="app has-sidebar">
        <div className="body">
          <AppNavigation
            view={view}
            enableAutomations={features.enableAutomations}
            enableMemories={features.enableMemories}
            onViewChange={setView}
          />

          {view === "todos" ? (
            <div className="module-hub">
              <TodosModule
                key={todoFocus?.token ?? 0}
                {...(todoFocus ? { focusId: todoFocus.id } : {})}
                todos={todos.todos}
                threadTitles={threadTitles}
                agents={catalogAgents}
                automationsEnabled={features.enableAutomations}
                awaitingThreadIds={awaitingThreadIds}
                onCreate={todos.create}
                onUpdate={todos.update}
                onDelete={todos.remove}
                onUnlinkThread={todos.unlinkThread}
                onCheckIn={todos.checkIn}
                onOpenThread={openTodoThread}
              />
            </div>
          ) : view === "automations" ? (
            <div className="module-hub">
              <ModuleTabs
                ariaLabel={L.automationsSection}
                active={automationsTab}
                onSelect={setAutomationsTab}
                tabs={[
                  { key: "cron", label: L.schedulesSection },
                  { key: "webhook", label: L.webhooksSection },
                ]}
              />
              <TriggerModule
                key={automationsTab}
                kind={automationsTab}
                apiBase={apiBase}
                defaultTimezone={serverStatus?.timezone}
                triggers={triggers.triggers}
                loading={triggers.loading}
                onCreate={triggers.create}
                onUpdate={triggers.update}
                onDelete={triggers.remove}
                onRun={triggers.run}
              />
            </div>
          ) : view === "graphs" ? (
            <div className="module-hub">
              <GraphsModule client={client} listing={graphs.listing} onOpenRun={onOpenGraphRun} />
            </div>
          ) : view === "memories" ? (
            <div className="module-hub">
              <MemoriesModule
                memories={memoriesAdmin.memories}
                onCreate={memoriesAdmin.create}
                onUpdate={memoriesAdmin.update}
                onDelete={memoriesAdmin.remove}
                onGetContent={memoriesAdmin.getContent}
              />
            </div>
          ) : view === "agents" ? (
            <div className="module-hub">
              <AgentsModule
                agents={agentsAdmin.agents}
                tools={agentsAdmin.tools}
                models={selectableModels}
                skills={skillsAdmin.skills}
                onCreate={agentsAdmin.create}
                onUpdate={agentsAdmin.update}
                onSetEnabled={agentsAdmin.setEnabled}
                onDelete={agentsAdmin.remove}
                onGetDefinition={agentsAdmin.getDefinition}
                onGenerate={agentsAdmin.generate}
                onOpenPlugin={openPlugin}
                onMessage={onMessageAgent}
              />
            </div>
          ) : view === "skills" ? (
            <div className="module-hub">
              <SkillsModule
                skills={skillsAdmin.skills}
                onCreate={skillsAdmin.create}
                onImport={skillsAdmin.importSkill}
                onUpdate={skillsAdmin.update}
                onSetEnabled={skillsAdmin.setEnabled}
                onDelete={skillsAdmin.remove}
                onGetBundle={skillsAdmin.getBundle}
                onGenerate={skillsAdmin.generate}
                onOpenPlugin={openPlugin}
              />
            </div>
          ) : view === "mcp" ? (
            <div className="module-hub">
              <McpServersModule
                servers={mcpAdmin.servers}
                onCreate={mcpAdmin.create}
                onUpdate={mcpAdmin.update}
                onSetEnabled={mcpAdmin.setEnabled}
                onReconnect={mcpAdmin.reconnect}
                onDelete={mcpAdmin.remove}
                onGetDoc={mcpAdmin.getDoc}
                onGetTools={mcpAdmin.getTools}
                onOpenPlugin={openPlugin}
              />
            </div>
          ) : view === "plugins" ? (
            <div className="module-hub">
              <PluginsModule
                key={pluginFocus}
                plugins={pluginsAdmin.plugins}
                focusName={pluginFocus}
                onOpenAgents={() => setView("agents")}
                onOpenSkills={() => setView("skills")}
                onOpenMcpServers={() => setView("mcp")}
                onImport={pluginsAdmin.importPlugin}
                onDelete={pluginsAdmin.remove}
                onRefresh={pluginsAdmin.refreshPlugin}
              />
            </div>
          ) : view === "logs" ? (
            <div className="module-hub">
              <LogsModule client={client} />
            </div>
          ) : view === "settings" ? (
            <div className="module-hub">
              <SettingsModule
                client={client}
                theme={theme.preference}
                onThemeChange={theme.setPreference}
                persona={persona.value}
                personaStatus={persona.status}
                onPersonaChange={persona.setValue}
                onPersonaSave={persona.save}
                providers={providersAdmin.providers}
                models={selectableModels}
                allModels={allModels}
                defaultModel={providersAdmin.defaultModel}
                onProviderSave={providersAdmin.save}
                onProviderRemove={providersAdmin.remove}
                onLoadProviderFieldOptions={providersAdmin.fieldOptions}
                onRetryModels={retryModelCatalogs}
                onSetDefaultModel={providersAdmin.setDefault}
                providerStatuses={serverStatus?.inference.providers}
                enableMemories={features.enableMemories}
                enableAutomations={features.enableAutomations}
                onFeatureToggle={features.setFlag}
                maxToolCalls={agentSettings.maxToolCalls}
                maxSubagentToolCalls={agentSettings.maxSubagentToolCalls}
                onToolCallLimitChange={agentSettings.setToolCallLimit}
                notificationsAvailable={desktopNotifications !== undefined}
                notifyOnRunCompletion={
                  desktopNotifications?.notifyOnRunCompletion ?? true
                }
                notifyOnActionRequired={
                  desktopNotifications?.notifyOnActionRequired ?? true
                }
                onNotificationToggle={(key, value) =>
                  desktopNotifications?.setPreference(key, value)
                }
                category={settingsCategory}
                onCategoryChange={setSettingsCategory}
                connection={desktopConnection}
                runningCount={runningThreadIds.length}
              />
            </div>
          ) : (
            <div
              className={`module inbox-module${
                isMobile ? (showMobileList ? " mobile-list" : " mobile-chat") : ""
              }`}
            >
              <ModuleHeader icon={<Inbox size={18} />} title={L.inboxSection} count={threadCount}>
                <span className="module-header-spacer" />
                {!activeGraphId && (
                  <button
                    className={`rail-toggle${showRail ? " active" : ""}`}
                    title={showRail ? "Hide activity" : "Show activity"}
                    aria-pressed={showRail}
                    onClick={() => setShowRail((v) => !v)}
                  >
                    <Activity size={15} /> Activity
                    {Object.keys(delegations).length > 0 && (
                      <span className="rail-toggle-indicator" aria-hidden="true" />
                    )}
                  </button>
                )}
              </ModuleHeader>

              <div className="inbox-body">
                <Sidebar
                  client={client}
                  openedThreads={openedThreads}
                  activeThreadId={activeThreadId}
                  onSelect={onSelectThread}
                  onNewChat={onNewChat}
                  onOpenThread={(threadId) => openThread(threadId, true)}
                  onOpenSearchHit={onOpenSearchHit}
                  onDeleted={onThreadDeleted}
                  onThreadsLoaded={onThreadsLoaded}
                  threadTitles={threadTitles}
                  flaggedThreadIds={flaggedThreads}
                  backgroundThreadIds={backgroundThreadIds}
                  listRef={listRef}
                  onFocusComposer={focusComposer}
                />

                <main className="content">
                  <div className={panesClass(railVisible)}>
                    <section className="chat-pane">
                      <div className="pane-slot" style={{ display: "flex" }}>
                        {activeThreadId && activeGraphId ? (
                          <GraphRunPane
                            key={activeThreadId}
                            client={client}
                            threadId={activeThreadId}
                            graphId={activeGraphId}
                            title={activeThreadTitle ?? activeGraphId}
                            onRename={(title) => onRename(activeThreadId, title)}
                            {...(isMobile ? { onBack: onBackToList } : {})}
                          />
                        ) : activeThreadId ? (
                          <ChatPane
                            key={activeThreadId}
                            threadId={activeThreadId}
                            hydrateOnMount={openedThreads.has(activeThreadId)}
                            onFork={onFork}
                            agent={activeAgent}
                            {...(!activePersisted
                              ? {
                                  recipient: {
                                    options: recipients,
                                    ...(activeDraft?.agentId ? { value: activeDraft.agentId } : {}),
                                    onChange: (agentId: string | undefined) =>
                                      setDraftRecipient(activeThreadId, agentId),
                                  },
                                  beforeFirstSend: () => createDraftedThread(activeThreadId),
                                }
                              : activeAgentId
                                ? { recipient: {} }
                                : {})}
                            onRename={(title) => onRename(activeThreadId, title)}
                            models={selectableModels}
                            initialModel={activeModelId}
                            onModelChange={(modelId) => {
                              setSelectedThreadModels((prev) => {
                                if (prev.get(activeThreadId) === modelId) return prev;
                                return new Map(prev).set(activeThreadId, modelId);
                              });
                            }}
                            client={client}
                            title={activeThreadTitle}
                            composerRef={composerRef}
                            onComposerEscape={focusList}
                            history={history}
                            onBack={isMobile ? onBackToList : undefined}
                            searchTarget={
                              searchTarget?.threadId === activeThreadId ? searchTarget : undefined
                            }
                            onSearchTargetHandled={onSearchTargetHandled}
                            {...(activeAgentId && backgroundThreadIds.has(activeThreadId)
                              ? {
                                  workThread: {
                                    onOpenConversation: () => {
                                      onMessageAgent(activeAgentId).catch((error: unknown) =>
                                        console.error("open agent conversation failed", error),
                                      );
                                    },
                                  },
                                }
                              : {})}
                            headerActions={
                              <>
                                {threadTitles.has(activeThreadId) &&
                                  !backgroundThreadIds.has(activeThreadId) && (
                                  <FlagThreadButton
                                    todo={openTodoForThread(todos.todos, activeThreadId)}
                                    compact={isMobile}
                                    onFlag={() =>
                                      todos.create({
                                        title: (activeThreadTitle ?? "Conversation").slice(0, 200),
                                        threadIds: [activeThreadId],
                                      })
                                    }
                                    onOpenTodo={openTodo}
                                  />
                                )}
                                {isMobile && (
                                  <button
                                    className={`rail-toggle icon-only${showRail ? " active" : ""}`}
                                    title={showRail ? "Hide activity" : "Show activity"}
                                    aria-label={showRail ? "Hide activity" : "Show activity"}
                                    aria-pressed={showRail}
                                    onClick={() => setShowRail((v) => !v)}
                                  >
                                    <Activity size={16} />
                                    {Object.keys(delegations).length > 0 && (
                                      <span className="rail-toggle-indicator" aria-hidden="true" />
                                    )}
                                  </button>
                                )}
                              </>
                            }
                          />
                        ) : (
                          <NoConversation />
                        )}
                      </div>
                    </section>
                    {isMobile && railVisible && (
                      <div
                        className="pane-drawer-backdrop"
                        aria-hidden="true"
                        onClick={() => setShowRail(false)}
                      />
                    )}
                    {railVisible && (
                      <aside className="rail-pane">
                        <ActivityRail
                          delegations={delegations}
                          isRunning={isRunning}
                          threadId={activeThreadId}
                          onClose={() => setShowRail(false)}
                        />
                      </aside>
                    )}
                  </div>
                </main>
              </div>
            </div>
          )}
        </div>

        <HotkeyHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

        <StatusBar
          status={serverStatus}
          reachable={serverReachable}
          contextWindow={activeModel?.contextWindow}
          usage={active.usage}
          showContextUsage={
            view === "inbox" && activeThreadId !== null && (!isMobile || !showMobileList)
          }
          connection={desktopConnection?.state}
          onOpenConnection={
            desktopConnection ? openConnectionSettings : undefined
          }
          onOpenShortcuts={() => setHelpOpen(true)}
        />
      </div>
      </AgentNamesContext.Provider>
    </TooltipProvider>
  );
}
