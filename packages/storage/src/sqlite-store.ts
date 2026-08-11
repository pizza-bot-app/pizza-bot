/** Durable non-semantic LangGraph store with `InMemoryStore` behavior. */
import Database from "better-sqlite3";
import {
  BaseStore,
  type Operation,
  type OperationResults,
  type Item,
  type SearchItem,
  type GetOperation,
  type SearchOperation,
  type PutOperation,
  type ListNamespacesOperation,
  type MatchCondition,
} from "@langchain/langgraph-checkpoint";
import path from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-files.js";

interface Row {
  /** JSON array; delimiters are unsafe because namespace segments are arbitrary. */
  ns: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export class SqliteStore extends BaseStore {
  private readonly db: Database.Database;

  constructor(connString: string) {
    super();
    ensurePrivateDirectory(path.dirname(connString));
    this.db = new Database(connString);
    ensurePrivateFile(connString);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store (
        ns          TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (ns, key)
      );
    `);
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const op of operations) {
      if (isGet(op)) {
        results.push(this.getOne(op.namespace, op.key));
      } else if (isSearch(op)) {
        results.push(this.searchOp(op));
      } else if (isPut(op)) {
        this.putOp(op);
        results.push(undefined);
      } else if (isListNamespaces(op)) {
        results.push(this.listNamespacesOp(op));
      } else {
        results.push(null);
      }
    }
    return results as OperationResults<Op>;
  }

  close(): void {
    this.db.close();
  }

  private getOne(namespace: string[], key: string): Item | null {
    const row = this.db
      .prepare<[string, string], Row>("SELECT * FROM store WHERE ns = ? AND key = ?")
      .get(JSON.stringify(namespace), key);
    return row ? rowToItem(row) : null;
  }

  private putOp(op: PutOperation): void {
    const ns = JSON.stringify(op.namespace);
    if (op.value === null) {
      this.db.prepare("DELETE FROM store WHERE ns = ? AND key = ?").run(ns, op.key);
      return;
    }
    const now = new Date().toISOString();
    const value = JSON.stringify(op.value);
    // Preserve the original creation timestamp during upserts.
    this.db
      .prepare(
        `INSERT INTO store (ns, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(ns, op.key, value, now, now);
  }

  private searchOp(op: SearchOperation): SearchItem[] {
    if (op.query) {
      throw new Error(
        "SqliteStore does not support semantic search (`query`). It is a plain " +
          "key-value store; use metadata `filter` instead, or provide a " +
          "vector-index-backed store for similarity search.",
      );
    }
    const prefix = op.namespacePrefix ?? [];

    // JSON namespace encoding requires structural prefix comparison in JavaScript.
    const rows = this.db.prepare<[], Row>("SELECT * FROM store").all();
    let items: Item[] = rows.map(rowToItem).filter((it: Item) => hasPrefix(it.namespace, prefix));
    if (op.filter) {
      const filter = op.filter;
      items = items.filter((it: Item) =>
        Object.entries(filter).every(([k, v]) => compareValues(it.value[k], v)),
      );
    }
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;
    // Match InMemoryStore by omitting a relevance score for non-semantic search.
    return items.slice(offset, offset + limit) as SearchItem[];
  }

  private listNamespacesOp(op: ListNamespacesOperation): string[][] {
    const rows = this.db.prepare<[], { ns: string }>("SELECT DISTINCT ns FROM store").all();
    let namespaces: string[][] = rows.map((r: { ns: string }) => JSON.parse(r.ns) as string[]);

    const conds = op.matchConditions ?? [];
    if (conds.length > 0) {
      namespaces = namespaces.filter((ns: string[]) => conds.every((c) => matchesCondition(c, ns)));
    }
    if (op.maxDepth !== undefined) {
      const seen = new Set<string>();
      namespaces = namespaces
        .map((ns: string[]) => ns.slice(0, op.maxDepth))
        .filter((ns: string[]) => {
          const k = JSON.stringify(ns);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
    }
    namespaces.sort((a: string[], b: string[]) => a.join(":").localeCompare(b.join(":")));
    const offset = op.offset ?? 0;
    const limit = op.limit ?? namespaces.length;
    return namespaces.slice(offset, offset + limit);
  }
}

function rowToItem(row: Row): Item {
  return {
    value: JSON.parse(row.value) as Record<string, unknown>,
    key: row.key,
    namespace: JSON.parse(row.ns) as string[],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function hasPrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((p, i) => namespace[i] === p);
}

function matchesCondition(cond: MatchCondition, key: string[]): boolean {
  const { matchType, path } = cond;
  if (matchType === "prefix") {
    if (path.length > key.length) return false;
    return path.every((p, i) => p === "*" || key[i] === p);
  }
  if (matchType === "suffix") {
    if (path.length > key.length) return false;
    return path.every((p, i) => p === "*" || key[key.length - path.length + i] === p);
  }
  throw new Error(`Unsupported match type: ${matchType}`);
}

function compareValues(itemValue: unknown, filterValue: unknown): boolean {
  if (isFilterOperators(filterValue)) {
    return Object.keys(filterValue)
      .filter((k) => k.startsWith("$"))
      .every((op) => {
        const value = (filterValue as Record<string, unknown>)[op];
        switch (op) {
          case "$eq":
            return itemValue === value;
          case "$ne":
            return itemValue !== value;
          case "$gt":
            return Number(itemValue) > Number(value);
          case "$gte":
            return Number(itemValue) >= Number(value);
          case "$lt":
            return Number(itemValue) < Number(value);
          case "$lte":
            return Number(itemValue) <= Number(value);
          case "$in":
            return Array.isArray(value) ? value.includes(itemValue) : false;
          case "$nin":
            return Array.isArray(value) ? !value.includes(itemValue) : true;
          default:
            return false;
        }
      });
  }
  return itemValue === filterValue;
}

function isFilterOperators(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).some((k) => k.startsWith("$"))
  );
}

function isGet(op: Operation): op is GetOperation {
  return "key" in op && "namespace" in op && !("value" in op);
}
function isPut(op: Operation): op is PutOperation {
  return "value" in op && "namespace" in op;
}
function isSearch(op: Operation): op is SearchOperation {
  return "namespacePrefix" in op;
}
function isListNamespaces(op: Operation): op is ListNamespacesOperation {
  return "matchConditions" in op || (!("key" in op) && !("namespacePrefix" in op) && !("value" in op));
}
