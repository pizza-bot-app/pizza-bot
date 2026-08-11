export type AppView =
  | "inbox"
  | "automations"
  | "memories"
  | "skills"
  | "mcp"
  | "plugins"
  | "logs"
  | "settings";

// Each admin dataset polls only while its own rail view is open, so an idle app
// makes no background admin requests.
export function adminVisibility(view: AppView) {
  return {
    skills: view === "skills",
    mcp: view === "mcp",
    memories: view === "memories",
    triggers: view === "automations",
    plugins: view === "plugins",
  };
}
