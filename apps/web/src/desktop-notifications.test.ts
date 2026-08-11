import { afterEach, describe, expect, it, vi } from "vitest";

const react = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  preferences: {
    notifyOnRunCompletion: true,
    notifyOnActionRequired: true,
  },
  setPreferences: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    react.effects.push(effect);
  },
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(value: T) => ({ current: value }),
  useState: () => [react.preferences, react.setPreferences],
}));

vi.mock("./components/AppToast.js", () => ({
  useAppToast: () => react.toast,
}));

import { useDesktopNotifications } from "./desktop-notifications.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("desktop notification preferences", () => {
  afterEach(() => {
    react.effects.length = 0;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("rolls the latest failed save back to the preceding optimistic value", async () => {
    const first = deferred<typeof react.preferences>();
    const second = deferred<typeof react.preferences>();
    const bridge = {
      getSettings: vi.fn(),
      onOpenThread: vi.fn(),
      setActiveThread: vi.fn(),
      updateSettings: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    vi.stubGlobal("window", { __PIZZA_NOTIFICATIONS__: bridge });
    const notifications = useDesktopNotifications(vi.fn(), null);

    notifications?.setPreference("notifyOnRunCompletion", false);
    notifications?.setPreference("notifyOnRunCompletion", true);
    first.resolve({
      notifyOnRunCompletion: false,
      notifyOnActionRequired: true,
    });
    await first.promise;
    second.reject(new Error("save failed"));
    await expect(second.promise).rejects.toThrow("save failed");
    await vi.waitFor(() => {
      expect(react.setPreferences).toHaveBeenLastCalledWith({
        notifyOnRunCompletion: false,
        notifyOnActionRequired: true,
      });
    });

    expect(react.setPreferences).toHaveBeenCalledTimes(3);
    expect(react.toast).toHaveBeenCalledOnce();
  });

  it("publishes the active thread again when the window regains focus", () => {
    let focusListener: (() => void) | undefined;
    const bridge = {
      getSettings: vi.fn(),
      onOpenThread: vi.fn(),
      setActiveThread: vi.fn(),
      updateSettings: vi.fn(),
    };
    const addEventListener = vi.fn(
      (event: string, listener: () => void) => {
        if (event === "focus") focusListener = listener;
      },
    );
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      __PIZZA_NOTIFICATIONS__: bridge,
      addEventListener,
      removeEventListener,
    });

    useDesktopNotifications(vi.fn(), "thread-1");
    const cleanup = react.effects.at(-1)?.();

    expect(bridge.setActiveThread).toHaveBeenCalledWith("thread-1");
    focusListener?.();
    expect(bridge.setActiveThread).toHaveBeenCalledTimes(2);

    if (typeof cleanup === "function") cleanup();
    expect(removeEventListener).toHaveBeenCalledWith(
      "focus",
      expect.any(Function),
    );
  });
});
