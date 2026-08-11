import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Map<
    string,
    (event: unknown, ...args: unknown[]) => void
  >(),
  invoke: vi.fn(),
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld(name: string, value: unknown) {
      electron.exposed.set(name, value);
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on(
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void,
    ) {
      electron.listeners.set(channel, listener);
    },
    send: electron.send,
    sendSync: vi.fn(() => ""),
  },
}));

describe("desktop preload notification bridge", () => {
  beforeAll(async () => {
    await import("./preload.js");
  });

  beforeEach(() => {
    electron.send.mockClear();
  });

  it("buffers a clicked thread until the renderer registers", () => {
    const openThread = electron.listeners.get(
      "pizza:notifications:open-thread",
    );
    const bridge = electron.exposed.get("__PIZZA_NOTIFICATIONS__") as {
      onOpenThread(listener: (threadId: string) => void): () => void;
    };
    expect(openThread).toBeDefined();
    expect(bridge).toBeDefined();

    openThread?.({}, "thread-before-ready");
    const firstListener = vi.fn();
    const unsubscribe = bridge.onOpenThread(firstListener);
    expect(firstListener).toHaveBeenCalledWith("thread-before-ready");

    openThread?.({}, "thread-while-ready");
    expect(firstListener).toHaveBeenCalledWith("thread-while-ready");

    unsubscribe();
    openThread?.({}, "thread-after-unmount");
    const secondListener = vi.fn();
    bridge.onOpenThread(secondListener);
    expect(secondListener).toHaveBeenCalledWith("thread-after-unmount");
  });

  it("publishes the active thread to the main process", () => {
    const bridge = electron.exposed.get("__PIZZA_NOTIFICATIONS__") as {
      setActiveThread(threadId: string | null): void;
    };

    bridge.setActiveThread("thread-1");
    bridge.setActiveThread(null);

    expect(electron.send).toHaveBeenNthCalledWith(
      1,
      "pizza:notifications:active-thread",
      "thread-1",
    );
    expect(electron.send).toHaveBeenNthCalledWith(
      2,
      "pizza:notifications:active-thread",
      null,
    );
  });
});
