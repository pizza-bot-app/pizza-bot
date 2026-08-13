import path from "node:path";

export interface WindowIconPaths {
  platform: NodeJS.Platform;
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}

export function resolveWindowIconPath({
  platform,
  packaged,
  appPath,
  resourcesPath,
}: WindowIconPaths): string | undefined {
  if (platform === "darwin") return undefined;

  const iconName = platform === "win32" ? "icon.ico" : "icon.png";
  const iconsDir = packaged
    ? resourcesPath
    : path.join(appPath, "..", "..", "assets", "icons");
  return path.join(iconsDir, iconName);
}
