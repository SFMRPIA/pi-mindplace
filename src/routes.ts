/**
 * Laravel route extraction — runs `php artisan route:list --json` in every
 * Laravel project under the scan root (the root itself plus immediate
 * Laravel sub-projects) and creates route nodes linked to existing
 * controller method nodes.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode, GraphEdge } from "./types.ts";

export interface RouteExtractionResult {
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
          .sort().reverse();
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

  // Build an index of existing method nodes for quick lookup
  const methodIndex = new Map<string, GraphNode>();
  for (const n of existingNodes) {
    if (n.type === "method" && n.label.includes(".")) {
      methodIndex.set(n.label, n);
    }
  }

  const phpBin = phpBinaries();
  for (const { dir, prefix } of laravelCandidates(root)) {
    extractRoutesForProject(dir, prefix, methodIndex, phpBin, nodes, edges);
  }

  return { nodes, edges };
}

/** Run `php artisan route:list --json` in one Laravel dir; append nodes/edges. */
function extractRoutesForProject(
  root: string,
  prefix: string,
  methodIndex: Map<string, GraphNode>,
  phpBin: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  let stdout: string | null = null;
  for (const candidate of phpBin) {
    try {
      stdout = execSync(`"${candidate}" -d error_reporting=0 artisan route:list --json`, {
        cwd: root, timeout: 15000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024,
      });
      break;  // first success
    } catch { /* try next */ }
  }

  if (!stdout) return;

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
    return;
  }

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
}
