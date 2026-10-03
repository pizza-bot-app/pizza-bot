import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_WORKSPACE,
  SmolvmSandbox,
  SmolvmSandboxPool,
  createSmolvmRunner,
  machineNameForThread,
  resolveSmolvmCommand,
  type CliResult,
  type CliRunOptions,
  type SmolvmRunner,
} from "./smolvm-sandbox.js";

const ok = (stdout = ""): CliResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  truncated: false,
  timedOut: false,
});

const fail = (stderr: string): CliResult => ({ ...ok(), exitCode: 1, stderr });

interface Call {
  args: readonly string[];
  options: CliRunOptions | undefined;
}

function fakeRunner(
  respond: (
    args: readonly string[],
    options?: CliRunOptions,
  ) => CliResult | Promise<CliResult> = () => ok(),
): { run: SmolvmRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (args, options) => {
      calls.push({ args, options });
      return respond(args, options);
    },
  };
}

const subcommands = (calls: Call[]) => calls.map((call) => call.args.slice(0, 2).join(" "));

describe("resolveSmolvmCommand", () => {
  it("runs the release binary with its bundled libraries outside Windows", () => {
    const command = resolveSmolvmCommand({ dir: "/opt/smolvm" }, "darwin");
    expect(command.file).toBe(path.join("/opt/smolvm", "smolvm-bin"));
    expect(command.env).toEqual({
      SMOLVM_LIB_DIR: path.join("/opt/smolvm", "lib"),
      SMOLVM_AGENT_ROOTFS: path.join("/opt/smolvm", "agent-rootfs"),
    });
  });

  it("runs smolvm.exe on Windows, which finds its DLLs beside itself", () => {
    expect(resolveSmolvmCommand({ dir: "C:\\smolvm" }, "win32")).toEqual({
      file: "C:\\smolvm\\smolvm.exe",
      env: {},
    });
  });

  it("falls back to an explicit binary, then PATH", () => {
    expect(resolveSmolvmCommand({ bin: "/usr/local/bin/smolvm" }).file).toBe(
      "/usr/local/bin/smolvm",
    );
    expect(resolveSmolvmCommand({}).file).toBe("smolvm");
  });
});

