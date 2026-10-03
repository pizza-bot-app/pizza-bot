/**
 * DeepAgents sandboxes on smolvm microVMs, one persistent VM per thread. Driven
 * through the smolvm CLI rather than its npm SDK, which has no Windows build.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig } from "@langchain/langgraph";
import {
  BaseSandbox,
  type DeleteResult,
  type EditResult,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type SandboxBackendProtocolV2,
  type WriteResult,
} from "deepagents";

/** Guest directory shared by the file tools and `execute`. */
export const SANDBOX_WORKSPACE = "/workspace";

export interface SmolvmCommand {
  file: string;
  env: Record<string, string>;
}

export interface SmolvmLocation {
  /** An unpacked smolvm release directory, as bundled with the desktop app. */
  dir?: string;
  /** A smolvm executable, used when no release directory is given. */
  bin?: string;
}

/**
 * Invokes the release binary directly instead of its bash wrapper, which cannot
 * run on Windows and whose DYLD_LIBRARY_PATH a hardened-runtime macOS signature
 * strips. smolvm dlopens libkrun from SMOLVM_LIB_DIR, and finds its guest rootfs
 * (a directory or `agent-rootfs.tar.gz`) beside its own executable.
 */
export function resolveSmolvmCommand(
  location: SmolvmLocation,
  platform: NodeJS.Platform = process.platform,
): SmolvmCommand {
  const { dir } = location;
  if (!dir) return { file: location.bin ?? "smolvm", env: {} };
  if (platform === "win32") {
    return { file: path.win32.join(dir, "smolvm.exe"), env: {} };
  }
  return {
    file: path.join(dir, "smolvm-bin"),
    env: { SMOLVM_LIB_DIR: path.join(dir, "lib") },
  };
}

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface CliRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export type SmolvmRunner = (
  args: readonly string[],
  options?: CliRunOptions,
) => Promise<CliResult>;

const MAX_STREAM_BYTES = 1024 * 1024;

export function createSmolvmRunner(command: SmolvmCommand): SmolvmRunner {
  return (args, options = {}) =>
    new Promise((resolve) => {
      const child = spawn(command.file, args, {
        cwd: options.cwd,
        env: { ...process.env, ...command.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      let captured = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (sink: Buffer[]) => (chunk: Buffer) => {
        const room = MAX_STREAM_BYTES - captured;
        if (room <= 0) {
          truncated = true;
          return;
        }
        if (chunk.length > room) truncated = true;
        const kept = chunk.subarray(0, room);
        captured += kept.length;
        sink.push(kept);
      };
      child.stdout.on("data", collect(streams.stdout));
      child.stderr.on("data", collect(streams.stderr));
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill();
            }, options.timeoutMs);
      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (timer) clearTimeout(timer);
        resolve({
          exitCode,
          stdout: Buffer.concat(streams.stdout).toString("utf8"),
          stderr:
            Buffer.concat(streams.stderr).toString("utf8") +
            (spawnError ? `${spawnError.message}\n` : ""),
          truncated,
          timedOut,
        });
      };
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
    });
}

export interface SmolvmMachineOptions {
  /** OCI image for the guest; omitted, the VM runs smolvm's bundled Alpine rootfs. */
  image?: string;
  /** Guest egress. Off by default, which also rules out pulling an image. */
  network?: boolean;
  cpus?: number;
  memoryMib?: number;
  /** Per-command guest timeout. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const TIMEOUT_EXIT_CODE = 124;
/** Host-side backstop past the guest timeout, which covers VM boot and teardown. */
const HOST_TIMEOUT_GRACE_MS = 60_000;
/** Creating or starting a machine may first pull its image. */
const BOOT_TIMEOUT_MS = 10 * 60_000;

/**
 * `machine start` adopts the host's proxy variables and refuses to boot when the
 * proxy listens on loopback, even for a machine with no network. smolvm reads an
 * empty variable as unset.
 */
const NO_PROXY_ENV = Object.fromEntries(
  ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].flatMap((name) => [
    [name, ""],
    [name.toLowerCase(), ""],
  ]),
);

function cliFailure(result: CliResult): string {
  return (result.stderr || result.stdout).trim() || `smolvm exited with code ${result.exitCode}`;
}

function uploadError(stderr: string): FileOperationError {
  if (/is a directory/i.test(stderr)) return "is_directory";
  if (/no such file/i.test(stderr)) return "file_not_found";
  return "permission_denied";
}

