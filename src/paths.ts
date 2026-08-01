/**
 * Graph path resolution — locate the nearest knowledge graph by walking
 * up parent directories. Lets sessions opened inside a monorepo sub-project
 * (or any nested folder) resolve to the root-level graph instead of building
 * or querying a per-folder one.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const OUT_DIR = "graph-out";
const GRAPH_FILE = "graph.json";

/**
 * Find the nearest ancestor directory (including `start` itself) that
 * contains a graph at `graph-out/graph.json`. Returns null when none exists.
 */
export function findGraphRoot(start: string): string | null {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, OUT_DIR, GRAPH_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Absolute path to the graph.json inside a project dir. */
export function graphPath(dir: string): string {
  return join(dir, OUT_DIR, GRAPH_FILE);
}
