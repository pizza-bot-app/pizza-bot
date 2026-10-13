import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings, type AppSettingsPatch } from "@pizza-bot/core";
import type { ApiClient } from "./api-client.js";

const react = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  toast: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: () => {},
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(initial: T) => {
    const index = react.index++;
    react.slots[index] ??= { current: initial };
    return react.slots[index];
  },
  useState: <T>(initial: T | (() => T)) => {
    const index = react.index++;
    if (!(index in react.slots)) {
      react.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    }
    return [react.slots[index], (next: T | ((previous: T) => T)) => {
      react.slots[index] = typeof next === "function"
        ? (next as (previous: T) => T)(react.slots[index] as T)
        : next;
    }];
  },
}));

vi.mock("./components/AppToast.js", () => ({ useAppToast: () => react.toast }));

const { useSettings } = await import("./use-settings.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  let saved = { ...DEFAULT_SETTINGS };
  const requests: Array<{
    patch: AppSettingsPatch;
    result: ReturnType<typeof deferred<AppSettings>>;
  }> = [];
  const client = {
    updateSettings: (patch: AppSettingsPatch) => {
      const result = deferred<AppSettings>();
      requests.push({ patch, result });
      return result.promise;
    },
  } as unknown as ApiClient;
  const useRender = () => {
    react.index = 0;
    return useSettings(client);
  };
  const settle = async (index: number, error?: Error) => {
    await vi.waitFor(() => expect(requests[index]).toBeDefined());
    const request = requests[index]!;
    if (error) {
      request.result.reject(error);
    } else {
      saved = { ...saved, ...request.patch };
      request.result.resolve(saved);
    }
    await request.result.promise.catch(() => {});
  };
  return { render: useRender, settle, saved: () => saved };
}

describe("useSettings favorite saves", () => {
  beforeEach(() => {
    react.slots = [];
    react.index = 0;
    react.toast.mockReset();
  });

  it("preserves newer toggles when earlier saves finish", async () => {
    const { render, settle, saved } = setup();
    render().favoriteModels.toggle("test:a");
    render().favoriteModels.toggle("test:b");

    await settle(0);
    expect(render().favoriteModels.ids).toEqual(["test:a", "test:b"]);
    render().favoriteModels.toggle("test:c");
    await settle(1);
    expect(render().favoriteModels.ids).toEqual(["test:a", "test:b", "test:c"]);
    await settle(2);

    expect(saved().favoriteModels).toEqual(["test:a", "test:b", "test:c"]);
    expect(render().favoriteModels.ids).toEqual(saved().favoriteModels);
  });

  it("uses the latest optimistic list for toggles before a rerender", async () => {
    const { render, settle, saved } = setup();
    const { toggle } = render().favoriteModels;
    toggle("test:a");
    toggle("test:b");
    toggle("test:a");
    expect(render().favoriteModels.ids).toEqual(["test:b"]);

    await settle(0);
    await settle(1);
    await settle(2);

    expect(saved().favoriteModels).toEqual(["test:b"]);
    expect(render().favoriteModels.ids).toEqual(["test:b"]);
  });

  it("keeps newer edits visible when an earlier save fails", async () => {
    const { render, settle, saved } = setup();
    render().favoriteModels.toggle("test:a");
    render().favoriteModels.toggle("test:b");

    await settle(0, new Error("offline"));
    expect(render().favoriteModels.ids).toEqual(["test:a", "test:b"]);
    await settle(1);

    expect(saved().favoriteModels).toEqual(["test:a", "test:b"]);
    expect(render().favoriteModels.ids).toEqual(saved().favoriteModels);
    expect(react.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Couldn't save favorite models", description: "offline", tone: "error",
    }));
  });

  it("rolls back to the last confirmed list when queued saves fail", async () => {
    const { render, settle, saved } = setup();
    render().favoriteModels.toggle("test:a");
    render().favoriteModels.toggle("test:b");
    render().favoriteModels.toggle("test:c");

    await settle(0);
    await settle(1, new Error("offline"));
    await settle(2, new Error("offline"));

    expect(saved().favoriteModels).toEqual(["test:a"]);
    expect(render().favoriteModels.ids).toEqual(["test:a"]);

    render().favoriteModels.toggle("test:d");
    await settle(3);
    expect(saved().favoriteModels).toEqual(["test:a", "test:d"]);
    expect(render().favoriteModels.ids).toEqual(saved().favoriteModels);
  });

  it("does not overwrite other optimistic settings with a favorites response", async () => {
    const { render, settle } = setup();
    render().favoriteModels.toggle("test:a");
    await Promise.resolve();
    render().theme.setPreference("light");

    await settle(0);
    expect(render().theme.preference).toBe("light");
    await settle(1);
  });
});
