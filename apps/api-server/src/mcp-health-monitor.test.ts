import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { McpHealthMonitor, type McpClientLike } from "./mcp-health-monitor.js";

interface FakeConn {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  transport?: { stderr?: PassThrough | null };
}

function fakeClient(conns: Record<string, FakeConn>): McpClientLike {
  return {
    getClient: async (server: string) => conns[server] as never,
  };
}

const catalogOf = (m: Record<string, string[]>) => m;

describe("McpHealthMonitor", () => {
  it("reports connected servers with their tool counts", async () => {
    const mon = new McpHealthMonitor();
    const conns = { outlook: {} as FakeConn };
    await mon.arm(fakeClient(conns), catalogOf({ outlook: ["email_read", "email_send"] }), () => {});
    expect(mon.snapshot()).toEqual({ outlook: { status: "connected", toolCount: 2 } });
  });

  it("marks a server crashed and invokes onCrash when its connection closes", async () => {
    const mon = new McpHealthMonitor();
    const conns = { outlook: {} as FakeConn };
    const onCrash = vi.fn();
    await mon.arm(fakeClient(conns), catalogOf({ outlook: ["email_read"] }), onCrash);

    conns.outlook.onclose?.();

    expect(onCrash).toHaveBeenCalledExactlyOnceWith("outlook");
    const outlook = mon.snapshot().outlook!;
    expect(outlook.status).toBe("crashed");
    expect(outlook.toolCount).toBe(0);
    expect(outlook.crashedAt).toBeTypeOf("string");
    expect(outlook.detail).toBe("connection closed unexpectedly");
  });

  it("uses the last onerror message as the crash detail", async () => {
    const mon = new McpHealthMonitor();
    const conns = { outlook: {} as FakeConn };
    await mon.arm(fakeClient(conns), catalogOf({ outlook: ["email_read"] }), () => {});

    conns.outlook.onerror?.(new Error("spawn ENOENT token=private-value"));
    conns.outlook.onclose?.();

    expect(mon.snapshot().outlook!.detail).toBe("spawn ENOENT token=<redacted>");
  });

  it("captures a bounded stderr tail newest-last", async () => {
    const mon = new McpHealthMonitor();
    const stderr = new PassThrough();
    const conns = { outlook: { transport: { stderr } } as FakeConn };
    await mon.arm(fakeClient(conns), catalogOf({ outlook: ["email_read"] }), () => {});

    stderr.emit("data", Buffer.from("boot ok\nwarn: token=private-value\n"));
    stderr.emit("data", Buffer.from("fatal: auth failed\n"));
    conns.outlook.onclose?.();

    expect(mon.snapshot().outlook!.stderrTail).toEqual([
      "boot ok",
      "warn: token=<redacted>",
      "fatal: auth failed",
    ]);
  });

  it("does NOT treat a close as a crash after disarm (intentional teardown)", async () => {
    const mon = new McpHealthMonitor();
    const conns = { outlook: {} as FakeConn };
    const onCrash = vi.fn();
    await mon.arm(fakeClient(conns), catalogOf({ outlook: ["email_read"] }), onCrash);

    mon.disarm();
    conns.outlook.onclose?.();

    expect(onCrash).not.toHaveBeenCalled();
    expect(mon.snapshot().outlook?.status).not.toBe("crashed");
  });

  it("ignores a stale-generation close from a connection armed before a re-arm", async () => {
    const mon = new McpHealthMonitor();
    const oldConn = {} as FakeConn;
    const newConn = {} as FakeConn;
    const onCrash = vi.fn();
    await mon.arm(fakeClient({ outlook: oldConn }), catalogOf({ outlook: ["a"] }), onCrash);
    await mon.arm(fakeClient({ outlook: newConn }), catalogOf({ outlook: ["a", "b"] }), onCrash);

    oldConn.onclose?.();
    expect(onCrash).not.toHaveBeenCalled();
    expect(mon.snapshot().outlook!.status).toBe("connected");

    newConn.onclose?.();
    expect(onCrash).toHaveBeenCalledExactlyOnceWith("outlook");
  });

  it("re-arms one server without invalidating sibling crash handlers", async () => {
    const mon = new McpHealthMonitor();
    const oldOutlook = {} as FakeConn;
    const calendar = {} as FakeConn;
    const newOutlook = {} as FakeConn;
    const onCrash = vi.fn();
    await mon.arm(
      fakeClient({ outlook: oldOutlook, calendar }),
      catalogOf({ outlook: ["mail"], calendar: ["events"] }),
      onCrash,
    );

    await mon.armServer(
      fakeClient({ outlook: newOutlook }),
      "outlook",
      ["mail", "send"],
      onCrash,
    );
    oldOutlook.onclose?.();
    expect(onCrash).not.toHaveBeenCalled();

    calendar.onclose?.();
    expect(onCrash).toHaveBeenCalledExactlyOnceWith("calendar");
    newOutlook.onclose?.();
    expect(onCrash).toHaveBeenNthCalledWith(2, "outlook");
  });

  it("only fires onCrash once for repeated closes of the same server", async () => {
    const mon = new McpHealthMonitor();
    const conns = { outlook: {} as FakeConn };
    const onCrash = vi.fn();
    await mon.arm(fakeClient(conns), catalogOf({ outlook: ["a"] }), onCrash);

    conns.outlook.onclose?.();
    conns.outlook.onclose?.();

    expect(onCrash).toHaveBeenCalledOnce();
  });

  it("skips servers whose client can't be fetched (already-failed / non-stdio)", async () => {
    const mon = new McpHealthMonitor();
    const client: McpClientLike = { getClient: async () => undefined };
    await mon.arm(client, catalogOf({ ghost: ["x"] }), () => {});
    expect(mon.snapshot().ghost!).toEqual({ status: "connected", toolCount: 1 });
  });
});
