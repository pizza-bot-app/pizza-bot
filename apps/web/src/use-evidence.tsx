/**
 * The active thread's evidence ledger, shared by the approval card that cites it and
 * the rail that lists it. Read-only: bodies are fetched per id, never posted.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CitedSource, EvidenceEntry } from "@pizza-bot/core";
import type { ApiClient } from "@/api-client";

export interface EvidenceLedger {
  entries: EvidenceEntry[];
  /** Until the list has arrived, a cited id that is absent is unknown, not missing. */
  loaded: boolean;
  /** Only for ids a surface asked about; a citation audit resolves quotes against these. */
  bodies: ReadonlyMap<string, CitedSource>;
  /** Asked-for ids the server would not hand over, so nothing about them was checked. */
  unavailable: ReadonlySet<string>;
  /** Ids some approval card quotes, so the rail can list those entries first. */
  citedIds: ReadonlySet<string>;
  hoveredId: string | null;
  selectedId: string | null;
  /** Declares ids as cited and fetches their bodies for the audit. */
  cite: (ids: readonly string[]) => void;
  loadBodies: (ids: readonly string[]) => void;
  hover: (id: string | null) => void;
  select: (id: string | null) => void;
}

const NO_LEDGER: EvidenceLedger = {
  entries: [],
  loaded: false,
  bodies: new Map(),
  unavailable: new Set(),
  citedIds: new Set(),
  hoveredId: null,
  selectedId: null,
  cite: () => {},
  loadBodies: () => {},
  hover: () => {},
  select: () => {},
};

const EvidenceCtx = createContext<EvidenceLedger>(NO_LEDGER);

/** Outside a provider every surface renders as if nothing had been gathered. */
export function useEvidence(): EvidenceLedger {
  return useContext(EvidenceCtx);
}

export function EvidenceProvider({
  threadId,
  client,
  revision,
  onSelect,
  children,
}: {
  threadId: string | null;
  client: ApiClient;
  /** Any value that changes when the run may have gathered more; triggers a relist. */
  revision?: string;
  onSelect?: (id: string) => void;
  children: ReactNode;
}) {
  const [entries, setEntries] = useState<EvidenceEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [bodies, setBodies] = useState<ReadonlyMap<string, CitedSource>>(new Map());
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(new Set());
  const [citedIds, setCitedIds] = useState<ReadonlySet<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    requested.current = new Set();
    setBodies(new Map());
    setUnavailable(new Set());
    setCitedIds(new Set());
    setHoveredId(null);
    setSelectedId(null);
    setLoaded(false);
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      setEntries([]);
      setLoaded(true);
      return;
    }
    let live = true;
    // A server with no ledger answers 409; that reads the same as having gathered nothing.
    client.listEvidence(threadId).then(
      (list) => {
        if (!live) return;
        setEntries(list);
        setLoaded(true);
      },
      () => {
        if (!live) return;
        setEntries([]);
        setLoaded(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, threadId, revision]);

  const loadBodies = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        if (requested.current.has(id)) continue;
        requested.current.add(id);
        // A body that never arrives must reach a verdict: left un-answered, every span
        // citing it reads as still being checked. The id stays requested either way,
        // because the citing card re-asks on each render and would otherwise spin.
        const unreachable = () =>
          setUnavailable((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        client.getEvidence(id).then((doc) => {
          if (doc)
            setBodies((prev) =>
              new Map(prev).set(id, { text: doc.body, truncated: doc.truncated }),
            );
          else unreachable();
        }, unreachable);
      }
    },
    [client],
  );

  const cite = useCallback(
    (ids: readonly string[]) => {
      setCitedIds((prev) => {
        if (ids.every((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
      loadBodies(ids);
    },
    [loadBodies],
  );

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id) onSelect?.(id);
    },
    [onSelect],
  );

  const value = useMemo<EvidenceLedger>(
    () => ({
      entries,
      loaded,
      bodies,
      unavailable,
      citedIds,
      hoveredId,
      selectedId,
      cite,
      loadBodies,
      hover: setHoveredId,
      select,
    }),
    [
      entries,
      loaded,
      bodies,
      unavailable,
      citedIds,
      hoveredId,
      selectedId,
      cite,
      loadBodies,
      select,
    ],
  );

  return <EvidenceCtx.Provider value={value}>{children}</EvidenceCtx.Provider>;
}
