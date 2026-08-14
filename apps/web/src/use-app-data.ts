import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiClient,
  ModelsInfo,
  StatusInfo,
  SkillCatalogInfo,
  SkillBundle,
  ToolCatalogInfo,
  MemoryInfo,
  McpServerRow,
  McpServerEntryWire,
  ProviderView,
  PluginInfo,
} from "@/api-client";
import type { TriggerDef } from "@pizza-bot/core";

function useAdminData<D>(
  load: () => Promise<D>,
  initial: D,
  intervalMs?: number,
  enabled = true,
): { data: D; loading: boolean; refresh: () => Promise<D> } {
  const [data, setData] = useState<D>(initial);
  const [loading, setLoading] = useState(true);
  const latestRequest = useRef(0);

  const commit = useCallback((request: number, next: D) => {
    if (request !== latestRequest.current) return;
    setData(next);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    const next = await load();
    commit(request, next);
    return next;
  }, [commit, load]);

  useEffect(() => {
    if (!enabled) {
      latestRequest.current += 1;
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const tick = () => {
      const request = ++latestRequest.current;
      void load()
        .then((next) => {
          if (alive) commit(request, next);
        })
        .catch(() => {
          if (alive && request === latestRequest.current) setLoading(false);
        });
    };
    tick();
    if (intervalMs === undefined) {
      return () => {
        alive = false;
      };
    }
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [commit, load, intervalMs, enabled]);

  return { data, loading, refresh };
}

function refreshAfter<A extends unknown[], R>(
  mutate: (...args: A) => Promise<R>,
  refresh: () => Promise<unknown>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const result = await mutate(...args);
    await refresh();
    return result;
  };
}

async function settleRefreshes(
  tasks: Array<Promise<unknown> | undefined>,
): Promise<void> {
  const results = await Promise.allSettled(
    tasks.filter((task): task is Promise<unknown> => task !== undefined),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

export function useSkillsAdmin(client: ApiClient, enabled = true) {
  const { data: skills, refresh } = useAdminData(
    useCallback(() => client.listSkills(), [client]),
    { skills: [] } as SkillCatalogInfo,
    undefined,
    enabled,
  );
  const { data: tools } = useAdminData(
    useCallback(() => client.listTools(), [client]),
    { builtins: [], servers: [] } as ToolCatalogInfo,
    undefined,
    enabled,
  );

  const create = refreshAfter((bundle: SkillBundle) => client.createSkill(bundle), refresh);
  const importSkill = refreshAfter((file: File) => client.importSkill(file), refresh);
  const update = refreshAfter((id: string, bundle: SkillBundle) => client.updateSkill(id, bundle), refresh);
  const setEnabled = refreshAfter(
    (id: string, enabled: boolean) => client.setSkillEnabled(id, enabled),
    refresh,
  );
  const remove = refreshAfter((id: string) => client.deleteSkill(id), refresh);
  const getBundle = useCallback((id: string) => client.getSkill(id), [client]);
  const generate = useCallback((prompt: string) => client.generateSkill(prompt), [client]);

  return { skills, tools, refresh, create, importSkill, update, setEnabled, remove, getBundle, generate };
}

export function usePluginsAdmin(client: ApiClient, enabled = true) {
  const { data: plugins, loading, refresh } = useAdminData(
    useCallback(() => client.listPlugins(), [client]),
    [] as PluginInfo[],
    undefined,
    enabled,
  );

  const importPlugin = refreshAfter((file: File) => client.importPlugin(file), refresh);
  const remove = refreshAfter((name: string) => client.deletePlugin(name), refresh);
  const refreshPlugin = refreshAfter(
    (name: string) => client.refreshPlugin(name),
    refresh,
  );

  return {
    plugins,
    loading,
    refresh,
    importPlugin,
    remove,
    refreshPlugin,
  };
}

export function useMemoriesAdmin(client: ApiClient, intervalMs = 5_000, enabled = true) {
  const { data: memories, refresh } = useAdminData(
    useCallback(() => client.listMemories(), [client]),
    [] as MemoryInfo[],
    intervalMs,
    enabled,
  );

  const create = refreshAfter((id: string, content: string) => client.createMemory(id, content), refresh);
  const update = refreshAfter((id: string, content: string) => client.updateMemory(id, content), refresh);
  const remove = refreshAfter((id: string) => client.deleteMemory(id), refresh);
  const getContent = useCallback((id: string) => client.getMemory(id), [client]);

  return { memories, refresh, create, update, remove, getContent };
}

export function useMcpServersAdmin(client: ApiClient, intervalMs = 5_000, enabled = true) {
  const { data: servers, loading, refresh } = useAdminData(
    useCallback(() => client.listMcpServers(), [client]),
    [] as McpServerRow[],
    intervalMs,
    enabled,
  );

  const create = refreshAfter((id: string, entry: McpServerEntryWire) => client.createMcpServer(id, entry), refresh);
  const update = refreshAfter((id: string, entry: McpServerEntryWire) => client.updateMcpServer(id, entry), refresh);
  const setEnabled = refreshAfter(
    (id: string, enabled: boolean) => client.setMcpServerEnabled(id, enabled),
    refresh,
  );
  const reconnect = refreshAfter(
    (id: string) => client.reconnectMcpServer(id),
    refresh,
  );
  const remove = refreshAfter((id: string) => client.deleteMcpServer(id), refresh);
  const getDoc = useCallback((id: string) => client.getMcpServer(id), [client]);

  return {
    servers,
    loading,
    refresh,
    create,
    update,
    setEnabled,
    reconnect,
    remove,
    getDoc,
  };
}

// Provider changes can alter both model catalogs and live health, so callers
// publish one authoritative refresh only after the related writes settle.
export function useProvidersAdmin(
  client: ApiClient,
  onModelsStale?: () => Promise<unknown>,
  onStatusStale?: () => Promise<unknown>,
) {
  const { data: providers, loading, refresh } = useAdminData(
    useCallback(() => client.listProviders(), [client]),
    [] as ProviderView[],
  );
  const { data: defaultModel, refresh: refreshDefault } = useAdminData(
    useCallback(() => client.getDefaultModel(), [client]),
    null as string | null,
  );

  const refreshAuthoritative = useCallback(
    () =>
      settleRefreshes([
        refresh(),
        onModelsStale?.(),
        onStatusStale?.(),
      ]),
    [refresh, onModelsStale, onStatusStale],
  );
  const refreshDefaultAndModels = useCallback(
    () =>
      settleRefreshes([
        refreshDefault(),
        onModelsStale?.(),
        onStatusStale?.(),
      ]),
    [refreshDefault, onModelsStale, onStatusStale],
  );

  const save = useCallback(async (
    id: string,
    config: { method: string; values: Record<string, string> },
    preferences: import("@/api-client").ProviderModelPreferences,
  ) => {
    let mutationFailed = false;
    let mutationError: unknown;
    try {
      await client.updateProvider(id, config);
      await client.updateProviderModels(id, preferences);
    } catch (cause) {
      mutationFailed = true;
      mutationError = cause;
    }

    try {
      await refreshAuthoritative();
    } catch (refreshError) {
      if (!mutationFailed) throw refreshError;
    }
    if (mutationFailed) throw mutationError;
  }, [client, refreshAuthoritative]);

  const remove = refreshAfter(
    (id: string) => client.deleteProvider(id),
    refreshAuthoritative,
  );
  const setDefault = refreshAfter((model: string | null) => client.setDefaultModel(model), refreshDefaultAndModels);

  return { providers, loading, defaultModel, refresh, save, remove, setDefault };
}

export function useModels(
  client: ApiClient,
  includeDisabled = false,
): {
  models: ModelsInfo;
  refresh: () => Promise<ModelsInfo>;
  retry: () => Promise<ModelsInfo>;
} {
  const forceRefresh = useRef(false);
  const { data: models, refresh } = useAdminData(
    useCallback(async () => {
      const force = forceRefresh.current;
      forceRefresh.current = false;
      return client.listModels(includeDisabled, force);
    }, [client, includeDisabled]),
    { models: [], providers: [], default: "" } as ModelsInfo,
  );
  const retry = useCallback(() => {
    forceRefresh.current = true;
    return refresh();
  }, [refresh]);
  return { models, refresh, retry };
}

export function useTriggers(client: ApiClient, intervalMs = 5_000, enabled = true) {
  const { data: triggers, loading, refresh } = useAdminData(
    useCallback(() => client.listTriggers(), [client]),
    [] as TriggerDef[],
    intervalMs,
    enabled,
  );

  const create = refreshAfter((def: Partial<TriggerDef>) => client.createTrigger(def), refresh);
  const update = refreshAfter((id: string, patch: Partial<TriggerDef>) => client.updateTrigger(id, patch), refresh);
  const remove = refreshAfter((id: string) => client.deleteTrigger(id), refresh);
  const invoke = useCallback(
    (id: string, secret: string, body?: unknown) => client.invokeTrigger(id, secret, body),
    [client],
  );
  const run = refreshAfter((id: string) => client.runTrigger(id), refresh);

  return { triggers, loading, refresh, create, update, remove, invoke, run };
}

export interface ServerStatus {
  status: StatusInfo | undefined;
  // undefined until the first poll resolves; false once a poll fails (server unreachable).
  reachable: boolean | undefined;
}

export interface ServerStatusAdmin extends ServerStatus {
  refresh: () => Promise<StatusInfo | undefined>;
}

export function useStatus(
  client: ApiClient,
  intervalMs = 15_000,
  loadingIntervalMs = 1_000,
): ServerStatusAdmin {
  const [state, setState] = useState<ServerStatus>({ status: undefined, reachable: undefined });
  const latestRequest = useRef(0);
  const manualRefresh = useRef<() => Promise<StatusInfo | undefined>>(
    () => Promise.resolve(undefined),
  );

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delayFor = (status: StatusInfo | undefined) => {
      const mcpLoading =
        status === undefined ||
        status.mcp.servers.some(
          (server) => server.status === "loading" || server.status === "retrying",
        );
      return mcpLoading ? loadingIntervalMs : intervalMs;
    };
    const schedule = (delay: number) => {
      if (alive) timer = setTimeout(() => void tick(), delay);
    };
    const load = async () => {
      const request = ++latestRequest.current;
      try {
        const status = await client.getStatus();
        const current = alive && request === latestRequest.current;
        if (current) {
          setState((prev) => ({ status: status ?? prev.status, reachable: true }));
        }
        return { status, current };
      } catch (error) {
        const current = alive && request === latestRequest.current;
        if (current) setState((prev) => ({ ...prev, reachable: false }));
        return { error, current };
      }
    };

    const tick = async () => {
      const result = await load();
      if (!result.current) return;
      schedule("status" in result ? delayFor(result.status) : intervalMs);
    };

    manualRefresh.current = async () => {
      if (timer !== undefined) clearTimeout(timer);
      const result = await load();
      if (result.current) {
        schedule("status" in result ? delayFor(result.status) : intervalMs);
      }
      if ("error" in result) throw result.error;
      return result.status;
    };

    void tick();
    return () => {
      alive = false;
      latestRequest.current += 1;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, intervalMs, loadingIntervalMs]);

  const refresh = useCallback(() => manualRefresh.current(), []);
  return { ...state, refresh };
}
