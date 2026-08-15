export type PluginQualifiedId = `${string}/${string}`;

export function qualifyPluginContributionId(
  pluginName: string,
  localId: string,
): PluginQualifiedId {
  return `${pluginName}/${localId}`;
}
