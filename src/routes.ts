/**
 * Laravel route extraction — runs `php artisan route:list --json` and creates
 * route nodes linked to existing controller method nodes.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
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

  // Try common PHP binary paths
  const phpCandidates = [
    "php",
    "/usr/bin/php",
    "/usr/local/bin/php",
    "D:/laragon/bin/php/php-8.4.19-Win32-vs17-x64/php.exe",
    "C:/laragon/bin/php/php-8.4.19-Win32-vs17-x64/php.exe",
    "D:/laragon/bin/php/php-8.3.0-Win32-vs16-x64/php.exe",
  ];

  // Find the PHP binary that works
  let phpBin = "php";
  for (const candidate of phpCandidates) {
    try {
      execSync(`"${candidate}" -v`, { timeout: 3000, encoding: "utf-8", windowsHide: true });
      phpBin = candidate;
      break;
    } catch { /* try next */ }
  }

  let stdout: string;
  try {
    stdout = execSync(`"${phpBin}" artisan route:list --json`, {
      cwd: root,
      timeout: 15000,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return { nodes, edges };  // artisan not available, skip
  }

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
