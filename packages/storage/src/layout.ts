/** Canonical paths under the application data root. */
import path from "node:path";

export interface DataRootLayout {
  root: string;
  pluginsDir: string;
  pluginMaterializationsDir: string;
  skillsDir: string;
  memoriesDir: string;
  mcpConfig: string;
  checkpointsDb: string;
  storeDb: string;
  appDb: string;
  attachmentsDir: string;
  logsDir: string;
}

export function resolveLayout(root: string): DataRootLayout {
  return {
    root,
    pluginsDir: path.join(root, "plugins"),
    pluginMaterializationsDir: path.join(root, "plugin-materializations"),
    skillsDir: path.join(root, "skills"),
    memoriesDir: path.join(root, "memories"),
    mcpConfig: path.join(root, ".mcp.json"),
    checkpointsDb: path.join(root, "checkpoints.sqlite"),
    storeDb: path.join(root, "store.sqlite"),
    appDb: path.join(root, "app.sqlite"),
    attachmentsDir: path.join(root, "attachments"),
    logsDir: path.join(root, "logs"),
  };
}