describe("SmolvmSandbox", () => {
  it("creates the machine once, then runs commands in the workspace", async () => {
    const { run, calls } = fakeRunner((args) =>
      args[1] === "exec" && args.includes("/bin/sh") ? ok("hello\n") : ok(),
    );
    const sandbox = new SmolvmSandbox(run, "vm", { network: true, cpus: 2, timeoutSeconds: 30 });

    expect(await sandbox.execute("echo hello")).toEqual({
      output: "hello\n",
      exitCode: 0,
      truncated: false,
    });
    await sandbox.execute("true");

    expect(subcommands(calls)).toEqual([
      "machine create",
      "machine start",
      "machine exec",
      "machine exec",
      "machine exec",
    ]);
    expect(calls[0]!.args).toEqual([
      "machine", "create", "--name", "vm", "--net", "--cpus", "2",
    ]);
    expect(calls[1]!.args).toEqual(["machine", "start", "--name", "vm"]);
    expect(calls[1]!.options?.env).toBeUndefined();
    expect(calls[2]!.args.slice(-3)).toEqual(["mkdir", "-p", SANDBOX_WORKSPACE]);
    expect(calls[3]!.args).toEqual([
      "machine", "exec", "--name", "vm", "--timeout", "30s",
      "--workdir", SANDBOX_WORKSPACE, "--", "/bin/sh", "-c", "echo hello",
    ]);
  });

  it("hides host proxies from a machine without network", async () => {
    const { run, calls } = fakeRunner();
    await new SmolvmSandbox(run, "vm").execute("x");
    const start = calls.find((call) => call.args[1] === "start")!;
    expect(start.options?.env).toMatchObject({ HTTPS_PROXY: "", https_proxy: "", ALL_PROXY: "" });
  });

  it("reuses a machine that already exists", async () => {
    const { run } = fakeRunner((args) =>
      args[1] === "create" ? fail("Error: a machine named 'vm' already exists.") : ok("ran"),
    );
    expect((await new SmolvmSandbox(run, "vm").execute("x")).output).toBe("ran");
  });

  it("reports an unavailable hypervisor and retries on the next command", async () => {
    let attempts = 0;
    const { run } = fakeRunner((args) => {
      if (args[1] === "create" && attempts++ === 0) return fail("Error: /dev/kvm: permission denied");
      return ok("ran");
    });
    const sandbox = new SmolvmSandbox(run, "vm");

    expect(await sandbox.execute("x")).toEqual({
      output: "Sandbox unavailable: Error: /dev/kvm: permission denied",
      exitCode: 1,
      truncated: false,
    });
    expect((await sandbox.execute("x")).output).toBe("ran");
  });

  it("reports smolvm's own timeout, which exits 124 silently", async () => {
    const { run } = fakeRunner((args) =>
      args.includes("/bin/sh")
        ? new Promise<CliResult>((resolve) =>
            setTimeout(() => resolve({ ...ok(), exitCode: 124 }), 1100),
          )
        : ok(),
    );
    const result = await new SmolvmSandbox(run, "vm", { timeoutSeconds: 1 }).execute("sleep 9");
    expect(result.output).toBe("\nCommand timed out after 1s.");
    expect(result.exitCode).toBe(124);
  });

  it("leaves a command's own exit 124 alone", async () => {
    const { run } = fakeRunner((args) =>
      args.includes("/bin/sh") ? { ...ok("own"), exitCode: 124 } : ok(),
    );
    expect((await new SmolvmSandbox(run, "vm").execute("exit 124")).output).toBe("own");
  });

  it("restarts a machine that was stopped and retries the command", async () => {
    let stopped = false;
    const { run, calls } = fakeRunner((args) => {
      if (args[1] === "stop") stopped = true;
      if (args[1] === "start") stopped = false;
      if (args[1] === "exec" && stopped) {
        return fail("Error: machine 'vm' is not running. Use 'smolvm machine start --name vm' first.");
      }
      return ok("ran");
    });
    const sandbox = new SmolvmSandbox(run, "vm");
    await sandbox.execute("x");
    stopped = true;

    expect((await sandbox.execute("x")).output).toBe("ran");
    expect(subcommands(calls).filter((call) => call === "machine start")).toHaveLength(2);
  });

  it("reports a machine that cannot be restarted mid-command", async () => {
    let starts = 0;
    const { run } = fakeRunner((args) => {
      if (args[1] === "start" && starts++ > 0) return fail("Error: hypervisor gone");
      if (args.includes("/bin/sh")) return fail("Error: machine 'vm' is not running.");
      return ok();
    });
    expect((await new SmolvmSandbox(run, "vm").execute("x")).output).toBe(
      "Sandbox unavailable: Error: hypervisor gone",
    );
  });

  it("starts again after its own idle stop", async () => {
    const { run, calls } = fakeRunner();
    const sandbox = new SmolvmSandbox(run, "vm");
    await sandbox.execute("x");
    await sandbox.stop();
    await sandbox.execute("x");

    expect(subcommands(calls).filter((call) => call === "machine start")).toHaveLength(2);
  });

  it("reports a command timeout", async () => {
    const { run } = fakeRunner((args) =>
      args.includes("/bin/sh") ? { ...ok("partial"), exitCode: null, timedOut: true } : ok(),
    );
    const result = await new SmolvmSandbox(run, "vm", { timeoutSeconds: 5 }).execute("sleep 9");
    expect(result.output).toBe("partial\nCommand timed out after 5s.");
    expect(result.exitCode).toBeNull();
  });

  it("uploads through relative host paths so Windows drive letters never reach cp", async () => {
    const staged: string[] = [];
    const { run, calls } = fakeRunner((args, options) => {
      if (args[1] === "cp") {
        staged.push(path.join(options!.cwd!, args[2]!));
        return args[3] === "vm:/workspace/dir" ? fail("Error: Is a directory") : ok();
      }
      return ok();
    });
    const sandbox = new SmolvmSandbox(run, "vm");

    const responses = await sandbox.uploadFiles([
      ["/workspace/a/b.txt", new TextEncoder().encode("hi")],
      ["relative.txt", new Uint8Array()],
      ["/workspace/dir", new Uint8Array()],
    ]);

    expect(responses).toEqual([
      { path: "/workspace/a/b.txt", error: null },
      { path: "relative.txt", error: "invalid_path" },
      { path: "/workspace/dir", error: "is_directory" },
    ]);
    const copies = calls.filter((call) => call.args[1] === "cp");
    expect(copies.map((call) => call.args.slice(2))).toEqual([
      ["0", "vm:/workspace/a/b.txt"],
      ["2", "vm:/workspace/dir"],
    ]);
    expect(staged.every((file) => path.isAbsolute(file))).toBe(true);
    expect(calls.find((call) => call.args.includes("/workspace/a"))?.args.slice(-3)).toEqual([
      "-p", "/workspace/a", "/workspace",
    ]);
  });

  it("downloads readable files and classifies the rest", async () => {
    const { run } = fakeRunner((args, options) => {
      if (args.includes("/bin/sh")) return ok("f\nd\nn\np\n");
      if (args[1] === "cp") {
        writeFileSync(path.join(options!.cwd!, args[3]!), "contents");
      }
      return ok();
    });
    const responses = await new SmolvmSandbox(run, "vm").downloadFiles([
      "/workspace/file",
      "/workspace",
      "/missing",
      "relative",
      "/root/secret",
    ]);

    expect(responses.map((response) => response.error)).toEqual([
      null,
      "is_directory",
      "file_not_found",
      "invalid_path",
      "permission_denied",
    ]);
    expect(new TextDecoder().decode(responses[0]!.content!)).toBe("contents");
  });
});

