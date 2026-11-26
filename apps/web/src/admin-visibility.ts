export type AppView =
  | "inbox"
  | "automations"
  | "graphs"
  | "memories"
  | "agents"
  | "skills"
  | "mcp"
  | "plugins"
  | "logs"
  | "settings";

// Each admin dataset polls only while its own rail view is open, so an idle app
// makes no background admin requests.
export function adminVisibility(view: AppView) {
  return {
    agents: view === "agents",
    skills: view === "skills",
    mcp: view === "mcp",
    memories: view === "memories",
    triggers: view === "automations",
    graphs: view === "graphs",
    plugins: view === "plugins",
  };
}
