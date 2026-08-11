/** Registries for validated plugin contributions. */
import type { PluginManifest, McpServerEntry } from "./manifest.js";

export interface PluginContribution<T> {
  qualifiedId: string;
  pluginName: string;
  root: string;
  value: T;
}

export type ContributionKind = "skill" | "MCP server";

export class PluginContributionCollisionError extends Error {
  constructor(
    readonly kind: ContributionKind | "plugin",
    readonly id: string,
    readonly existingPlugin: string,
    readonly incomingPlugin: string,
  ) {
    super(
      kind === "plugin"
        ? `Plugin "${id}" is already registered`
        : `${capitalize(kind)} "${id}" from plugin "${incomingPlugin}" conflicts with plugin "${existingPlugin}"`,
    );
    this.name = "PluginContributionCollisionError";
  }
}

export function qualifyContributionId(pluginName: string, localId: string): string {
  return `${pluginName}/${localId}`;
}

export class ContributionRegistry {
  readonly skills = new Map<string, PluginContribution<string>>();
  readonly mcpServers = new Map<string, PluginContribution<McpServerEntry>>();
  private readonly pluginNames = new Set<string>();

  registerPlugin(pluginName: string): void {
    if (this.pluginNames.has(pluginName)) {
      throw new PluginContributionCollisionError(
        "plugin",
        pluginName,
        pluginName,
        pluginName,
      );
    }
    this.pluginNames.add(pluginName);
  }

  registerSkill(pluginName: string, root: string, id: string, path: string): void {
    this.registerUnique(this.skills, "skill", pluginName, root, id, path);
  }

  registerMcpServer(
    pluginName: string,
    root: string,
    id: string,
    entry: McpServerEntry,
  ): void {
    this.registerUnique(this.mcpServers, "MCP server", pluginName, root, id, entry);
  }

  /**
   * Preflights every collision before committing, preserving the destination
   * registry if any contribution in the plugin conflicts.
   */
  mergeFrom(incoming: ContributionRegistry): void {
    for (const pluginName of incoming.pluginNames) {
      if (this.pluginNames.has(pluginName)) {
        throw new PluginContributionCollisionError(
          "plugin",
          pluginName,
          pluginName,
          pluginName,
        );
      }
    }
    this.assertMapsDoNotCollide(incoming);

    for (const pluginName of incoming.pluginNames) this.pluginNames.add(pluginName);
    mergeMap(this.skills, incoming.skills);
    mergeMap(this.mcpServers, incoming.mcpServers);
  }

  private registerUnique<T>(
    registry: Map<string, PluginContribution<T>>,
    kind: ContributionKind,
    pluginName: string,
    root: string,
    id: string,
    value: T,
  ): void {
    const existing = registry.get(id);
    if (existing) {
      throw new PluginContributionCollisionError(
        kind,
        id,
        existing.pluginName,
        pluginName,
      );
    }
    registry.set(id, {
      qualifiedId: qualifyContributionId(pluginName, id),
      pluginName,
      root,
      value,
    });
  }

  private assertMapsDoNotCollide(incoming: ContributionRegistry): void {
    const pairs: Array<
      [
        ContributionKind,
        Map<string, PluginContribution<unknown>>,
        Map<string, PluginContribution<unknown>>,
      ]
    > = [
      ["skill", this.skills, incoming.skills],
      ["MCP server", this.mcpServers, incoming.mcpServers],
    ];
    for (const [kind, current, next] of pairs) {
      for (const [id, contribution] of next) {
        const existing = current.get(id);
        if (existing) {
          throw new PluginContributionCollisionError(
            kind,
            id,
            existing.pluginName,
            contribution.pluginName,
          );
        }
      }
    }
  }
}

function mergeMap<T>(
  into: Map<string, PluginContribution<T>>,
  incoming: Map<string, PluginContribution<T>>,
): void {
  for (const [id, contribution] of incoming) into.set(id, contribution);
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

export interface PluginLoader {
  load(manifest: PluginManifest, root: string, into: ContributionRegistry): Promise<void>;
}
