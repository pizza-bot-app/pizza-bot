import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppToastProvider } from "./components/AppToast.js";
import { HotkeyProvider } from "./hotkeys/index.js";
import { resolveApiBase, resolveApiHeaders } from "./api-config.js";
import { installBrowserLogging } from "./browser-logger.js";
import "./index.css";
import "./styles.css";

installBrowserLogging(resolveApiBase(), resolveApiHeaders());

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");
createRoot(el).render(
  <React.StrictMode>
    <HotkeyProvider>
      <AppToastProvider>
        <App />
      </AppToastProvider>
    </HotkeyProvider>
  </React.StrictMode>,
);
