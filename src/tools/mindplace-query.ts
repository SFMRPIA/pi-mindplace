/**
 * mindplace_query tool — query the knowledge graph
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { KnowledgeGraph } from "../graph.ts";
import { query, formatQueryResult } from "../query.ts";
import { refreshGraphIfStale } from "../refresh.ts";
import { findGraphRoot, graphPath } from "../paths.ts";
import { pendingChanges } from "../watcher.ts";
import type { GraphNode } from "../types.ts";

// ── Source snippets ──────────────────────────────────────────────────────────
// (ponytail: line-window heuristics — next-symbol end or +30 lines; enough to
//  show real context, not AST-accurate bodies)

const SNIPPET_BUDGET = 1200; // tokens
const MAX_SNIPPET_LINES = 40;

function buildSourceSnippets(root: string, nodes: GraphNode[], queryBudget: number): string {
  const budget = Math.min(SNIPPET_BUDGET, Math.floor(queryBudget * 0.25));
  if (budget < 100) return "";

  // Candidates: concrete code symbols with a numeric source location
  const candidates = nodes.filter(
    n => (n.type === "method" || n.type === "function" || n.type === "class") &&
         n.sourceFile && n.sourceLocation && /L\d+/.test(n.sourceLocation),
  );

  // Keep up to 3 symbols per file, 3 files total — read each file once
  const perFile = new Map<string, GraphNode[]>();
  for (const n of candidates) {
    const arr = perFile.get(n.sourceFile) ?? [];
    if (arr.length < 3) arr.push(n);
    perFile.set(n.sourceFile, arr);
  }

  const lines: string[] = [];
  let tokens = 0;
  const CHARS_PER_TOKEN = 4;

  for (const [file, syms] of [...perFile.entries()].slice(0, 3)) {
    const abs = join(root, file);
    let source: string;
    try {
      source = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const srcLines = source.split(/\r?\n/);

    for (const sym of syms) {
      const m = sym.sourceLocation!.match(/L(\d+)(?:\s*-\s*L?(\d+))?/);
      if (!m) continue;
      const start = parseInt(m[1], 10);
      if (start < 1 || start > srcLines.length) continue;

      let end: number;
      if (m[2]) {
        end = parseInt(m[2], 10);
      } else {
        // End at the next symbol's start line in this file, else +30
        const nextLine = syms
          .map(o => o.sourceLocation?.match(/L(\d+)/)?.[1])
          .filter(Boolean)
          .map(Number)
          .filter(l => l > start)
          .sort((a, b) => a - b)[0];
        end = (nextLine ?? start + 31) - 1;
      }
      end = Math.min(end, start + MAX_SNIPPET_LINES - 1, srcLines.length);
      if (end < start) continue;

      const body = srcLines.slice(start - 1, end).join("\n");
      const cost = Math.ceil(body.length / CHARS_PER_TOKEN);
      if (tokens + cost > budget) {
        return lines.length ? "\n" + lines.join("\n") : "";
      }
      tokens += cost;

      const lang = file.endsWith(".php") ? "php"
        : file.endsWith(".vue") ? "vue"
        : file.endsWith(".py") ? "python"
        : file.endsWith(".go") ? "go"
        : file.endsWith(".sh") ? "bash"
        : "ts";
      lines.push(`### Source: ${sym.label} (\`${file}:${start}\`)`);
      lines.push("```" + lang);
      lines.push(body);
      lines.push("```");
      lines.push("");
    }
  }

  return lines.length ? "\n" + lines.join("\n") : "";
}

export const MindplaceQueryTool = {
  name: "mindplace_query",
  label: "Query Mind Place",
  description:
    "Query the code knowledge graph with a natural-language question. Returns the most relevant code entities and their relationships — much faster than reading raw files. The graph must be built first with mindplace_build.",
  promptSnippet: "Query the code knowledge graph for relevant entities",
  promptGuidelines: [
    "Use mindplace_query FIRST when answering questions about the codebase structure, relationships between files/functions, or tracing data flow. Only read raw files after the graph has oriented you.",
  ],
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Project root path. Defaults to cwd.",
      }),
    ),
    question: Type.String({
      description: "Natural-language question about the codebase",
    }),
    budget: Type.Optional(
      Type.Number({
        description: "Token budget for the result (default: 4000)",
        default: 4000,
      }),
    ),
    minScore: Type.Optional(
      Type.Number({
        description: "Minimum relevance score 0..1 (default: 0.15). Lower = more results, higher = only strong matches.",
        default: 0.15,
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { path?: string; question: string; budget?: number; minScore?: number },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    const root = params.path ?? findGraphRoot(ctx.cwd) ?? ctx.cwd;

    // Auto-refresh graph if stale before querying
    await refreshGraphIfStale(root);

    const gp = graphPath(root);

    if (!existsSync(gp)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No knowledge graph found. Pi-mindplace attempted to build it automatically but failed. Try running mindplace_build manually.`,
          },
        ],
        details: { graphExists: false },
        isError: true,
      };
    }

    try {
      const raw = JSON.parse(readFileSync(gp, "utf-8"));
      const kg = KnowledgeGraph.fromJSON(raw);

      const budget = params.budget ?? 4000;
      const result = query(kg, params.question, budget, "bfs", params.minScore ?? 0.15);
      let formatted = formatQueryResult(result);

      // Verbatim source for the top symbols — no need to read the files again
      formatted += buildSourceSnippets(root, result.nodes, budget);

      // Staleness banner: edits still inside the watcher's debounce window
      const pending = pendingChanges(root);
      if (pending.length > 0) {
        const shown = pending.slice(0, 5).map(f => `\`${f}\``).join(", ");
        formatted =
          `⚠️ ${pending.length} file(s) changed in the last ~2s — the graph may not include them yet: ${shown}\n\n` +
          formatted;
      }

      return {
        content: [{ type: "text" as const, text: formatted }],
        details: {
          nodesReturned: result.nodes.length,
          tokensUsed: result.tokensUsed,
          budget: result.budget,
          coverage: result.coverage,
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to query mind place: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        details: { error: String(err) },
        isError: true,
      };
    }
  },
};
