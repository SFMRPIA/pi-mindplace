/**
 * FTS5 full-text search index for the knowledge graph.
 * Uses Node.js built-in node:sqlite (Node 22.5+).
 */

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
 * Uses porter tokenizer for stemming (e.g., "running" matches "run").
 */
export function buildSearchIndex(cwd: string, kg: KnowledgeGraph): void {
  const dbPath = searchDbPath(cwd);
  mkdirSync(join(cwd, "graph-out"), { recursive: true });

  const db = new DatabaseSync(dbPath);

  // Create FTS5 virtual table (IF NOT EXISTS so incremental rebuilds work)
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
 * Search the FTS5 index.
 * Returns up to `limit` results ranked by relevance.
 */
export function searchIndex(
  cwd: string,
  query: string,
  limit: number = 20,
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
       LIMIT ?`,
    ).all(query, limit);

    return rows as Array<{ id: string; label: string; type: string; file: string; description?: string; rank: number }>;
  } finally {
    db.close();
  }
}
