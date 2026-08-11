/** Shared shortcut catalog for UI dispatch, help, and native menus. */

export type HotkeyScope = "global" | `zone:${string}` | "layer";

export interface HotkeyCategory {
  id: string;
  label: string;
}

export interface HotkeyActionDef {
  id: string;
  label: string;
  category: string;
  defaultChord?: string;
  scope: HotkeyScope;
  /**
   * Menu roles delegate to native Electron behavior; entries without a role
   * dispatch back into the application.
   */
  inMenu?: boolean;
  menuRole?: string;
  hint?: string;
}

export const HOTKEY_CATEGORIES: HotkeyCategory[] = [
  { id: "navigation", label: "Navigation" },
  { id: "conversation", label: "Conversation" },
  { id: "view", label: "View" },
  { id: "help", label: "Help" },
];

export const HOTKEY_CATALOG: HotkeyActionDef[] = [
  {
    id: "app.newChat",
    label: "New conversation",
    category: "conversation",
    defaultChord: "CmdOrCtrl+N",
    scope: "global",
    inMenu: true,
  },
  {
    id: "app.focusSearch",
    label: "Focus list search",
    category: "navigation",
    defaultChord: "CmdOrCtrl+F",
    scope: "global",
    inMenu: true,
  },
  {
    id: "app.openSettings",
    label: "Open Settings",
    category: "navigation",
    defaultChord: "CmdOrCtrl+,",
    scope: "global",
    inMenu: true,
  },
  {
    id: "app.toggleRail",
    label: "Toggle Activity panel",
    category: "view",
    defaultChord: "CmdOrCtrl+B",
    scope: "global",
    inMenu: true,
  },
  {
    id: "app.selectThreadByIndex",
    label: "Switch to conversation 1–9",
    category: "navigation",
    // The engine expands this representative chord to digits 1 through 9.
    defaultChord: "CmdOrCtrl+1",
    scope: "global",
    hint: "Cmd/Ctrl + a digit jumps to that visible conversation",
  },
  {
    id: "app.toggleHelp",
    label: "Keyboard shortcuts",
    category: "help",
    defaultChord: "CmdOrCtrl+/",
    scope: "global",
    inMenu: true,
  },

  {
    id: "list.navDown",
    label: "Next list item",
    category: "navigation",
    defaultChord: "ArrowDown",
    scope: "zone:selectable-list",
  },
  {
    id: "list.navUp",
    label: "Previous list item",
    category: "navigation",
    defaultChord: "ArrowUp",
    scope: "zone:selectable-list",
  },
  {
    id: "list.activate",
    label: "Open selected item",
    category: "navigation",
    defaultChord: "Enter",
    scope: "zone:selectable-list",
  },
  {
    id: "list.deleteConversation",
    label: "Delete conversation",
    category: "conversation",
    defaultChord: "Delete",
    scope: "zone:selectable-list",
    hint: "Delete or Backspace removes the selected conversation (with confirmation)",
  },

  {
    id: "chat.escapeToList",
    label: "Return focus to conversation list",
    category: "navigation",
    defaultChord: "Escape",
    scope: "zone:chat",
  },
];

export function findAction(id: string): HotkeyActionDef | undefined {
  return HOTKEY_CATALOG.find((a) => a.id === id);
}

export function actionsInScope(scope: HotkeyScope): HotkeyActionDef[] {
  return HOTKEY_CATALOG.filter((a) => a.scope === scope);
}
