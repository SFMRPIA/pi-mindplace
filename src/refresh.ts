import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { detect } from "./detect.ts";
import type { DetectResult } from "./types.ts";
import { extract } from "./extract.ts";
import { KnowledgeGraph } from "./graph.ts";
import { extractRoutes } from "./routes.ts";
import { buildSearchIndex } from "./search.ts";

const OUT_DIR = "graph-out";
const MAX_STALE_CHECK_FILES = 100;

function graphPath(cwd: string): string {
  return join(cwd, OUT_DIR, "graph.json");
}

/**
 * Check staleness by comparing source file mtimes against graph mtime.
 * Reuses the already-computed detect() result to avoid a second directory walk.
 * Checks up to 100 files, prioritizing the most recently modified.
 */
function isStale(cwd: string, detected: DetectResult): boolean {
  const gp = graphPath(cwd);
  if (!existsSync(gp)) return true;

  const graphMtime = statSync(gp).mtimeMs;

  // Sort by newest first — the most likely to have changed
  // Limit to MAX_STALE_CHECK_FILES to keep it fast
  let checked = 0;
  const files = detected.files
    .map(f => ({ file: f, mtime: fsStatMtime(join(cwd, f)) }))
    .filter((f): f is { file: string; mtime: number } => f.mtime !== -1)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_STALE_CHECK_FILES);

  for (const { mtime } of files) {
    if (mtime > graphMtime) return true;
    checked++;
  }

  return false;
}

/** Safe stat that returns -1 on error */
function fsStatMtime(absPath: string): number {
  try {
    return statSync(absPath).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Refresh the graph if stale — silent auto-sync before queries.
 * Uses a single detect() call shared between staleness check and extraction.
 */
export async function refreshGraphIfStale(cwd: string): Promise<{ refreshed: boolean; reason?: string }> {
  const gp = graphPath(cwd);
  const exists = existsSync(gp);

  // Single detect call — reused for staleness check AND extraction
  const detected = detect(cwd);
  if (detected.files.length === 0) return { refreshed: false, reason: "no supported files" };

  try {
    let kg: KnowledgeGraph;
    let reason: string;

    if (exists && !isStale(cwd, detected)) {
      // Graph is fresh — load it and only update routes
      const existing = JSON.parse(readFileSync(gp, "utf-8"));
      kg = KnowledgeGraph.fromJSON(existing);
      reason = "routes only";
    } else {
      // No graph or stale — rebuild from files
      const cacheDir = join(cwd, OUT_DIR, "cache");
      const extResult = extract(cwd, detected.files, cacheDir, false);

      if (exists) {
        const existing = JSON.parse(readFileSync(gp, "utf-8"));
        kg = KnowledgeGraph.fromJSON(existing);
        kg.merge(extResult);
      } else {
        kg = KnowledgeGraph.fromExtraction(extResult);
      }

      reason = exists
        ? `incremental (${extResult.extracted} files re-extracted)`
        : "initial build";
    }

    // Build FTS5 search index
    buildSearchIndex(cwd, kg);

    // Always refresh routes — they can change without source file changes
    const routeResult = extractRoutes(cwd, [...kg.nodes.values()]);
    for (const n of routeResult.nodes) {
      if (!kg.nodes.has(n.id)) {
        kg.nodes.set(n.id, { ...n, centrality: 0 });
        kg.adjacency.set(n.id, new Set());
      }
    }
    for (const e of routeResult.edges) {
      if (kg.nodes.has(e.source) && kg.nodes.has(e.target)) {
        kg.edges.push({ ...e });
        kg.adjacency.get(e.source)?.add(e.target);
        kg.adjacency.get(e.target)?.add(e.source);
        const out = kg.outgoing.get(e.source) ?? new Set();
        out.add(e.target);
        kg.outgoing.set(e.source, out);
      }
    }

    kg.computeCentrality();
    kg.detectCommunities();

    mkdirSync(join(cwd, OUT_DIR), { recursive: true });
    writeFileSync(gp, JSON.stringify(kg.toJSON(), null, 2), "utf-8");

    return { refreshed: true, reason };
  } catch (err) {
    return { refreshed: false, reason: `refresh failed: ${err}` };
  }
}

