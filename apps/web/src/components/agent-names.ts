import { createContext, useContext } from "react";

/** Agent id → display name; unknown ids (or no catalog yet) render as the id. */
export const AgentNamesContext = createContext<ReadonlyMap<string, string>>(new Map());

export function useAgentName(): (id: string) => string {
  const names = useContext(AgentNamesContext);
  return (id) => names.get(id) ?? id;
}
