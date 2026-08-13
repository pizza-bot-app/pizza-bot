// The desktop preload injects these bridges; browser builds leave them absent.
interface Window {
  __PIZZA_API_BASE__?: string;
  __PIZZA_API_TOKEN__?: string;
  __PIZZA_CONFIG__?: {
    apiBase?: string;
    apiToken?: string;
  };
  __PIZZA_SECRETS__?: {
    list(): Promise<string[]>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  __PIZZA_CONNECTION__?: {
    get(): Promise<PizzaConnectionState>;
    useRemote(input: {
      remoteUrl: string;
      token?: string | null;
    }): Promise<PizzaConnectionState>;
    useLocal(): Promise<PizzaConnectionState>;
  };
  __PIZZA_LOCAL_FOLDERS__?: {
    pickDirectory(): Promise<string | undefined>;
  };
  __PIZZA_LOGS__?: {
    local: boolean;
    write(record: unknown): void;
    query(query?: unknown): Promise<unknown>;
    clear(): Promise<{ deleted: number }>;
  };
  __PIZZA_NOTIFICATIONS__?: {
    setActiveThread(threadId: string | null): void;
    getSettings(): Promise<PizzaNotificationSettings>;
    updateSettings(
      patch: Partial<PizzaNotificationSettings>,
    ): Promise<PizzaNotificationSettings>;
    onOpenThread(listener: (threadId: string) => void): () => void;
  };
}

interface PizzaNotificationSettings {
  notifyOnRunCompletion: boolean;
  notifyOnActionRequired: boolean;
}

interface PizzaConnectionState {
  mode: "local" | "remote";
  remoteUrl?: string;
  hasToken: boolean;
  managedByEnvironment: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ImportMetaEnv {}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
