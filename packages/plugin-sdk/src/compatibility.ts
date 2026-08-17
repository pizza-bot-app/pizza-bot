import type {
  PluginCapabilityId,
  PluginManifest,
} from "@pizza-bot/plugin-api";
import { satisfies, valid, validRange } from "semver";

export const PLUGIN_HOST_CAPABILITIES = [
  "mcp-servers/v1",
  "skills/v1",
  "materializer/v1",
] as const satisfies readonly PluginCapabilityId[];

export interface PluginHostContract {
  version: string;
  capabilities: ReadonlySet<string>;
}

export interface PluginCompatibility {
  compatible: boolean;
  detail?: string;
}

export function createPluginHostContract(version: string): PluginHostContract {
  if (!valid(version)) {
    throw new Error(`Invalid Pizza Bot host version "${version}"`);
  }
  return {
    version,
    capabilities: new Set(PLUGIN_HOST_CAPABILITIES),
  };
}

export function evaluatePluginCompatibility(
  manifest: PluginManifest,
  host: PluginHostContract,
): PluginCompatibility {
  const range = manifest.engines?.pizzaBot;
  if (range) {
    if (!validRange(range)) {
      return {
        compatible: false,
        detail: `Invalid engines.pizzaBot range "${range}"`,
      };
    }
    if (!satisfies(host.version, range, { includePrerelease: true })) {
      return {
        compatible: false,
        detail: `Requires Pizza Bot ${range}; this host is ${host.version}`,
      };
    }
  }

  const missing = (manifest.capabilities?.required ?? []).filter(
    (capability) => !host.capabilities.has(capability),
  );
  if (missing.length > 0) {
    return {
      compatible: false,
      detail: `Missing required plugin capabilities: ${missing.join(", ")}`,
    };
  }

  return { compatible: true };
}
