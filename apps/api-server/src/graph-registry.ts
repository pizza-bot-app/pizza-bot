/** Graph specs stored one JSON file per graph under `<dataRoot>/graphs`. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GRAPH_ID_PATTERN, parseGraphSpec, type GraphSpec } from "@pizza-bot/core";

export interface GraphListing {
  graphs: GraphSpec[];
  /** Files that exist but do not parse, so the UI can say why a graph is missing. */
  invalid: Array<{ file: string; errors: string[] }>;
}

export class GraphRegistry {
  constructor(readonly dir: string) {}

  async list(): Promise<GraphListing> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((file) => file.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { graphs: [], invalid: [] };
      throw error;
    }
    const listing: GraphListing = { graphs: [], invalid: [] };
    for (const file of files) {
      const loaded = await this.load(file);
      if (loaded.ok && loaded.spec.id === file.slice(0, -".json".length)) listing.graphs.push(loaded.spec);
      else listing.invalid.push({ file, errors: loaded.ok ? ["id does not match file name"] : loaded.errors });
    }
    return listing;
  }

  async get(id: string): Promise<GraphSpec | undefined> {
    if (!GRAPH_ID_PATTERN.test(id)) return undefined;
    const loaded = await this.load(`${id}.json`);
    return loaded.ok && loaded.spec.id === id ? loaded.spec : undefined;
  }

  async put(spec: GraphSpec): Promise<void> {
    // The id doubles as the file name; parseGraphSpec already constrained it.
    if (!GRAPH_ID_PATTERN.test(spec.id)) throw new Error(`invalid graph id ${spec.id}`);
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, `${spec.id}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  async delete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await rm(join(this.dir, `${id}.json`), { force: true });
    return true;
  }

  private async load(file: string): Promise<{ ok: true; spec: GraphSpec } | { ok: false; errors: string[] }> {
    let text: string;
    try {
      text = await readFile(join(this.dir, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, errors: ["not found"] };
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return { ok: false, errors: [`invalid JSON: ${(error as Error).message}`] };
    }
    return parseGraphSpec(raw);
  }
}
