import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { detect } from "./detect.ts";
import { extract } from "./extract.ts";
import { KnowledgeGraph } from "./graph.ts";

const OUT_DIR = "graph-out";

function graphPath(cwd: string): string {
  return join(cwd, OUT_DIR, "graph.json");
}

function cacheDirPath(cwd: string): string {
  return join(cwd, OUT_DIR, "cache");
}

/**
 * Check staleness using the SHA256 cache directory's mtime.
 * The cache updates whenever a file is re-extracted — so if any
 * cache entry is newer than the graph, the graph is stale.
 * O(1) — just 2 stat calls, no directory walk.
 */
function isStale(cwd: string): boolean {
  const gp = graphPath(cwd);
  if (!existsSync(gp)) return true;

  const cp = cacheDirPath(cwd);
  if (!existsSync(cp)) return true;

  const graphMtime = statSync(gp).mtimeMs;
  const cacheMtime = statSync(cp).mtimeMs;

  return cacheMtime > graphMtime;
}

/**
 * Refresh the graph if stale — silent auto-sync before queries.
 * Uses a single detect() call shared between staleness and refresh.
 */
export async function refreshGraphIfStale(cwd: string): Promise<{ refreshed: boolean; reason?: string }> {
  const gp = graphPath(cwd);
  const exists = existsSync(gp);

  // Single detect call — reused for staleness check AND extraction
  const detected = detect(cwd);
  if (detected.files.length === 0) return { refreshed: false, reason: "no supported files" };

  if (exists && !isStale(cwd)) {
    return { refreshed: false };  // Already fresh
  }

  // No graph or stale — rebuild
  try {
    const cacheDir = cacheDirPath(cwd);
    const extResult = extract(cwd, detected.files, cacheDir, false);

    let kg: KnowledgeGraph;
    if (exists) {
      const existing = JSON.parse(readFileSync(gp, "utf-8"));
      kg = KnowledgeGraph.fromJSON(existing);
      kg.merge(extResult);
    } else {
      kg = KnowledgeGraph.fromExtraction(extResult);
    }

    kg.computeCentrality();
    kg.detectCommunities();

    mkdirSync(join(cwd, OUT_DIR), { recursive: true });
    writeFileSync(gp, JSON.stringify(kg.toJSON(), null, 2), "utf-8");

    const reason = exists ? `incremental (${extResult.extracted} files re-extracted)` : "initial build";
    return { refreshed: true, reason };
  } catch (err) {
    return { refreshed: false, reason: `refresh failed: ${err}` };
  }
}
