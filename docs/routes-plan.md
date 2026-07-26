# Laravel Route Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Laravel route awareness to the knowledge graph so queries about URL-to-controller mappings, API endpoints, and route groups can be answered from the graph.

**Architecture:** Run `php artisan route:list --json` during graph build, parse the JSON, create route nodes linked to controller method nodes via `references` edges. The route data is regenerated on every graph refresh (full or incremental).

**Tech Stack:** TypeScript, `child_process.execSync`, Laravel Artisan

## Global Constraints

- Route regeneration must not block the build longer than ~5s
- If `artisan` fails (not a Laravel project, PHP not available), skip silently
- Route nodes are linked to existing controller method nodes via label matching
- Routes are re-fetched on every refresh (auto-sync or manual build)

---

### Task 1: Create `src/routes.ts`

**Files:**
- Create: `src/routes.ts`

**Interfaces:**
- Consumes: `root: string` (project root), `nodes: GraphNode[]` (from extracted graph)
- Produces: `RouteExtractionResult` (route nodes + edges to controller methods)

- [ ] **Step 1: Create `src/routes.ts`**

```typescript
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode, GraphEdge } from "./types.ts";
import { nodeId } from "./extract.ts";

export interface RouteExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Extract Laravel routes by running `php artisan route:list --json`.
 * Returns route nodes linked to existing controller method nodes.
 */
export function extractRoutes(root: string, existingNodes: GraphNode[]): RouteExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Only run if this looks like a Laravel project
  if (!existsSync(join(root, "artisan"))) return { nodes, edges };

  let stdout: string;
  try {
    stdout = execSync(`php artisan route:list --json 2>/dev/null`, {
      cwd: root,
      timeout: 15000,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch {
    return { nodes, edges };  // artisan not available, skip
  }

  let routes: Array<{
    method: string;
    uri: string;
    name: string | null;
    action: string;
    middleware: string[];
  }>;

  try {
    routes = JSON.parse(stdout);
  } catch {
    return { nodes, edges };
  }

  // Build an index of existing method nodes for quick lookup
  const methodIndex = new Map<string, GraphNode>();
  for (const n of existingNodes) {
    if (n.type === "method" && n.label.includes(".")) {
      methodIndex.set(n.label, n);
    }
  }

  // Count route by URI pattern for deduplication
  let routeCounter = 0;

  for (const route of routes) {
    // Skip redirect routes, debug routes, etc.
    if (route.method === "HEAD") continue;
    if (route.uri.startsWith("_")) continue;  // Laravel debug routes
    if (route.action === "Closure") continue;  // Closure routes can't be linked

    routeCounter++;
    const routeLabel = `${route.method} /${route.uri}`;
    const routeId = `route_${routeCounter}_${routeLabel.replace(/[^a-zA-Z0-9_]/g, "_")}`;

    nodes.push({
      id: routeId,
      label: routeLabel,
      type: "route",
      sourceFile: "routes",  // virtual source
      sourceLocation: route.name ? `name: ${route.name}` : undefined,
      description: route.middleware.length > 0
        ? `middleware: ${route.middleware.join(", ")}`
        : undefined,
    });

    // Link to controller method if it exists
    if (route.action && route.action !== "Closure") {
      // Parse "App\Http\Controllers\StoreController@show" → "StoreController.show"
      const parts = route.action.split("@");
      if (parts.length === 2) {
        const classFqcn = parts[0];
        const methodName = parts[1];
        // Extract short class name
        const shortClass = classFqcn.includes("\\")
          ? classFqcn.split("\\").pop()!
          : classFqcn;
        const methodLabel = `${shortClass}.${methodName}`;

        // Link to existing method node if found
        if (methodIndex.has(methodLabel)) {
          edges.push({
            source: routeId,
            target: methodIndex.get(methodLabel)!.id,
            relation: "references",
            confidence: "EXTRACTED",
          });
        }

        // Also add edge from route to the virtual controller class
        const controllerNodeId = `route_controller_${shortClass}`;
        if (!nodes.find(n => n.id === controllerNodeId)) {
          nodes.push({
            id: controllerNodeId,
            label: shortClass,
            type: "controller",
            sourceFile: "routes",
          });
        }
        edges.push({
          source: routeId,
          target: controllerNodeId,
          relation: "references",
          confidence: "EXTRACTED",
        });
      }
    }
  }

  return { nodes, edges };
}
```

- [ ] **Step 2: Add `json` to the imports and define `nodeId` since we need it**

Note: `nodeId` is currently defined inside `extract.ts`. We need to export it:

In `src/extract.ts`, find the `nodeId` function and add `export`:

```typescript
function nodeId(file: string, name: string): string {
```

→

```typescript
export function nodeId(file: string, name: string): string {
```

- [ ] **Step 3: Commit**

```bash
git add src/routes.ts src/extract.ts
git commit -m "feat: add Laravel route extraction via artisan route:list"
```

---

### Task 2: Integrate routes into `refreshGraphIfStale()` and `mindplace_build`

**Files:**
- Modify: `src/refresh.ts`
- Modify: `src/tools/mindplace-build.ts`

- [ ] **Step 1: Add route extraction to `refreshGraphIfStale()`**

In `src/refresh.ts`, after the main extraction and before saving, add:

```typescript
import { extractRoutes } from "./routes.ts";

// ...after kg.merge() or kg = KnowledgeGraph.fromExtraction(extResult)...

// Add route nodes from Laravel artisan route:list
const routeResult = extractRoutes(cwd, [...kg.nodes.values()]);
for (const n of routeResult.nodes) {
  if (!kg.nodes.has(n.id)) {
    kg.nodes.set(n.id, { ...n });
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
```

- [ ] **Step 2: Add route extraction to `mindplace_build` tool**

Same change in `src/tools/mindplace-build.ts` — after building/merging the graph and before computing centrality, call `extractRoutes()` and merge the route nodes/edges.

- [ ] **Step 3: Verify no duplicate route nodes on incremental builds**

Routes are identified by unique IDs (`route_1_GET_api_stores`). On incremental rebuilds, the same routes are re-created with the same IDs. The `fromJSON` → `merge` path handles deduplication at the node level (ID-based).

- [ ] **Step 4: Commit**

```bash
git add src/refresh.ts src/tools/mindplace-build.ts
git commit -m "feat: integrate Laravel route extraction into build and auto-sync"
```

---

### Task 3: Push and install

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Test**

```bash
cd D:/laragon/www/mynews/mynews-order-monitoring-backend
# Build with route support
pi -p "mindplace_build force=true noViz=true"
# Then query
pi -p "mindplace_query question='What API routes exist?' budget=3000"
```
