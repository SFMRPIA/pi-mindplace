/**
 * mindplace_build tool — scan and build the knowledge graph
 *
 * Supports monorepo auto-detection: when run from a monorepo root without
 * an explicit `path`, it scans immediate subdirectories for project markers
 * (composer.json + artisan, package.json + vite.config.*) and builds a
 * separate graph inside each detected project's folder instead of one
 * mixed graph at root level.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { detect } from "../detect.ts";
import { extract } from "../extract.ts";
import { KnowledgeGraph } from "../graph.ts";
import { extractRoutes } from "../routes.ts";
import { buildSearchIndex } from "../search.ts";
import { buildClassIndex, saveClassIndex } from "../class-index.ts";
import { resolveCalls } from "../resolve.ts";
import { generateReport } from "../report.ts";
import { generateHtml } from "../viz.ts";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const OUT_DIR = "graph-out";

// ─── Monorepo project detection ─────────────────────────────────────────

interface ProjectInfo {
  name: string;
  path: string;
}

/**
 * Detect sub-projects in a monorepo by looking for project markers
 * in immediate subdirectories of the root.
 *
 * Markers:
 *   - composer.json + artisan → Laravel backend
 *   - package.json + vite.config.* → Vite/JS frontend
 *
 * Returns a list of { name, path } for detected projects.
 * If root itself has no markers, only subdirectories with markers
 * are returned. If root has markers, it's included too.
 */
function detectProjects(root: string): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  const seen = new Set<string>();

  // Check root itself for project markers
  const hasRootComposer = existsSync(join(root, "composer.json"));
  const hasRootArtisan = existsSync(join(root, "artisan"));
  const hasRootPackage = existsSync(join(root, "package.json"));

  if (hasRootComposer || hasRootPackage) {
    projects.push({ name: basename(root), path: root });
    seen.add(root);
  }

  // Scan immediate subdirectories
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return projects;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "vendor") continue;

    const fullPath = join(root, entry);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const hasComposer = existsSync(join(fullPath, "composer.json"));
    const hasArtisan = existsSync(join(fullPath, "artisan"));
    const hasPackage = existsSync(join(fullPath, "package.json"));
    const hasViteConfig =
      existsSync(join(fullPath, "vite.config.js")) ||
      existsSync(join(fullPath, "vite.config.ts"));

    if ((hasComposer && hasArtisan) || (hasPackage && hasViteConfig)) {
      if (!seen.has(fullPath)) {
        projects.push({ name: entry, path: fullPath });
        seen.add(fullPath);
      }
    }
  }

  return projects;
}

// ─── Single-project build logic (extracted for reuse) ───────────────────

