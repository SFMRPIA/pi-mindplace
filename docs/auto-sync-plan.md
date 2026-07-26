# Auto-Sync Knowledge Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically refresh the mindplace knowledge graph before every query or explain call so the agent never sees stale data and never needs to manually rebuild.

**Architecture:** Extract the graph-refresh logic into a shared `refreshGraphIfStale()` function in `index.ts`, called at the start of `mindplace_query` and `mindplace_explain`. The function checks staleness via `file mtime > graph mtime`, runs an incremental rebuild if needed (SHA256 cache skips unchanged files), and silently returns. If the rebuild fails, fall back to the existing graph.

**Tech Stack:** TypeScript, Node.js `fs`, existing `detect`/`extract`/`KnowledgeGraph` modules

## Global Constraints

- The build must never block the query longer than ~2s (full build) or ~600ms (incremental)
- If refresh fails, fall back to existing graph silently — never return an error to the user
- The staleness check uses the existing `checkStaleness()` function
- Incremental rebuild uses the existing `extract()` SHA256 caching
- Graph is saved to `graph-out/graph.json`

---

### Task 1: Create `src/refresh.ts` with `refreshGraphIfStale()`

**Files:**
- Create: `src/refresh.ts`

**Interfaces:**
- Consumes: `detect(root)`, `extract(root, files, cacheDir, force, onProgress)`, `KnowledgeGraph.fromJSON()`, `kg.merge()`, `kg.computeCentrality()`, `kg.detectCommunities()`, `kg.toJSON()`
- Produces: `refreshGraphIfStale(cwd: string): { refreshed: boolean; reason?: string }`

- [ ] **Step 1: Create `src/refresh.ts` with the function**

New file `src/refresh.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { detect } from "./detect.ts";
import { extract } from "./extract.ts";
import { KnowledgeGraph } from "./graph.ts";

const OUT_DIR = "graph-out";
const CACHE_DIR = join(OUT_DIR, "cache");

function graphPath(cwd: string): string {
  return join(cwd, OUT_DIR, "graph.json");
}

function cacheDirPath(cwd: string): string {
  return join(cwd, CACHE_DIR);
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

  // Cache dir was updated AFTER graph was built → something changed
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
```
```

Note: The existing imports already cover `existsSync`, `statSync`, `readFileSync`, `join`. Need to also add `writeFileSync` and `mkdirSync` to the import from `node:fs`.

- [ ] **Step 2: Remove `checkStaleness` from `index.ts`**

Since `checkStaleness()` moved to `src/refresh.ts`, remove it from `index.ts` (lines ~37-51). The `before_agent_start` hook that references it will be updated in Task 4.

- [ ] **Step 3: Verify the function compiles**

Run: `cd D:/laragon/www/pi-mindplace && npx tsc --noEmit 2>&1 | head -20`
Expected: No TypeScript errors (or minor warnings)

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: add refreshGraphIfStale() for auto-sync support"
```

---

### Task 2: Wire `refreshGraphIfStale()` into `mindplace_query`

**Files:**
- Modify: `src/tools/mindplace-query.ts`

**Interfaces:**
- Consumes: `refreshGraphIfStale(cwd)` from `index.ts`
- Produces: stale graph auto-refreshed before query

- [ ] **Step 1: Import and call `refreshGraphIfStale` at the start of `execute()`**

Add at the top of the `execute` method, before the graph existence check:

```typescript
import { refreshGraphIfStale } from "../refresh.ts";

// ...inside execute(), before graph existence check:
await refreshGraphIfStale(ctx.cwd);
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/mindplace-query.ts
git commit -m "feat: auto-sync graph before mindplace_query"
```

---

### Task 3: Wire `refreshGraphIfStale()` into `mindplace_explain`

**Files:**
- Modify: `src/tools/mindplace-explain.ts`

- [ ] **Step 1: Same change as Task 2, in the explain tool**

Add import and call at the start of `execute()`:
```typescript
import { refreshGraphIfStale } from "../refresh.ts";

// ...inside execute():
await refreshGraphIfStale(ctx.cwd);
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/mindplace-explain.ts
git commit -m "feat: auto-sync graph before mindplace_explain"
```

---

### Task 4: Clean up `index.ts` — remove `checkStaleness` and stale warning

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Remove `checkStaleness()` function and stale warning**

The `checkStaleness()` function moved to `src/refresh.ts`. Remove it from `index.ts` (lines ~37-51). Also remove the `STALE_GRAPH_INSTRUCTIONS` constant.

Update `before_agent_start` to no longer call `checkStaleness`:

Replace:
```typescript
  if (existsSync(gp)) {
    const { stale } = checkStaleness(ctx.cwd);
    const fileMap = buildFileContext(ctx.cwd);
    let prompt = GRAPH_FIRST_INSTRUCTIONS;
    if (stale) {
      prompt += STALE_GRAPH_INSTRUCTIONS;
    }
```
With:
```typescript
  if (existsSync(gp)) {
    const fileMap = buildFileContext(ctx.cwd);
    let prompt = GRAPH_FIRST_INSTRUCTIONS;
```

- [ ] **Step 2: Commit**

```bash
git add index.ts
git commit -m "chore: remove checkStaleness and stale warning (moved to src/refresh.ts)"
```

---

### Task 5: Push to origin

- [ ] **Step 1: Push all commits**

```bash
git push origin main
```
