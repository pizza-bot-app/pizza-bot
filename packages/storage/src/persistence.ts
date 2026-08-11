/** Opens the durable LangGraph checkpointer and cross-thread store. */
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { InMemoryStore } from "@langchain/langgraph";
import { resolveLayout, type DataRootLayout } from "./layout.js";
import { SqliteStore } from "./sqlite-store.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-files.js";

export interface Persistence {
  layout: DataRootLayout;
  checkpointer: SqliteSaver;
  /** Uses `InMemoryStore` only when the root is an in-memory SQLite sentinel. */
  store: SqliteStore | InMemoryStore;
  close(): void;
}

export interface PersistenceOptions {
  root: string;
}

/**
 * `SqliteSaver` initializes its schema lazily during the first read or write, so
 * unopened threads remain queryable as missing.
 */
export async function openPersistence(opts: PersistenceOptions): Promise<Persistence> {
  const layout = resolveLayout(opts.root);
  const isMemory = opts.root === ":memory:" || opts.root.startsWith("file::memory:");

  const connString = isMemory ? ":memory:" : layout.checkpointsDb;
  if (!isMemory) ensurePrivateDirectory(path.dirname(connString));

  const checkpointer = SqliteSaver.fromConnString(connString);
  if (!isMemory) ensurePrivateFile(connString);

  const store: SqliteStore | InMemoryStore = isMemory
    ? new InMemoryStore()
    : new SqliteStore(layout.storeDb);

  return {
    layout,
    checkpointer,
    store,
    close() {
      // SqliteSaver does not expose its better-sqlite3 handle in its public type.
      const db = (checkpointer as unknown as { db?: { close?: () => void } }).db;
      db?.close?.();
      if (store instanceof SqliteStore) store.close();
    },
  };
}