async function buildSingleProject(
  root: string,
  force: boolean,
  directed: boolean,
  noViz: boolean,
  noReport: boolean,
  update: boolean,
  onUpdate: (update: unknown) => void,
): Promise<{ content: { type: "text"; text: string }[]; details?: Record<string, unknown>; isError?: boolean }> {
  const outFile = join(root, OUT_DIR, "graph.json");
  const graphExists = existsSync(outFile);

  if (!force && !update && graphExists) {
    return {
      content: [{ type: "text" as const, text: `Knowledge graph already exists at \`${outFile}\`. Use \`force=true\` to rebuild or \`update=true\` for incremental update.` }],
      details: { skipped: true },
    };
  }

  try {
    // Step 1: Detect
    const detected = detect(root);
    if (detected.files.length === 0) {
      const exts = Object.keys({ ".js": 1, ".ts": 1, ".py": 1, ".go": 1, ".sh": 1, ".json": 1 }).join(", ");
      return {
        content: [{ type: "text" as const, text: `No supported code files found in ${root}. Supported: ${exts}` }],
        details: { totalFiles: 0 },
      };
    }

    // Step 2: Extract with cache — report progress
    const cacheDir = join(root, OUT_DIR, "cache");
    const totalToExtract = detected.files.length;
    let lastReported = 0;

    const extResult = extract(root, detected.files, cacheDir, force, (done) => {
      if (done - lastReported >= 10 || done === totalToExtract) {
        lastReported = done;
        onUpdate({
          content: [{ type: "text" as const, text: `🔍 Extracting... ${done}/${totalToExtract} files` }],
          details: { stage: "extracting", done, total: totalToExtract },
        });
      }
    });

    // Step 3: Build graph (merge if updating)
    let kg: KnowledgeGraph;
    if (update && graphExists) {
      const existing = JSON.parse(readFileSync(outFile, "utf-8"));
      kg = KnowledgeGraph.fromJSON(existing, directed);
      kg.merge(extResult);
    } else {
      kg = KnowledgeGraph.fromExtraction(extResult, directed);
    }

    // Step 4: Add Laravel route nodes (deduped merge — same as refresh)
    const routeResult = extractRoutes(root, [...kg.nodes.values()]);
    kg.merge(routeResult);
    for (const e of routeResult.edges) {
      if (!kg.nodes.has(e.source)) continue;
      const out = kg.outgoing.get(e.source) ?? new Set();
      out.add(e.target);
      kg.outgoing.set(e.source, out);
    }

    // Step 5: Build class index and resolve cross-file calls
    const classIndex = buildClassIndex(root, kg);
    const resolvedCount = resolveCalls(kg, classIndex);
    saveClassIndex(root, classIndex);

    // Step 6: Build FTS5 search index
    buildSearchIndex(root, kg);

    // Step 7: Analyze
    kg.computeCentrality();
    kg.detectCommunities();
    const stats = kg.stats();

    // Persist
    mkdirSync(join(root, OUT_DIR), { recursive: true });
    writeFileSync(outFile, JSON.stringify(kg.toJSON(), null, 2), "utf-8");

    let reportPath = "";
    let htmlPath = "";

    // Report
    if (!noReport) {
      const report = generateReport(kg, stats, root, detected.totalFiles, detected.byExtension);
      reportPath = join(root, OUT_DIR, "GRAPH_REPORT.md");
      writeFileSync(reportPath, report, "utf-8");
    }

    // HTML visualization
    if (!noViz && stats.nodeCount <= 5000) {
      const html = generateHtml(kg, root.split("/").pop() ?? "Mind Place");
      htmlPath = join(root, OUT_DIR, "graph.html");
      writeFileSync(htmlPath, html, "utf-8");
    }

    // Build summary
    const filesLine = extResult.cached > 0
      ? `${extResult.cached} cached, ${extResult.extracted} extracted`
      : `${extResult.extracted} extracted`;

    const outputs: string[] = [
      `🧠 **Mind Place built!**`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Files | ${detected.totalFiles} (${filesLine}) |`,
      `| Languages | ${Object.entries(detected.byExtension).map(([e, n]) => `\`${e}\`×${n}`).join(", ") || "none"} |`,
      `| Nodes | ${stats.nodeCount} |`,
      `| Edges | ${stats.edgeCount} |`,
      `| Communities | ${stats.communityCount} |`,
      `| Mode | ${directed ? "directed" : "undirected"} |`,
    ];

    if (reportPath) outputs.push(`| Report | \`${OUT_DIR}/GRAPH_REPORT.md\` |`);
    if (htmlPath) outputs.push(`| Visualization | \`${OUT_DIR}/graph.html\` |`);
    outputs.push(`| Graph | \`${OUT_DIR}/graph.json\` |`);

    if (stats.godNodes.length > 0) {
      outputs.push(``);
      outputs.push(`### 🏛️ God Nodes`);
      stats.godNodes.forEach((n, i) => {
        outputs.push(`${i + 1}. **${n.label}** — ${n.degree} connections`);
      });
    }

    outputs.push(``);
    outputs.push(`Use \`mindplace_query\` to explore. Try: "What are the main modules?"`);

    return {
      content: [{ type: "text" as const, text: outputs.join("\n") }],
      details: { ...stats, cachedFiles: extResult.cached, extractedFiles: extResult.extracted },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Failed to build mind place: ${err instanceof Error ? err.message : String(err)}` }],
      details: { error: String(err) },
      isError: true,
    };
  }
}

// ─── Tool definition ────────────────────────────────────────────────────

export const MindplaceBuildTool = {
  name: "mindplace_build",
  label: "Build Mind Place",
  description:
    "Scan the current project and build a knowledge graph of all code entities (functions, classes, imports). Supports JS, TS, Python, Go, Bash, JSON. The graph is persisted to graph-out/ for fast queries across sessions.",
  promptSnippet: "Build a code knowledge graph for token-efficient queries",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Project root path. Defaults to cwd." })),
    force: Type.Optional(Type.Boolean({ description: "Force rebuild ignoring cache", default: false })),
    directed: Type.Optional(Type.Boolean({ description: "Build directed graph (preserve edge direction)", default: false })),
    noViz: Type.Optional(Type.Boolean({ description: "Skip HTML visualization", default: false })),
    noReport: Type.Optional(Type.Boolean({ description: "Skip GRAPH_REPORT.md", default: false })),
    update: Type.Optional(Type.Boolean({ description: "Incremental update — only re-extract changed files", default: false })),
  }),
  async execute(
    _toolCallId: string,
    params: { path?: string; force?: boolean; directed?: boolean; noViz?: boolean; noReport?: boolean; update?: boolean },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    const root = params.path ?? ctx.cwd;

    // ── Monorepo auto-detection ──────────────────────────────────────
    // When no explicit path is given, check if root contains multiple
    // sub-projects. If found, build a graph for each one in its own
    // folder instead of building one mixed graph at root level.
    if (!params.path) {
      const subProjects = detectProjects(root);
      if (subProjects.length > 1) {
        const results: string[] = [];
        let anyError = false;
        for (const proj of subProjects) {
          _onUpdate({
            content: [{ type: "text" as const, text: `📦 Building graph for "${proj.name}"...` }],
            details: { stage: "monorepo", project: proj.name },
          });
          try {
            const result = await buildSingleProject(
              proj.path,
              params.force ?? false,
              params.directed ?? false,
              params.noViz ?? false,
              params.noReport ?? false,
              params.update ?? false,
              _onUpdate,
            );
            if (result.isError) {
              results.push(`❌ **${proj.name}**: build failed`);
              anyError = true;
            } else {
              const text = result.content?.[0]?.text ?? "";
              const lines = text.split("\n");
              const nodesLine = lines.find(l => l.startsWith("| Nodes |"));
              const nodeCount = nodesLine?.match(/\|\s*(\d+)\s*\|/)?.[1] ?? "?";
              results.push(`✅ **${proj.name}** — ${nodeCount} nodes`);
            }
          } catch (e) {
            results.push(`❌ **${proj.name}**: ${e instanceof Error ? e.message : String(e)}`);
            anyError = true;
          }
        }

        const outputs = [
          `🧠 **Mind Place built — ${subProjects.length} projects**`,
          ``,
          ...results,
          ``,
          `Use \`mindplace_query(path="<project>")\` to query a specific project's graph.`,
        ];

        return {
          content: [{ type: "text" as const, text: outputs.join("\n") }],
          details: { projectCount: subProjects.length, projects: subProjects.map(p => p.name) },
          isError: anyError,
        };
      }
    }

    // ── Single project build (explicit path, or only one project detected) ──
    return await buildSingleProject(
      root,
      params.force ?? false,
      params.directed ?? false,
      params.noViz ?? false,
      params.noReport ?? false,
      params.update ?? false,
      _onUpdate,
    );
  },
};
