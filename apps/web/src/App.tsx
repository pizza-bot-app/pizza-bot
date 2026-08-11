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
import { useSkillsAdmin, useMcpServersAdmin, useMemoriesAdmin, useModels, usePluginsAdmin, useProvidersAdmin, useStatus, useTriggers } from "./use-app-data.js";
import { PIZZA_BOT_AGENT } from "@pizza-bot/core";
import { SkillsModule } from "./components/skills/SkillsModule.js";
import { McpServersModule } from "./components/mcp/McpServersModule.js";
import { MemoriesModule } from "./components/memories/MemoriesModule.js";
import { TriggerModule } from "./components/schedules/TriggerModule.js";
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
  const skillsAdmin = useSkillsAdmin(client, visibleAdmin.skills);
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
  const providersAdmin = useProvidersAdmin(client, refreshModelCatalogs);
  const retryModelCatalogs = useCallback(
    () => Promise.all([retryModels(), retryAllModels()]),
    [retryAllModels, retryModels],
  );
  const { status: serverStatus, reachable: serverReachable } = useStatus(client);
  const selectableModels = useMemo(
    () =>
      availableModels(
        configuredModels(models, providersAdmin.providers),
        serverStatus?.inference.providers,
      ),
    [models, providersAdmin.providers, serverStatus?.inference.providers],
  );

  const triggers = useTriggers(client, 5_000, visibleAdmin.triggers);

  const { theme, persona, features } = useSettings(client);

  const [threadTitles, setThreadTitles] = useState<Map<string, string>>(() => new Map());
  const [threadModels, setThreadModels] = useState<Map<string, string>>(() => new Map());
  const [selectedThreadModels, setSelectedThreadModels] = useState<Map<string, string>>(
    () => new Map(),
  );

  const seedThreadMetadata = useCallback((rows: ThreadInfo[]) => {
    setThreadCount(rows.length);
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
    // On the first load, land on the most recent conversation (or a fresh draft
    // when there are none) instead of a dead-end empty state. Never overrides a
    // thread the user already opened.
    if (!didAutoOpenRef.current && activeThreadIdRef.current === null) {
      didAutoOpenRef.current = true;
      const recency = (t: ThreadInfo) =>
        t.lastActivityAt ? Date.parse(t.lastActivityAt) : 0;
      const mostRecent = rows.reduce<ThreadInfo | null>(
        (best, t) => (best === null || recency(t) > recency(best) ? t : best),
        null,
      );
      if (mostRecent) {
        setOpenedThreads((prev) => (prev.has(mostRecent.threadId) ? prev : new Set(prev).add(mostRecent.threadId)));
        setActiveThreadId(mostRecent.threadId);
      } else {
        shouldFocusComposerRef.current = true;
        setActiveThreadId(freshThreadId());
      }
    }
  }, []);

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
      (view === "automations" && !features.enableAutomations) ||
      (view === "memories" && !features.enableMemories)
    ) {
      setView("inbox");
    }
  }, [view, features.enableAutomations, features.enableMemories]);

  const onNewChat = useCallback(() => {
    shouldFocusComposerRef.current = true;
    setSearchTarget(null);
    setView("inbox");
    openThread(freshThreadId(), false);
  }, [openThread]);

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
      setActiveThreadId((active) =>
        active === threadId ? ([...next][next.size - 1] ?? null) : active,
      );
      return next;
    });
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
  useHotkey("app.newChat", onNewChat);
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

  const active = useThreadSliceReadOnly(activeThreadId);
  const delegations = active.delegations;
  const status = active.status;
  const isRunning = status === "streaming";

  return (
    <TooltipProvider>
      <div className="app has-sidebar">
        <div className="body">
          <AppNavigation
            view={view}
            enableAutomations={features.enableAutomations}
            enableMemories={features.enableMemories}
            onViewChange={setView}
          />

          {view === "automations" ? (
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
          ) : view === "skills" ? (
            <div className="module-hub">
              <SkillsModule
                skills={skillsAdmin.skills}
                tools={skillsAdmin.tools}
                onCreate={skillsAdmin.create}
                onImport={skillsAdmin.importSkill}
                onUpdate={skillsAdmin.update}
                onSetEnabled={skillsAdmin.setEnabled}
                onDelete={skillsAdmin.remove}
                onGetBundle={skillsAdmin.getBundle}
                onGenerate={skillsAdmin.generate}
              />
            </div>
          ) : view === "mcp" ? (
            <div className="module-hub">
              <McpServersModule
                servers={mcpAdmin.servers}
                onCreate={mcpAdmin.create}
                onUpdate={mcpAdmin.update}
                onSetEnabled={mcpAdmin.setEnabled}
                onDelete={mcpAdmin.remove}
                onGetDoc={mcpAdmin.getDoc}
              />
            </div>
          ) : view === "plugins" ? (
            <div className="module-hub">
              <PluginsModule
                plugins={pluginsAdmin.plugins}
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
                onProviderUpdate={providersAdmin.update}
                onProviderRemove={providersAdmin.remove}
                onProviderModelsChange={providersAdmin.setModels}
                onRetryModels={retryModelCatalogs}
                onSetDefaultModel={providersAdmin.setDefault}
                providerStatuses={serverStatus?.inference.providers}
                enableMemories={features.enableMemories}
                enableAutomations={features.enableAutomations}
                onFeatureToggle={features.setFlag}
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
                  onThreadsLoaded={seedThreadMetadata}
                  threadTitles={threadTitles}
                  listRef={listRef}
                  onFocusComposer={focusComposer}
                />

                <main className="content">
                  <div className={panesClass(showRail)}>
                    <section className="chat-pane">
                      <div className="pane-slot" style={{ display: "flex" }}>
                        {activeThreadId ? (
                          <ChatPane
                            key={activeThreadId}
                            threadId={activeThreadId}
                            hydrateOnMount={openedThreads.has(activeThreadId)}
                            onFork={onFork}
                            agent={agent}
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
                            headerActions={
                              isMobile ? (
                                <button
                                  className={`rail-toggle icon-only${showRail ? " active" : ""}`}
                                  title={showRail ? "Hide activity" : "Show activity"}
                                  aria-label={showRail ? "Hide activity" : "Show activity"}
                                  aria-pressed={showRail}
                                  onClick={() => setShowRail((v) => !v)}
                                >
                                  <Activity size={16} />
                                </button>
                              ) : undefined
                            }
                          />
                        ) : (
                          <NoConversation />
                        )}
                      </div>
                    </section>
                    {isMobile && showRail && (
                      <div
                        className="pane-drawer-backdrop"
                        aria-hidden="true"
                        onClick={() => setShowRail(false)}
                      />
                    )}
                    {showRail && (
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
    </TooltipProvider>
  );
}
