/** Browser-safe schemas for Pizza Bot's declarative plugin contract. */
import { z } from "zod";

export const PLUGIN_API_VERSION = "pizza-bot/v1" as const;

export const pluginNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case name");

export const pluginCapabilityIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*\/v[1-9]\d*$/,
    "capability id such as skills/v1",
  );
export type PluginCapabilityId = z.infer<typeof pluginCapabilityIdSchema>;

export const pluginCapabilitiesSchema = z.object({
  required: z.array(pluginCapabilityIdSchema).default([]),
  optional: z.array(pluginCapabilityIdSchema).default([]),
});
export type PluginCapabilities = z.infer<typeof pluginCapabilitiesSchema>;

export const pluginEnginesSchema = z.object({
  pizzaBot: z.string().min(1),
});
export type PluginEngines = z.infer<typeof pluginEnginesSchema>;

export const pluginLoadStatusSchema = z.enum([
  "loaded",
  "disabled",
  "incompatible",
  "failed",
]);
export type PluginLoadStatus = z.infer<typeof pluginLoadStatusSchema>;

/** MCP server entry: stdio, streamable HTTP, or legacy SSE. */
export const mcpServerEntrySchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]).default("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  }),
]);
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

export const authorSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  url: z.string().optional(),
});

export const pluginMaterializerReasonSchema = z.enum([
  "install",
  "startup",
  "manual",
]);
export type PluginMaterializerReason = z.infer<
  typeof pluginMaterializerReasonSchema
>;

export const pluginMaterializerSchema = z.object({
  entrypoint: z.string().min(1),
  sourceRoots: z.array(z.string().min(1)).default([]),
  sync: z
    .array(pluginMaterializerReasonSchema)
    .min(1)
    .default(["install", "startup", "manual"]),
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
});
export type PluginMaterializer = z.infer<typeof pluginMaterializerSchema>;

const pluginExtensionsSchema = z
  .object({
    "dev.pizzabot.materializer": pluginMaterializerSchema.optional(),
  })
  .passthrough();

export const pluginManifestHeaderSchema = z
  .object({
    apiVersion: z.string().default(PLUGIN_API_VERSION),
    name: z.string().optional(),
  })
  .passthrough();

export const pluginManifestSchema = z.object({
  // Stock and pre-versioned manifests are interpreted as v1.
  apiVersion: z.literal(PLUGIN_API_VERSION).default(PLUGIN_API_VERSION),
  name: pluginNameSchema,
  // Plugin release version; this does not select the manifest API contract.
  version: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  engines: pluginEnginesSchema.optional(),
  capabilities: pluginCapabilitiesSchema.optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  mcpServers: z
    .union([z.string(), z.record(z.string(), mcpServerEntrySchema)])
    .optional(),
  extensions: pluginExtensionsSchema.optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
