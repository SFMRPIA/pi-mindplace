# FTS5 Search Implementation Plan

**File: `src/search.ts`** — build and query FTS5 full-text search index from the graph.

**File: `src/tools/mindplace-search.ts`** — new tool `mindplace_search` for searching the index.

**Integration:** Build search index after every graph refresh (`refreshGraphIfStale`). Register tool in `index.ts`.

- [ ] **Step 1: Create `src/search.ts`**

```typescript
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeGraph } from "./graph.ts";

const DB_FILE = "search.sqlite";

export function searchDbPath(cwd: string): string {
  return join(cwd, "graph-out", DB_FILE);
}

/**
 * Build or rebuild the FTS5 search index from the knowledge graph.
 */
export function buildSearchIndex(cwd: string, kg: KnowledgeGraph): void {
  const dbPath = searchDbPath(cwd);
  mkdirSync(join(cwd, "graph-out"), { recursive: true });

  const db = new DatabaseSync(dbPath);

  // Create FTS5 virtual table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols USING fts5(
      id, label, type, file, description,
      tokenize='porter unicode61'
    );
    DELETE FROM symbols;
  `);

  // Insert all nodes
  const insert = db.prepare(
    "INSERT INTO symbols (id, label, type, file, description) VALUES (?, ?, ?, ?, ?)"
  );

  for (const [nodeId, node] of kg.nodes) {
    insert.run(
      nodeId,
      node.label,
      node.type,
      node.sourceFile ?? "",
      node.description ?? ""
    );
  }

  db.close();
}

/**
 * Search the FTS5 index for a query.
 */
export function searchIndex(
  cwd: string,
  query: string,
  limit: number = 20
): Array<{ id: string; label: string; type: string; file: string; description?: string; rank: number }> {
  const dbPath = searchDbPath(cwd);
  if (!existsSync(dbPath)) return [];

  const db = new DatabaseSync(dbPath);

  try {
    const rows = db.prepare(
      `SELECT id, label, type, file, description, rank
       FROM symbols
       WHERE symbols MATCH ?
       ORDER BY rank
       LIMIT ?`
    ).all(query, limit);

    return rows as Array<{ id: string; label: string; type: string; file: string; description?: string; rank: number }>;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: Create `src/tools/mindplace-search.ts`**

```typescript
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { searchIndex, searchDbPath } from "../search.ts";
import { existsSync } from "node:fs";

export const MindplaceSearchTool = {
  name: "mindplace_search",
  label: "Search Code Symbols",
  description: "Full-text search across all code symbols (classes, methods, functions, routes) in the knowledge graph. Returns ranked results by relevance.",
  promptSnippet: "Search code symbols by name or description",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(Type.Number({ description: "Max results (default: 20)", default: 20 })),
  }),
  async execute(
    _toolCallId: string,
    params: { query: string; limit?: number },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    if (!existsSync(searchDbPath(ctx.cwd))) {
      return {
        content: [{ type: "text" as const, text: "No search index found. Run mindplace_build first." }],
        isError: true,
      };
    }

    const results = searchIndex(ctx.cwd, params.query, params.limit ?? 20);

    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No results for "${params.query}". Try different terms.` }],
      };
    }

    const lines = [`## Search results for "${params.query}"`, ""];
    for (const r of results) {
      const desc = r.description ? ` — ${r.description}` : "";
      lines.push(`**${r.label}** (${r.type}) @ ${r.file}${desc}`);
    }
    lines.push("", `_${results.length} results_`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
};
```

- [ ] **Step 3: Integrate into `refreshGraphIfStale()`**

In `src/refresh.ts`, after the route extraction step, add:

```typescript
import { buildSearchIndex } from "./search.ts";

// After route nodes are added and before save:
buildSearchIndex(cwd, kg);
```

- [ ] **Step 4: Register tool in `index.ts`**

Add import and registration:

```typescript
import { MindplaceSearchTool } from "./src/tools/mindplace-search.ts";

// In the default function:
pi.registerTool(MindplaceSearchTool);
```

- [ ] **Step 5: Commit and push**
