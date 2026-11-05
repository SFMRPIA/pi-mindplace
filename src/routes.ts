/**
 * Laravel route extraction — runs `php artisan route:list --json` in every
 * Laravel project under the scan root (the root itself plus immediate
 * Laravel sub-projects) and creates route nodes linked to existing
 * controller method nodes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode, GraphEdge } from "./types.ts";

export interface RouteExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * One entry per project that returned a parseable route list.
   *
   * Callers must *replace* these in the graph instead of merging them:
   * route node IDs are a sequential counter over `artisan route:list`, so an
   * additive merge duplicates every route whose position moved and keeps
   * nodes for deleted or re-pointed routes. A project whose artisan run failed
   * (or whose JSON did not parse) is absent here — its last known routes stay
   * in the graph rather than being wiped by a transient failure.
   */
  sources: RouteSourceResult[];
}

/** Route nodes/edges of a single successfully extracted Laravel project. */
export interface RouteSourceResult {
  /** Node-ID prefix for the project ("" when the scan root itself is the app). */
  prefix: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A directory that looks like a real Laravel app (composer.json + artisan). */
function isLaravelProject(dir: string): boolean {
  return existsSync(join(dir, "composer.json")) && existsSync(join(dir, "artisan"));
}

/**
 * Find Laravel route-extraction candidates: the root itself (only if it is a
 * real Laravel app) plus immediate subdirectories that look like Laravel
 * projects (monorepo sub-projects). A stray `artisan` wrapper without a
 * composer.json next to it is skipped automatically.
 *
 * `prefix` disambiguates node IDs per project (e.g. "backend:route_1_...").
 */
function laravelCandidates(root: string): { dir: string; prefix: string }[] {
  const candidates: { dir: string; prefix: string }[] = [];
  if (isLaravelProject(root)) {
    candidates.push({ dir: root, prefix: "" });
  }
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "vendor") continue;
      const full = join(root, entry.name);
      if (isLaravelProject(full)) {
        candidates.push({ dir: full, prefix: `${entry.name}:` });
      }
    }
  } catch {
    // Root unreadable — nothing to scan
  }
  return candidates;
}

/** PHP binaries to try, in order: PATH first, then common Laragon installs. */
function phpBinaries(): string[] {
  const LARAGON_ROOTS = [
    process.env.LARAGON_DIR,
    "D:/laragon",
    "C:/laragon",
    "E:/laragon",
  ].filter(Boolean) as string[];

  return [
    "php",
    ...LARAGON_ROOTS.flatMap(root => {
      try {
        return readdirSync(`${root}/bin/php`, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.startsWith("php-"))
          .map(d => `${root}/bin/php/${d.name}/php.exe`)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .toReversed();
      } catch { return []; }
    }),
  ];
}

/**
 * Extract Laravel routes by running `php artisan route:list --json` in every
 * Laravel project under `root` (the root itself plus immediate sub-projects).
 * Returns route nodes linked to existing controller method nodes.
 */
export function extractRoutes(root: string, existingNodes: GraphNode[]): RouteExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sources: RouteSourceResult[] = [];

  // Build an index of existing method nodes for quick lookup
  const methodIndex = new Map<string, GraphNode>();
  for (const n of existingNodes) {
    if (n.type === "method" && n.label.includes(".")) {
      methodIndex.set(n.label, n);
    }
  }

  const phpBin = phpBinaries();
  for (const { dir, prefix } of laravelCandidates(root)) {
    const source = extractRoutesForProject(dir, prefix, methodIndex, phpBin);
    // No source means the extraction failed — leave that project's existing
    // route nodes untouched rather than reporting an empty (successful) list.
    if (!source) continue;
    sources.push(source);
    nodes.push(...source.nodes);
    edges.push(...source.edges);
  }

  return { nodes, edges, sources };
}

/**
 * Run `php artisan route:list --json` in one Laravel dir.
 * Returns null when artisan could not be run or its output did not parse —
 * an empty array is a *successful* extraction of zero routes.
 */
function extractRoutesForProject(
  root: string,
  prefix: string,
  methodIndex: Map<string, GraphNode>,
  phpBin: string[],
): RouteSourceResult | null {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let stdout: string | null = null;
  for (const candidate of phpBin) {
    try {
      // execFileSync (not execSync): the old shell string interpolated the
      // candidate path, so a quote in LARAGON_DIR or the project path could
      // break out of the quoting. An argv array has no shell to escape.
      stdout = execFileSync(
        candidate,
        ["-d", "error_reporting=0", "artisan", "route:list", "--json"],
        { cwd: root, timeout: 15000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 },
      );
      break;  // first success
    } catch { /* try next */ }
  }

  if (!stdout) return null;

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
    return null;
  }
  if (!Array.isArray(routes)) return null;

  let routeCounter = 0;

  for (const route of routes) {
    // Skip HEAD (duplicate of GET), debug routes, Closure routes
    if (route.method === "HEAD") continue;
    if (route.uri.startsWith("_")) continue;
    if (route.action === "Closure") continue;

    routeCounter++;
    const routeLabel = `${route.method} /${route.uri}`;
    const routeId = `${prefix}route_${routeCounter}_${routeLabel.replace(/[^a-zA-Z0-9_]/g, "_")}`;

    nodes.push({
      id: routeId,
      label: routeLabel,
      type: "route",
      sourceFile: prefix ? `${prefix}routes` : "routes",
      sourceLocation: route.name ? `name: ${route.name}` : undefined,
      description: route.middleware.length > 0
        ? `middleware: ${route.middleware.join(", ")}`
        : undefined,
    });

    // Link to controller method if it exists
    if (route.action && route.action !== "Closure") {
      const parts = route.action.split("@");
      if (parts.length === 2) {
        const classFqcn = parts[0];
        const methodName = parts[1];
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

        // Also create a controller-level reference
        const controllerNodeId = `${prefix}route_controller_${shortClass}`;
        if (!nodes.find(n => n.id === controllerNodeId)) {
          nodes.push({
            id: controllerNodeId,
            label: shortClass,
            type: "controller",
            sourceFile: prefix ? `${prefix}routes` : "routes",
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

  return { prefix, nodes, edges };
}
