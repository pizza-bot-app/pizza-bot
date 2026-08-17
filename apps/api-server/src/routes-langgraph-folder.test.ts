import { describe, expect, it, vi } from "vitest";
import type { AgentHost } from "./agent-host.js";
import { langGraphRoutes } from "./routes-langgraph.js";

describe("langGraphRoutes: folder metadata", () => {
  it("persists a requested folder when creating a thread", async () => {
    const ensure = vi.fn();
    const host = {
      folderStore: {
        get: (folderId: string) =>
          folderId === "projects" ? { folderId, name: "Projects" } : undefined,
      },
      threadStore: { ensure },
    } as unknown as AgentHost;

    const response = await langGraphRoutes(host).request("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: "thread-1",
        metadata: { folder_id: "projects" },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      thread_id: "thread-1",
      metadata: { folder_id: "projects" },
    });
    expect(ensure).toHaveBeenCalledWith({
      threadId: "thread-1",
      folderId: "projects",
    });
  });

  it("rejects an unknown folder without creating a thread", async () => {
    const ensure = vi.fn();
    const host = {
      folderStore: { get: () => undefined },
      threadStore: { ensure },
    } as unknown as AgentHost;

    const response = await langGraphRoutes(host).request("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: "thread-1",
        metadata: { folder_id: "missing" },
      }),
    });

    expect(response.status).toBe(404);
    expect(ensure).not.toHaveBeenCalled();
  });
});
