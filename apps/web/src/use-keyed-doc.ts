import { useEffect, useRef, useState } from "react";

interface KeyedDocValue<D> {
  key: string;
  reloadToken: unknown;
  doc: D | null;
}

// Cached documents keep repeat selection changes stable while each visit
// revalidates against the server.
export function useKeyedDoc<D>(
  key: string | null,
  fetcher: (key: string) => Promise<D | undefined>,
  reloadToken?: unknown,
): D | null {
  const cache = useRef(new Map<string, KeyedDocValue<D>>());
  const [resolved, setResolved] = useState<KeyedDocValue<D> | null>(null);
  const cached = key === null ? undefined : cache.current.get(key);
  const doc =
    resolved?.key === key && Object.is(resolved.reloadToken, reloadToken)
      ? resolved.doc
      : cached && Object.is(cached.reloadToken, reloadToken)
        ? cached.doc
        : null;

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void fetcher(key).then((d) => {
      if (!alive) return;
      const next = { key, reloadToken, doc: d ?? null };
      if (d) cache.current.set(key, next);
      else cache.current.delete(key);
      setResolved(next);
    });
    return () => {
      alive = false;
    };
  }, [key, fetcher, reloadToken]);
  return doc;
}
