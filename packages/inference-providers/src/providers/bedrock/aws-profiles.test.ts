import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAwsProfiles } from "./aws-profiles.js";

describe("discoverAwsProfiles", () => {
  it("lists profiles from an AWS config file and excludes non-profile sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-profiles-"));
    const configFilepath = join(dir, "config");
    writeFileSync(
      configFilepath,
      [
        "[profile production]",
        "role_arn = arn:aws:iam::123456789012:role/Production",
        "source_profile = default",
        "",
        "[default]",
        "region = us-west-2",
        "",
        "[profile development]",
        "sso_session = company",
        "",
        "[sso-session company]",
        "sso_start_url = https://example.awsapps.com/start",
        "",
        "[services local]",
        "dynamodb = endpoint_url=http://localhost:8000",
      ].join("\n"),
    );

    try {
      await expect(discoverAwsProfiles(configFilepath)).resolves.toEqual([
        "default",
        "development",
        "production",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the config file cannot be read", async () => {
    await expect(discoverAwsProfiles(join(tmpdir(), "does-not-exist", "config"))).resolves.toEqual([]);
  });
});
