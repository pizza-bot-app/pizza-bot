import type { SkillSiblingFile } from "@/api-client";

export function prepareSkillFiles(files: readonly SkillSiblingFile[]): SkillSiblingFile[] {
  return files.map((file) => ({ ...file, path: file.path.trim() })).filter((file) => file.path);
}
