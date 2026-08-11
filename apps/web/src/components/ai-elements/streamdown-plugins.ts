import { useEffect, useState } from "react";
import type { PluginConfig } from "streamdown";

let cache: PluginConfig | undefined;
let inFlight: Promise<PluginConfig | undefined> | undefined;

/**
 * Loads optional renderers once without putting their large dependency graphs on
 * the initial page path. A failed chunk leaves Streamdown's basic Markdown
 * renderer usable, and a later mount can retry the load.
 */
export function loadStreamdownPlugins(): Promise<PluginConfig | undefined> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;

  inFlight = Promise.all([
    import("@streamdown/cjk"),
    import("@streamdown/code"),
    import("@streamdown/math"),
    import("@streamdown/mermaid"),
  ])
    .then(([cjk, code, math, mermaid]) => {
      cache = {
        cjk: cjk.cjk,
        code: code.code,
        math: math.math,
        mermaid: mermaid.mermaid,
      };
      return cache;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[web] enhanced Markdown renderers failed to load; using basic rendering: ${message}`,
      );
      return undefined;
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

export function useStreamdownPlugins(): PluginConfig | undefined {
  const [plugins, setPlugins] = useState<PluginConfig | undefined>(() => cache);

  useEffect(() => {
    if (cache) return;

    let active = true;
    void loadStreamdownPlugins().then((loaded) => {
      if (active && loaded) setPlugins(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  return plugins;
}
