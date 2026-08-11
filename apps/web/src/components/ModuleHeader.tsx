import type { ReactNode } from "react";

export interface ModuleHeaderProps {
  icon: ReactNode;
  title: string;
  count?: number;
  children?: ReactNode;
}

export function ModuleHeader({ icon, title, count, children }: ModuleHeaderProps) {
  return (
    <header className="module-header">
      {icon}
      <h1 className="module-title">{title}</h1>
      {count != null && <span className="module-count">{count}</span>}
      {children}
    </header>
  );
}
