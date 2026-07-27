/**
 * mindplace_impact tool — impact analysis via reverse BFS on the knowledge graph.
 *
 * Given a symbol name, find everything that depends on it (reverse traversal
 * following outgoing edges), showing the dependency chain at depth levels.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeGraph } from "../graph.ts";
import type { GraphNode } from "../types.ts";
import { refreshGraphIfStale } from "../refresh.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DependencyNode {
  nodeId: string;
  label: string;
  type: string;
  depth: number;
  relation?: string;
  sourceFile?: string;
  sourceLocation?: string;
  children: DependencyNode[];
}

// ── BFS traversal ─────────────────────────────────────────────────────────────

const FOLLOW_RELATIONS = new Set(["calls", "references"]);

function buildDependencyTree(
  kg: KnowledgeGraph,
  startNodeId: string,
  maxDepth: number,
  maxResults: number,
): DependencyNode {
  const startNode = kg.nodes.get(startNodeId);
  const root: DependencyNode = {
    nodeId: startNodeId,
    label: startNode?.label ?? "?",
    type: startNode?.type ?? "?",
    depth: 0,
    sourceFile: startNode?.sourceFile,
    sourceLocation: startNode?.sourceLocation,
    children: [],
  };

  // Queue entries: { target node, depth, parent node }
  const queue: Array<{ nodeId: string; depth: number; parent: DependencyNode }> = [];
  const visited = new Set<string>();
  visited.add(startNodeId);
  let totalResults = 0;

  // Seed with dependency-on-startNode edges (reverse traversal)
  // We need edges where target === startNodeId and relation is in FOLLOW_RELATIONS
  for (const edge of kg.edges) {
    if (edge.target === startNodeId && FOLLOW_RELATIONS.has(edge.relation)) {
      if (!visited.has(edge.source)) {
        queue.push({ nodeId: edge.source, depth: 1, parent: root });
      }
    }
  }

  while (queue.length > 0 && totalResults < maxResults) {
    const { nodeId, depth, parent } = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = kg.nodes.get(nodeId);
    if (!node) continue;

    const edge = kg.edges.find(
      e => e.target === nodeId && e.source === parent.nodeId && FOLLOW_RELATIONS.has(e.relation),
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

    if (depth < maxDepth) {
      for (const e of kg.edges) {
        if (e.target === nodeId && FOLLOW_RELATIONS.has(e.relation) && !visited.has(e.source)) {
          queue.push({ nodeId: e.source, depth: depth + 1, parent: child });
        }
      }
    }
  }

  return root;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatTree(node: DependencyNode, lines: string[], prefix: string): void {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    const fileInfo = child.sourceFile ? ` @ ${child.sourceFile}${child.sourceLocation ? ":" + child.sourceLocation : ""}` : "";
    lines.push(`${prefix}${connector}[d=${child.depth}] ${child.label} (${child.type})${fileInfo}`);
    formatTree(child, lines, prefix + childPrefix);
  }
}

function findNodeByLabel(kg: KnowledgeGraph, label: string): GraphNode | undefined {
  // Exact match first (skip stubs — prefer class-qualified nodes)
  const SKIP_STUBS = new Set(["call", "file", "field", "namespace"]);
  let exactMatch: GraphNode | undefined;
  for (const [, node] of kg.nodes) {
    if (node.label === label && !SKIP_STUBS.has(node.type)) {
      exactMatch = node;
      break;
    }
  }
  if (exactMatch) return exactMatch;

  // Partial match: prefer method nodes (which are class-qualified like "GrabMartStoreService.pauseStore")
  // over stub nodes (bare "pauseStore"). If the label contains a dot, it's class-qualified.
  let bestNode: GraphNode | undefined;
  for (const [, node] of kg.nodes) {
    if (node.label.includes(label)) {
      if (node.type === "method" || node.type === "class" || node.type === "function") {
        // Prefer class-qualified names
        if (bestNode === undefined) bestNode = node;
        if (node.label.includes(".")) return node;  // class-qualified is best match
      }
      if (!bestNode) bestNode = node;
    }
  }

  return bestNode;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const MindplaceImpactTool = {
  name: "mindplace_impact",
  label: "Impact Analysis",
  description:
    "Given a symbol name, traverse the knowledge graph to find everything that depends on it (reverse dependency chain). Shows direct callers at depth 1, their callers at depth 2, etc. Useful for understanding 'what breaks if I change this?'.",
  promptSnippet: "Analyze what depends on a code symbol",
  parameters: Type.Object({
    symbol: Type.String({
      description: "Symbol name to analyze (e.g. 'GrabMartStoreService.pauseStore', 'pauseStore', 'StoreController')",
    }),
    depth: Type.Optional(
      Type.Number({
        description: "Maximum traversal depth (default: 2, max: 5)",
        default: 2,
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
    const maxDepth = Math.min(params.depth ?? 2, 5);
    const maxResults = 50;

    // Auto-refresh graph
    await refreshGraphIfStale(root);

    const gp = join(root, "graph-out", "graph.json");
    if (!existsSync(gp)) {
      return {
        content: [{ type: "text" as const, text: "No graph found. Run mindplace_build first." }],
        isError: true,
      };
    }

    let kg: KnowledgeGraph;
    try {
      const raw = JSON.parse(readFileSync(gp, "utf-8"));
      kg = KnowledgeGraph.fromJSON(raw);
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to load graph: ${err}` }],
        isError: true,
      };
    }

    // Find target node
    const targetNode = findNodeByLabel(kg, params.symbol);

    if (!targetNode) {
      return {
        content: [{ type: "text" as const, text: `Symbol "${params.symbol}" not found in the graph. Try a different name or use mindplace_search first.` }],
        isError: true,
      };
    }

    // Build tree
    const tree = buildDependencyTree(kg, targetNode.id, maxDepth, maxResults);

    const lines: string[] = [];
    lines.push(`## Impact Analysis: ${tree.label}`);
    lines.push(`_${tree.type} @ ${tree.sourceFile ?? "unknown"}${tree.sourceLocation ? ":" + tree.sourceLocation : ""}_`);
    lines.push("");

    if (tree.children.length === 0) {
      lines.push("No dependents found in the graph.");
    } else {
      formatTree(tree, lines, "");
      if (tree.children.length >= maxResults) {
        lines.push("");
        lines.push(`_Truncated at ${maxResults} results. Try narrowing the symbol name._`);
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
};
