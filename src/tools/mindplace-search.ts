/**
 * mindplace_search tool — full-text search across all code symbols
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { searchIndex, searchDbPath } from "../search.ts";
import { refreshGraphIfStale } from "../refresh.ts";
import { existsSync } from "node:fs";

export const MindplaceSearchTool = {
  name: "mindplace_search",
  label: "Search Code Symbols",
  description:
    "Full-text search across all code symbols (classes, methods, functions, routes) in the knowledge graph. Returns ranked results by relevance. More precise than grep for finding named symbols.",
  promptSnippet: "Search code symbols by name or description",
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Project root path. Defaults to cwd.",
      }),
    ),
    query: Type.String({
      description: "Search query — supports FTS5 syntax like prefix search (run*) and phrase search (\"user auth\")",
    }),
    limit: Type.Optional(
      Type.Number({
        description: "Maximum results (default: 20)",
        default: 20,
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { path?: string; query: string; limit?: number },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    const root = params.path ?? ctx.cwd;

    // Auto-refresh graph if stale (routes, new files, etc.)
    await refreshGraphIfStale(root);

    if (!existsSync(searchDbPath(root))) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No search index found. Run mindplace_build first.",
          },
        ],
        isError: true,
      };
    }

    const results = searchIndex(root, params.query, params.limit ?? 20);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No results for "${params.query}". Try different terms or use wildcards (e.g., "${params.query}*").`,
          },
        ],
      };
    }

    const lines: string[] = [];
    lines.push(`## Search results for "${params.query}"`);
    lines.push("");

    for (const r of results) {
      const desc = r.description ? ` — ${r.description.slice(0, 100)}` : "";
      lines.push(`- **${r.label}** (${r.type}) @ \`${r.file}\`${desc}`);
    }

    lines.push("");
    lines.push(`_${results.length} results_`);

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { resultCount: results.length },
    };
  },
};
