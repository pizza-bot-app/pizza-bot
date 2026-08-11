import type { ReactNode } from "react";
import { ZONE_ATTR } from "./engine.js";

export interface HotkeyZoneProps {
  id: string;
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "main" | "aside" | "nav";
  render?: (attrs: Record<string, string>) => ReactNode;
}

export function HotkeyZone({ id, children, className, as = "div", render }: HotkeyZoneProps) {
  const attrs = { [ZONE_ATTR]: id };
  if (render) return <>{render(attrs)}</>;
  const Tag = as;
  return (
    <Tag className={className} {...attrs}>
      {children}
    </Tag>
  );
}