/** One smolvm machine. Paths are guest-absolute. */
export class SmolvmSandbox extends BaseSandbox {
  readonly id: string;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly run: SmolvmRunner,
    readonly name: string,
    private readonly options: SmolvmMachineOptions = {},
    private readonly track: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
  ) {
    super();
    this.id = name;
  }

  private get timeoutSeconds(): number {
    return this.options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  /**
   * `exec` and `cp` refuse a stopped machine, and `start` is a no-op on a running
   * one, so readiness is create-if-missing then start.
   */
  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      const { image, network, cpus, memoryMib } = this.options;
      const created = await this.run([
        "machine",
        "create",
        "--name",
        this.name,
        ...(image ? ["--image", image] : []),
        ...(network ? ["--net"] : []),
        ...(cpus ? ["--cpus", String(cpus)] : []),
        ...(memoryMib ? ["--mem", String(memoryMib)] : []),
      ], { timeoutMs: BOOT_TIMEOUT_MS });
      if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
        throw new Error(cliFailure(created));
      }
      const started = await this.run(["machine", "start", "--name", this.name], {
        timeoutMs: BOOT_TIMEOUT_MS,
        ...(network ? {} : { env: NO_PROXY_ENV }),
      });
      if (started.exitCode !== 0) throw new Error(cliFailure(started));
      const workspace = await this.run(this.execArgs(["mkdir", "-p", SANDBOX_WORKSPACE]), {
        timeoutMs: this.hostTimeoutMs,
      });
      if (workspace.exitCode !== 0) throw new Error(cliFailure(workspace));
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private get hostTimeoutMs(): number {
    return this.timeoutSeconds * 1000 + HOST_TIMEOUT_GRACE_MS;
  }

  private execArgs(argv: readonly string[], workdir?: string): string[] {
    return [
      "machine",
      "exec",
      "--name",
      this.name,
      "--timeout",
      `${this.timeoutSeconds}s`,
      ...(workdir ? ["--workdir", workdir] : []),
      "--",
      ...argv,
    ];
  }

  /** Restarts a machine that stopped behind this process's back, then retries once. */
  private async live(args: readonly string[], options: CliRunOptions): Promise<CliResult> {
    const result = await this.run(args, options);
    if (result.exitCode === 0 || !/is not running/i.test(result.stderr)) return result;
    this.ready = undefined;
    await this.ensureReady();
    return this.run(args, options);
  }

  private exec(argv: readonly string[], workdir?: string): Promise<CliResult> {
    return this.live(this.execArgs(argv, workdir), { timeoutMs: this.hostTimeoutMs });
  }

  /**
   * `machine cp` splits its operands on the first `:` to find the machine side,
   * so a Windows host path (`C:\...`) would be read as a machine named `C`.
   * Host files are therefore always addressed relative to `cwd`.
   */
  private copy(source: string, destination: string, cwd: string): Promise<CliResult> {
    return this.live(["machine", "cp", source, destination], {
      cwd,
      timeoutMs: this.hostTimeoutMs,
    });
  }

  execute(command: string): Promise<ExecuteResponse> {
    return this.track(async () => {
      let result: CliResult;
      let elapsedMs: number;
      try {
        await this.ensureReady();
        const startedAt = Date.now();
        result = await this.exec(["/bin/sh", "-c", command], SANDBOX_WORKSPACE);
        elapsedMs = Date.now() - startedAt;
      } catch (error) {
        return {
          output: `Sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: 1,
          truncated: false,
        };
      }
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      // smolvm's own --timeout kills the guest command with exit 124 and no
      // message; the elapsed check keeps a command's own 124 from reading as one.
      const timedOut =
        result.timedOut ||
        (result.exitCode === TIMEOUT_EXIT_CODE && elapsedMs >= this.timeoutSeconds * 1000);
      return {
        output: timedOut
          ? `${output}\nCommand timed out after ${this.timeoutSeconds}s.`
          : output,
        exitCode: result.exitCode,
        truncated: result.truncated,
      };
    });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.track(async () => {
      const valid = files.filter(([target]) => path.posix.isAbsolute(target));
      if (valid.length > 0) {
        try {
          await this.ensureReady();
        } catch {
          return files.map(([target]) => ({ path: target, error: "permission_denied" }));
        }
        const parents = [...new Set(valid.map(([target]) => path.posix.dirname(target)))];
        await this.exec(["mkdir", "-p", ...parents]);
      }
      const staging = await mkdtemp(path.join(os.tmpdir(), "pizza-smolvm-"));
      try {
        const responses: FileUploadResponse[] = [];
        for (const [index, [target, content]] of files.entries()) {
          if (!path.posix.isAbsolute(target)) {
            responses.push({ path: target, error: "invalid_path" });
            continue;
          }
          const local = String(index);
          await writeFile(path.join(staging, local), content);
          const copied = await this.copy(local, `${this.name}:${target}`, staging);
          responses.push({
            path: target,
            error: copied.exitCode === 0 ? null : uploadError(copied.stderr),
          });
        }
        return responses;
      } finally {
        await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.track(async () => {
      const failed = (target: string, error: FileOperationError): FileDownloadResponse => ({
        path: target,
        content: null,
        error,
      });
      const valid = paths.filter((target) => path.posix.isAbsolute(target));
      let kinds: string[] = [];
      if (valid.length > 0) {
        try {
          await this.ensureReady();
        } catch {
          return paths.map((target) => failed(target, "permission_denied"));
        }
        const probe = await this.exec([
          "/bin/sh",
          "-c",
          'for p; do if [ -d "$p" ]; then echo d; elif [ -r "$p" ]; then echo f; ' +
            'elif [ -e "$p" ]; then echo p; else echo n; fi; done',
          "sh",
          ...valid,
        ]);
        kinds = probe.stdout.split(/\r?\n/).filter(Boolean);
      }
      const staging = await mkdtemp(path.join(os.tmpdir(), "pizza-smolvm-"));
      try {
        const responses: FileDownloadResponse[] = [];
        let probed = 0;
        for (const [index, target] of paths.entries()) {
          if (!path.posix.isAbsolute(target)) {
            responses.push(failed(target, "invalid_path"));
            continue;
          }
          const kind = kinds[probed++];
          if (kind === "d") responses.push(failed(target, "is_directory"));
          else if (kind === "n") responses.push(failed(target, "file_not_found"));
          else if (kind !== "f") responses.push(failed(target, "permission_denied"));
          else {
            const local = String(index);
            const copied = await this.copy(`${this.name}:${target}`, local, staging);
            responses.push(
              copied.exitCode === 0
                ? {
                    path: target,
                    content: new Uint8Array(await readFile(path.join(staging, local))),
                    error: null,
                  }
                : failed(target, "permission_denied"),
            );
          }
        }
        return responses;
      } finally {
        await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }

  async stop(): Promise<void> {
    this.ready = undefined;
    await this.run(["machine", "stop", "--name", this.name], {
      timeoutMs: HOST_TIMEOUT_GRACE_MS,
    });
  }

  async destroy(): Promise<void> {
    this.ready = undefined;
    await this.run(["machine", "delete", "--name", this.name, "--force"], {
      timeoutMs: HOST_TIMEOUT_GRACE_MS,
    });
  }
}

export interface SmolvmSandboxPoolOptions extends SmolvmMachineOptions {
  run: SmolvmRunner;
  /** Stops a thread's VM after this long without sandbox use; its disk persists. */
  idleStopMs?: number;
}

const DEFAULT_IDLE_STOP_MS = 10 * 60_000;

interface PoolEntry {
  sandbox: SmolvmSandbox;
  active: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** The VM name is a digest so thread ids never need to satisfy smolvm's name rules. */
export function machineNameForThread(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  return `pizza-bot-${digest}`;
}

function currentThreadId(): string {
  const threadId: unknown = getConfig()?.configurable?.thread_id;
  if (typeof threadId !== "string" || threadId === "") {
    throw new Error("The sandbox needs a thread_id in the run config.");
  }
  return threadId;
}

export class SmolvmSandboxPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleStopMs: number;

  /** Resolves the calling run's thread on every call, so one graph serves every thread. */
  readonly backend: SandboxBackendProtocolV2;

  constructor(private readonly options: SmolvmSandboxPoolOptions) {
    this.idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    const current = () => this.forThread(currentThreadId());
    this.backend = {
      id: "smolvm",
      execute: (command: string) => current().execute(command),
      ls: (target: string): Promise<LsResult> => current().ls(target),
      read: (target: string, offset?: number, limit?: number): Promise<ReadResult> =>
        current().read(target, offset, limit),
      readRaw: (target: string): Promise<ReadRawResult> => current().readRaw(target),
      grep: (pattern: string, target?: string, glob?: string | null, maxCount?: number | null): Promise<GrepResult> =>
        current().grep(pattern, target, glob, maxCount),
      glob: (pattern: string, target?: string): Promise<GlobResult> => current().glob(pattern, target),
      write: (target: string, content: string): Promise<WriteResult> => current().write(target, content),
      edit: (target: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> =>
        current().edit(target, oldString, newString, replaceAll),
      delete: (target: string): Promise<DeleteResult> => current().delete(target),
      uploadFiles: (files: Array<[string, Uint8Array]>) => current().uploadFiles(files),
      downloadFiles: (paths: string[]) => current().downloadFiles(paths),
    };
  }

  forThread(threadId: string): SmolvmSandbox {
    const name = machineNameForThread(threadId);
    let entry = this.entries.get(name);
    if (!entry) {
      const fresh: PoolEntry = {
        active: 0,
        sandbox: new SmolvmSandbox(this.options.run, name, this.options, (work) =>
          this.track(fresh, work),
        ),
      };
      this.entries.set(name, fresh);
      entry = fresh;
    }
    return entry.sandbox;
  }

  private async track<T>(entry: PoolEntry, work: () => Promise<T>): Promise<T> {
    clearTimeout(entry.idleTimer);
    entry.active++;
    try {
      return await work();
    } finally {
      if (--entry.active === 0) {
        entry.idleTimer = setTimeout(() => {
          void entry.sandbox.stop().catch(() => {});
        }, this.idleStopMs);
        entry.idleTimer.unref?.();
      }
    }
  }

  /** Deletes the thread's VM and its disk; a no-op when the thread never used one. */
  async deleteThread(threadId: string): Promise<void> {
    const name = machineNameForThread(threadId);
    const entry = this.entries.get(name);
    if (entry) clearTimeout(entry.idleTimer);
    this.entries.delete(name);
    await (entry?.sandbox ?? new SmolvmSandbox(this.options.run, name, this.options)).destroy();
  }

  /** Stops every VM this process started; their disks persist for the next start. */
  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      entries.map((entry) => {
        clearTimeout(entry.idleTimer);
        return entry.sandbox.stop();
      }),
    );
  }
}
