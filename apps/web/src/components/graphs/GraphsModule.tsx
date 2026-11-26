import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, History, Network, Waypoints } from "lucide-react";
import type { GraphSpec } from "@pizza-bot/core";
import { graphLayout } from "@/projection";
import type { ApiClient, GraphListing, ThreadInfo } from "@/api-client";
import { ResourceModule } from "../ResourceModule.js";
import { ResourceList } from "../ResourceList.js";
import { ResourceSection, ResourceView } from "../ResourceView.js";
import { L } from "../../lexicon.js";
import { GraphCanvas } from "./GraphCanvas.js";

const RUNS_POLL_MS = 5_000;

const matches = (g: GraphSpec, q: string) =>
  g.name.toLowerCase().includes(q) ||
  g.id.toLowerCase().includes(q) ||
  (g.description ?? "").toLowerCase().includes(q);

export function GraphsModule({
  client,
  listing,
  onOpenRun,
}: {
  client: ApiClient;
  listing: GraphListing;
  onOpenRun: (run: ThreadInfo) => void;
}) {
  const graphs = listing.graphs;
  return (
    <ResourceModule
      items={graphs}
      getId={(g) => g.id}
      icon={<Network size={18} />}
      emptyIcon={<Network size={40} strokeWidth={1} />}
      title={L.graphsSection}
      newLabel=""
      canCreate={false}
      emptyText="Select a graph to see its steps and runs."
      renderHeaderActions={() =>
        listing.invalid.length > 0 ? (
          <span
            className="graph-invalid-badge"
            title={listing.invalid.map((f) => `${f.file}: ${f.errors.join("; ")}`).join("\n")}
          >
            <AlertTriangle size={14} /> {listing.invalid.length} invalid{" "}
            {listing.invalid.length === 1 ? "file" : "files"}
          </span>
        ) : null
      }
      renderList={({ selectedId, onSelect }) => (
        <ResourceList
          items={graphs}
          getId={(g) => g.id}
          selectedId={selectedId}
          onSelect={onSelect}
          matches={matches}
          label={L.graphsSection}
          searchPlaceholder="Search graphs..."
          emptyTitle="No graphs yet"
          emptySub={
            <>
              Add a graph spec with <code>PUT /graphs/&lt;id&gt;</code>, then point a schedule or
              webhook at it.
            </>
          }
          noMatchSub={(q) => `No graphs match “${q}”`}
          renderRow={(g) => (
            <span className="resource-row-main">
              <span className="resource-row-line1">
                <span className="resource-row-name">{g.name}</span>
                <span className="resource-row-badges">
                  <span className="graph-step-count">{g.nodes.length} steps</span>
                </span>
              </span>
              {g.description && <span className="resource-row-desc">{g.description}</span>}
            </span>
          )}
        />
      )}
      renderDetail={({ selected, backToList }) =>
        selected ? (
          <GraphDetail
            key={selected.id}
            client={client}
            graph={selected}
            onOpenRun={onOpenRun}
            {...(backToList ? { onBack: backToList } : {})}
          />
        ) : null
      }
    />
  );
}

function GraphDetail({
  client,
  graph,
  onOpenRun,
  onBack,
}: {
  client: ApiClient;
  graph: GraphSpec;
  onOpenRun: (run: ThreadInfo) => void;
  onBack?: () => void;
}) {
  const layout = useMemo(() => graphLayout(graph), [graph]);
  const [runs, setRuns] = useState<ThreadInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const rows = await client.listGraphRuns(graph.id);
        if (alive) setRuns([...rows].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)));
      } catch {
        if (alive) setRuns((prev) => prev ?? []);
      }
      if (alive) timer = setTimeout(() => void load(), RUNS_POLL_MS);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, graph.id]);

  return (
    <ResourceView
      glyph={<Network size={20} />}
      name={graph.name}
      status={graph.description}
      provenance={<code>{graph.id}</code>}
      backLabel={L.graphsSection}
      {...(onBack ? { onBack } : {})}
    >
      <ResourceSection title="Steps" icon={<Waypoints size={14} />}>
        <div className="graph-preview">
          <GraphCanvas layout={layout} />
        </div>
      </ResourceSection>
      <ResourceSection title="Runs" icon={<History size={14} />}>
        {runs === null ? (
          <p className="graph-runs-empty">Loading runs…</p>
        ) : runs.length === 0 ? (
          <p className="graph-runs-empty">No runs yet. Runs start from a schedule, a webhook, or the API.</p>
        ) : (
          <ul className="graph-runs">
            {runs.map((run) => (
              <li key={run.threadId}>
                <button className="graph-run-row" onClick={() => onOpenRun(run)}>
                  <span className="graph-run-row-when">{formatWhen(run.createdAt)}</span>
                  <span className="graph-run-row-source">{run.source === "trigger" ? "Trigger" : "Manual"}</span>
                  {run.awaitingAction && <span className="graph-run-row-await">Waiting for you</span>}
                  <span className="graph-run-row-id">{run.threadId}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ResourceSection>
    </ResourceView>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
