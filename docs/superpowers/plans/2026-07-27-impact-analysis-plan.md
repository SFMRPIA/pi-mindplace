# Impact Analysis Tool Implementation Plan

> `mindplace_impact <symbol>` — answer "what breaks if I change this?"

**Goal:** Given a symbol name, traverse the graph outward and show all dependents with depth levels.

**Architecture:** BFS traversal from the target node using `KnowledgeGraph.outgoing` and `KnowledgeGraph.adjacency`. Output shown as a depth-indented tree.

**Tech Stack:** TypeScript, existing KnowledgeGraph, no new dependencies.

## File Structure

- **Create:** `src/tools/mindplace-impact.ts` — the Pi tool
- **Register:** `index.ts` — add import + `pi.registerTool()`

---

### Task 1: Build the BFS traversal core

**File:** `src/tools/mindplace-impact.ts`

**Algorithm:**

```
1. Find the target node by label (user provides symbol name)
2. BFS outward following "calls" edges
3. Track depth, avoid cycles via visited set
4. Build tree structure: { symbol, depth, children: [...] }
```

**Guard clauses:**
- No graph exists → return error "No graph found. Run mindplace_build first."
- Symbol not found in graph nodes → return "Symbol not found in the graph."
- Symbol found but no outgoing edges → return "No dependents found for [symbol]."
- Depth > 5 → cap at 5, append "..." for truncated levels
- Self-referencing cycles → visited set prevents infinite loops
- Too many results (>100) → truncate with "+N more"

**Steps:**

- [ ] **Step 1: Write the BFS function**

```typescript
function buildDependencyTree(
  kg: KnowledgeGraph,
  startNodeId: string,
  maxDepth: number = 3,
  maxResults: number = 50,
): DependencyNode {
  const root: DependencyNode = {
    nodeId: startNodeId,
    label: kg.nodes.get(startNodeId)?.label ?? "?",
    type: kg.nodes.get(startNodeId)?.type ?? "?",
    depth: 0,
    children: [],
  };

  const queue: Array<{ nodeId: string; depth: number; parent: DependencyNode }> = [];
  const visited = new Set<string>();
  visited.add(startNodeId);
  let totalResults = 0;

  // Initialize with outgoing edges from the start node
  const outgoing = kg.outgoing.get(startNodeId);
  if (outgoing) {
    for (const targetId of outgoing) {
      if (!visited.has(targetId)) {
        queue.push({ nodeId: targetId, depth: 1, parent: root });
      }
    }
  }

  while (queue.length > 0 && totalResults < maxResults) {
    const { nodeId, depth, parent } = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = kg.nodes.get(nodeId);
    if (!node) continue;

    // Find the edge that connects parent to this node
    const edge = kg.edges.find(
      e => e.source === parent.nodeId && e.target === nodeId && e.relation === "calls",
    );

    const child: DependencyNode = {
      nodeId,
      label: node.label,
      type: node.type,
      depth,
      relation: edge?.relation ?? "?",
      sourceFile: node.sourceFile,
      sourceLocation: node.sourceLocation,
      children: [],
    };
    parent.children.push(child);
    totalResults++;

    // Only traverse deeper if within depth limit
    if (depth < maxDepth) {
      const childOutgoing = kg.outgoing.get(nodeId);
      if (childOutgoing) {
        for (const nextId of childOutgoing) {
          if (!visited.has(nextId)) {
            queue.push({ nodeId: nextId, depth: depth + 1, parent: child });
          }
        }
      }
    }
  }

  return root;
}
```

- [ ] **Step 2: Implement the tool handler**

```typescript
export const MindplaceImpactTool = {
  name: "mindplace_impact",
  label: "Impact Analysis",
  description:
    "Given a symbol name, traverse the knowledge graph to find everything that depends on it. Shows the dependency chain at increasing depth levels. Useful for understanding 'what breaks if I change this?'.",
  parameters: Type.Object({
    symbol: Type.String({
      description: "Symbol name to analyze (e.g. 'GrabMartStoreService.pauseStore', 'pauseStore', 'StoreController')",
    }),
    depth: Type.Optional(
      Type.Number({
        description: "Maximum traversal depth (default: 3, max: 5)",
        default: 3,
      }),
    ),
    path: Type.Optional(
      Type.String({
        description: "Project root path. Defaults to cwd.",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { symbol: string; depth?: number; path?: string },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    const root = params.path ?? ctx.cwd;
    const maxDepth = Math.min(params.depth ?? 3, 5);

    // Find the symbol in the graph
    const gp = join(root, "graph-out", "graph.json");
    if (!existsSync(gp)) {
      return { content: [{ type: "text" as const, text: "No graph found. Run mindplace_build first." }], isError: true };
    }

    const raw = JSON.parse(readFileSync(gp, "utf-8"));
    const kg = KnowledgeGraph.fromJSON(raw);

    // Find node by label (exact match first, then partial)
    let targetNode: GraphNode | undefined;
    for (const [, node] of kg.nodes) {
      if (node.label === params.symbol) {
        targetNode = node;
        break;
      }
    }
    // Fallback: partial match
    if (!targetNode) {
      for (const [, node] of kg.nodes) {
        if (node.label.includes(params.symbol)) {
          targetNode = node;
          break;
        }
      }
    }

    if (!targetNode) {
      return { content: [{ type: "text" as const, text: `Symbol "${params.symbol}" not found in the graph.` }], isError: true };
    }

    // Build dependency tree
    const tree = buildDependencyTree(kg, targetNode.id, maxDepth);

    if (tree.children.length === 0) {
      return { content: [{ type: "text" as const, text: `No dependents found for "${params.symbol}".` }] };
    }

    // Format output
    const lines: string[] = [];
    lines.push(`## Impact Analysis: ${tree.label}`);
    lines.push(`_${tree.type} @ ${tree.sourceFile}_`);
    lines.push("");
    formatTree(tree, lines, "");

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
};
```

- [ ] **Step 3: Implement tree formatter**

```typescript
function formatTree(node: DependencyNode, lines: string[], prefix: string): void {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    const fileInfo = child.sourceFile ? ` @ ${child.sourceFile}` : "";
    const depthLabel = child.depth > 0 ? `[d=${child.depth}] ` : "";
    lines.push(`${prefix}${connector}${depthLabel}${child.label} (${child.type})${fileInfo}`);
    formatTree(child, lines, prefix + childPrefix);
  }
}
```

---

### Task 2: Register the tool

- [ ] **Step 1: Add import + register in `index.ts`**

```typescript
import { MindplaceImpactTool } from "./src/tools/mindplace-impact.ts";
// ...
pi.registerTool(MindplaceImpactTool);
```

- [ ] **Step 2: Add auto-refresh**

```typescript
await refreshGraphIfStale(root);
```

- [ ] **Step 3: Verify**

```bash
# Test with known symbol
node --input-type=module -e "
import { readFileSync } from 'fs';
import { join } from 'path';
import { KnowledgeGraph } from './src/graph.ts';
// ... load graph and run BFS manually
"
```

---

### Verification Checklist

- [ ] `mindplace_impact "GrabMartStoreService.pauseStore"` shows 3+ dependents at depth 1
- [ ] `mindplace_impact "NonExistentSymbol"` returns "not found" error
- [ ] Depth > 5 gets capped to 5
- [ ] Cycle in graph (A → B → C → A) doesn't infinite loop
- [ ] No dependents → clear message
- [ ] No graph → clear error
- [ ] Output is readable tree with depth markers
