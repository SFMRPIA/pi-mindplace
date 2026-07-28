/**
 * Laravel route extraction — runs `php artisan route:list --json` and creates
 * route nodes linked to existing controller method nodes.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode, GraphEdge } from "./types.ts";

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

  // Try "php" from PATH first. If artisan fails, scan common Laragon installs.
  const LARAGON_ROOTS = [
    process.env.LARAGON_DIR,
    "D:/laragon",
    "C:/laragon",
    "E:/laragon",
  ].filter(Boolean) as string[];

  const phpCandidates = [
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

  let stdout: string | null = null;
  for (const candidate of phpCandidates) {
    try {
      stdout = execSync(`"${candidate}" artisan route:list --json`, {
        cwd: root, timeout: 15000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024,
      });
      break;  // first success
    } catch { /* try next */ }
  }

  if (!stdout) return { nodes, edges };

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

  let routeCounter = 0;

  for (const route of routes) {
    // Skip HEAD (duplicate of GET), debug routes, Closure routes
    if (route.method === "HEAD") continue;
    if (route.uri.startsWith("_")) continue;
    if (route.action === "Closure") continue;

    routeCounter++;
    const routeLabel = `${route.method} /${route.uri}`;
    const routeId = `route_${routeCounter}_${routeLabel.replace(/[^a-zA-Z0-9_]/g, "_")}`;

    nodes.push({
      id: routeId,
      label: routeLabel,
      type: "route",
      sourceFile: "routes",
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