describe("SmolvmSandboxPool", () => {
  it("gives each thread its own machine", () => {
    const pool = new SmolvmSandboxPool({ run: fakeRunner().run });
    expect(pool.forThread("a")).toBe(pool.forThread("a"));
    expect(pool.forThread("a").name).toBe(machineNameForThread("a"));
    expect(pool.forThread("b").name).not.toBe(pool.forThread("a").name);
    expect(machineNameForThread("a")).toMatch(/^pizza-bot-[0-9a-f]{16}$/);
  });

  it("stops an idle machine and deletes a thread's machine", async () => {
    const { run, calls } = fakeRunner();
    const pool = new SmolvmSandboxPool({ run, idleStopMs: 0 });

    await pool.forThread("a").execute("true");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await pool.deleteThread("a");

    const name = machineNameForThread("a");
    expect(calls.map((call) => call.args)).toContainEqual(["machine", "stop", "--name", name]);
    expect(calls.at(-1)!.args).toEqual(["machine", "delete", "--name", name, "--force"]);
  });

  it("needs a run's thread to resolve a machine", async () => {
    const pool = new SmolvmSandboxPool({ run: fakeRunner().run });
    await expect(async () => pool.backend.execute("true")).rejects.toThrow();
  });
});

describe("createSmolvmRunner", () => {
  const node = createSmolvmRunner({ file: process.execPath, env: { PROBE: "set" } });

  it("captures both streams, the exit code and extra environment", async () => {
    const result = await node(
      [
        "-e",
        "process.stdout.write(process.env.PROBE + process.env.CALL); " +
          "process.stderr.write('err'); process.exit(3)",
      ],
      { env: { CALL: "-call" } },
    );
    expect(result).toEqual({
      exitCode: 3,
      stdout: "set-call",
      stderr: "err",
      truncated: false,
      timedOut: false,
    });
  });

  it("kills a process that outlives its timeout", async () => {
    const result = await node(["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
  });

  it("caps captured output", async () => {
    const result = await node(["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it("reports a missing binary instead of throwing", async () => {
    const missing = createSmolvmRunner({ file: "definitely-not-smolvm", env: {} });
    const result = await missing(["--version"]);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/ENOENT/);
  });
});
