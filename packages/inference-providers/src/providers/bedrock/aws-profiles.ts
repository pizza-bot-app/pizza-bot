import { loadSharedConfigFiles } from "@smithy/core/config";

const NON_PROFILE_PREFIXES = ["sso-session.", "services."] as const;

/**
 * Discover named profiles from the AWS shared config file. The AWS SDK resolves
 * the platform-specific home directory and honors AWS_CONFIG_FILE.
 */
export async function discoverAwsProfiles(configFilepath?: string): Promise<string[]> {
  try {
    const { configFile } = await loadSharedConfigFiles({
      ...(configFilepath ? { configFilepath } : {}),
      ignoreCache: true,
    });
    return Object.keys(configFile)
      .filter((name) => !NON_PROFILE_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .sort((a, b) => {
        if (a === "default") return -1;
        if (b === "default") return 1;
        return a.localeCompare(b);
      });
  } catch {
    return [];
  }
}
