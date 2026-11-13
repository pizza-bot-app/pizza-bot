/** Builds the optional smolvm shell sandbox from `PIZZA_SANDBOX*` variables. */
import {
  SmolvmSandboxPool,
  createSmolvmRunner,
  resolveSmolvmCommand,
} from "@pizza-bot/runtime-langgraph";

/** Hosts smolvm publishes a build for; it has none for Intel macOS. */
const SMOLVM_PLATFORMS = new Set(["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]);

export function resolveSandboxPool(
  env: NodeJS.ProcessEnv = process.env,
  host = `${process.platform}-${process.arch}`,
  warn: (message: string) => void = (message) => console.warn(`[sandbox] ${message}`),
): SmolvmSandboxPool | undefined {
  const kind = env.PIZZA_SANDBOX?.trim();
  if (!kind || kind === "off") return undefined;
  if (kind !== "smolvm") {
    warn(`unknown PIZZA_SANDBOX "${kind}"; shell execution stays off`);
    return undefined;
  }
  if (!SMOLVM_PLATFORMS.has(host)) {
    warn(`smolvm has no build for ${host}; shell execution stays off`);
    return undefined;
  }
  const network = env.PIZZA_SANDBOX_NETWORK === "1";
  let image = env.PIZZA_SANDBOX_IMAGE?.trim() || undefined;
  if (image && !network) {
    warn("PIZZA_SANDBOX_IMAGE needs PIZZA_SANDBOX_NETWORK=1 to pull; using the bundled rootfs");
    image = undefined;
  }
  const dir = env.PIZZA_SMOLVM_DIR?.trim() || undefined;
  const bin = env.PIZZA_SMOLVM_BIN?.trim() || undefined;
  return new SmolvmSandboxPool({
    run: createSmolvmRunner(resolveSmolvmCommand({
      ...(dir ? { dir } : {}),
      ...(bin ? { bin } : {}),
    })),
    network,
    ...(image ? { image } : {}),
  });
}
