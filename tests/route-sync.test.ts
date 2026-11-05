/**
 * Tests for per-project route reconciliation (KnowledgeGraph.replaceRouteSource).
 *
 * Node IDs follow src/routes.ts: `${prefix}route_<counter>_<label>` for routes
 * and `${prefix}route_controller_<ShortClass>` for controller anchors. The
 * counter is positional over `artisan route:list`, so the same route gets a
 * different ID as soon as its position moves — which is exactly why route
 * extraction must replace its subgraph instead of merging it.
 *
 * These tests build route data directly (no PHP needed); routes.test.ts covers
 * the `artisan route:list` path itself.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KnowledgeGraph } from "../src/graph.ts";
import type { ExtractionResult, GraphEdge, GraphNode } from "../src/types.ts";
import type { RouteSourceResult } from "../src/routes.ts";

interface RouteSpec {
  method: string;
  uri: string;
  /** Controller short class name, when the route has a controller action. */
  className?: string;
  /** Controller method name, linked to an existing `method_<class>_<method>` node. */
  methodName?: string;
}

function routeNode(prefix: string, counter: number, label: string): GraphNode {
  return {
    id: `${prefix}route_${counter}_${label.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    label,
    type: "route",
    sourceFile: `${prefix}routes`,
  };
}

function controllerNode(prefix: string, shortClass: string): GraphNode {
  return {
    id: `${prefix}route_controller_${shortClass}`,
    label: shortClass,
    type: "controller",
    sourceFile: `${prefix}routes`,
  };
}

/** Build the extraction a successful `extractRoutes()` call would report. */
function routeSource(prefix: string, routes: RouteSpec[]): RouteSourceResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  routes.forEach((route, i) => {
    const node = routeNode(prefix, i + 1, `${route.method} /${route.uri}`);
    nodes.push(node);
    if (!route.className) return;

    const controllerId = `${prefix}route_controller_${route.className}`;
    if (!nodes.some(n => n.id === controllerId)) {
      nodes.push(controllerNode(prefix, route.className));
    }
    edges.push({
      source: node.id,
      target: controllerId,
      relation: "references",
      confidence: "EXTRACTED",
    });
    if (route.methodName) {
      edges.push({
        source: node.id,
        target: `method_${route.className}_${route.methodName}`,
        relation: "references",
        confidence: "EXTRACTED",
      });
    }
  });

  return { prefix, nodes, edges };
}

/** Non-route scaffolding a real graph would already contain. */
function methodNodes(classNames: string[]): GraphNode[] {
  return classNames.flatMap(className => [
    { id: `class_${className}`, label: className, type: "class", sourceFile: `${className}.php` },
    {
      id: `method_${className}_start`,
      label: `${className}.start`,
      type: "method",
      sourceFile: `${className}.php`,
    },
    {
      id: `method_${className}_stop`,
      label: `${className}.stop`,
      type: "method",
      sourceFile: `${className}.php`,
    },
  ]);
}

function baseGraph(nodes: GraphNode[] = methodNodes(["CallsController"])): KnowledgeGraph {
  return KnowledgeGraph.fromExtraction({ nodes, edges: [] });
}

function routeLabels(kg: KnowledgeGraph): string[] {
  return [...kg.nodes.values()]
    .filter(n => n.type === "route")
    .map(n => n.label)
    .sort();
}

function methodTargets(kg: KnowledgeGraph, routeId: string): string[] {
  return kg.edges
    .filter(e => e.source === routeId && e.target.startsWith("method_"))
    .map(e => e.target)
    .sort();
}

/** Every edge endpoint exists, and no purge left dangling adjacency entries. */
function assertNoDanglingLinks(kg: KnowledgeGraph): void {
  for (const edge of kg.edges) {
    assert.ok(kg.nodes.has(edge.source), `edge source ${edge.source} is missing`);
    assert.ok(kg.nodes.has(edge.target), `edge target ${edge.target} is missing`);
  }
  for (const [id, neighbors] of kg.adjacency) {
    for (const neighbor of neighbors) {
      assert.ok(kg.nodes.has(neighbor), `adjacency ${id} → ${neighbor} is dangling`);
    }
  }
  for (const [id, targets] of kg.outgoing) {
    for (const target of targets) {
      assert.ok(kg.nodes.has(target), `outgoing ${id} → ${target} is dangling`);
    }
  }
}

describe("KnowledgeGraph.replaceRouteSource", () => {
  it("keeps exactly one node per route when a reordered list is re-applied", () => {
    const kg = baseGraph();
    const first = routeSource("", [
      { method: "GET", uri: "api/a", className: "CallsController", methodName: "start" },
      { method: "POST", uri: "api/b", className: "CallsController", methodName: "stop" },
    ]);
    kg.replaceRouteSource("", first);
    assert.deepEqual(routeLabels(kg), ["GET /api/a", "POST /api/b"]);

    // A new route was added at the top, shifting every counter by one.
    const reordered = routeSource("", [
      { method: "POST", uri: "api/new", className: "CallsController", methodName: "start" },
      { method: "GET", uri: "api/a", className: "CallsController", methodName: "start" },
      { method: "POST", uri: "api/b", className: "CallsController", methodName: "stop" },
    ]);
    kg.replaceRouteSource("", reordered);

    assert.deepEqual(routeLabels(kg), ["GET /api/a", "POST /api/b", "POST /api/new"]);
    assert.equal([...kg.nodes.values()].filter(n => n.type === "route").length, 3);
    assertNoDanglingLinks(kg);
  });

  it("removes routes that disappeared from the app", () => {
    const kg = baseGraph();
    kg.replaceRouteSource("", routeSource("", [
      { method: "GET", uri: "api/keep", className: "CallsController" },
      { method: "POST", uri: "api/remove", className: "CallsController" },
    ]));
    assert.equal([...kg.nodes.values()].filter(n => n.type === "route").length, 2);

    kg.replaceRouteSource("", routeSource("", [
      { method: "GET", uri: "api/keep", className: "CallsController" },
    ]));

    assert.deepEqual(routeLabels(kg), ["GET /api/keep"]);
    assert.equal([...kg.nodes.values()].filter(n => n.type === "controller").length, 1);
    assertNoDanglingLinks(kg);
  });

  it("drops the stale method reference when a route's action changes", () => {
    const kg = baseGraph();
    const routeId = (kg2: KnowledgeGraph) =>
      [...kg2.nodes.values()].find(n => n.type === "route" && n.label === "POST /api/change")!.id;

    kg.replaceRouteSource("", routeSource("", [
      { method: "POST", uri: "api/change", className: "CallsController", methodName: "start" },
    ]));
    const currentId = routeId(kg);
    assert.deepEqual(methodTargets(kg, currentId), ["method_CallsController_start"]);

    kg.replaceRouteSource("", routeSource("", [
      { method: "POST", uri: "api/change", className: "CallsController", methodName: "stop" },
    ]));

    const nextId = routeId(kg);
    assert.deepEqual(methodTargets(kg, nextId), ["method_CallsController_stop"]);
    // Same position ⇒ same node ID is reused, but the previous target must be
    // gone: exactly one method reference, pointing at the new action.
    assert.equal(
      kg.edges.filter(e => e.source === nextId && e.target.startsWith("method_")).length,
      1,
    );
    assert.equal([...kg.nodes.values()].filter(n => n.type === "route").length, 1);
    assert.ok(
      !kg.edges.some(e => e.source === nextId && e.target === "method_CallsController_start"),
      "stale method reference survived the action change",
    );
    assertNoDanglingLinks(kg);
  });

  it("clears a project's routes when it reports a successful empty list", () => {
    const kg = baseGraph();
    kg.replaceRouteSource("", routeSource("", [
      { method: "GET", uri: "api/a", className: "CallsController" },
    ]));

    kg.replaceRouteSource("", routeSource("", []));

    assert.deepEqual(routeLabels(kg), []);
    assert.equal([...kg.nodes.values()].filter(n => n.type === "controller").length, 0);
    assert.equal(kg.edges.length, 0);
    assertNoDanglingLinks(kg);
  });

  it("replaces one project without touching another project's routes", () => {
    const kg = baseGraph();
    kg.replaceRouteSource("", routeSource("", [
      { method: "GET", uri: "api/root", className: "CallsController" },
    ]));
    kg.replaceRouteSource("backend:", routeSource("backend:", [
      { method: "GET", uri: "api/backend", className: "CallsController" },
      { method: "POST", uri: "api/backend-gone", className: "CallsController" },
    ]));

    kg.replaceRouteSource("backend:", routeSource("backend:", [
      { method: "GET", uri: "api/backend", className: "CallsController" },
    ]));

    assert.deepEqual(routeLabels(kg), ["GET /api/backend", "GET /api/root"]);
    const ids = [...kg.nodes.values()].filter(n => n.type === "route").map(n => n.id).sort();
    assert.deepEqual(ids, [
      "backend:route_1_GET__api_backend",
      "route_1_GET__api_root",
    ]);
    assertNoDanglingLinks(kg);
  });

  it("purges only route/controller nodes, not other nodes sharing the prefix", () => {
    const kg = baseGraph([
      ...methodNodes(["CallsController"]),
      // A real file whose relative path starts with "routes" — extraction owns
      // it, route replacement must not delete it.
      { id: "file_routes", label: "routes", type: "file", sourceFile: "routes" },
      { id: "route_like_function", label: "route", type: "function", sourceFile: "helpers.php" },
    ]);
    kg.replaceRouteSource("", routeSource("", [
      { method: "GET", uri: "api/a", className: "CallsController" },
    ]));

    assert.ok(kg.nodes.has("file_routes"), "file node named routes must survive");
    assert.ok(kg.nodes.has("route_like_function"), "non route/controller node must survive");
    assert.ok(kg.nodes.has("method_CallsController_start"), "controller method nodes must survive");
  });

  it("is idempotent across repeated replacements", () => {
    const kg = baseGraph();
    const source = routeSource("", [
      { method: "GET", uri: "api/a", className: "CallsController", methodName: "start" },
      { method: "POST", uri: "api/b", className: "CallsController", methodName: "stop" },
    ]);

    kg.replaceRouteSource("", source);
    const nodeCount = kg.nodes.size;
    const edgeCount = kg.edges.length;

    for (let i = 0; i < 3; i++) kg.replaceRouteSource("", source);

    assert.equal(kg.nodes.size, nodeCount);
    assert.equal(kg.edges.length, edgeCount);
    assertNoDanglingLinks(kg);
  });

  it("does not break merge()'s edge dedup for unrelated extractions", () => {
    const kg = baseGraph();
    kg.replaceRouteSource("", routeSource("", [
      { method: "GET", uri: "api/a", className: "CallsController" },
    ]));
    const before = kg.edges.length;

    const unrelated: ExtractionResult = {
      nodes: [{ id: "b_process", label: "process", type: "function", sourceFile: "b.ts" }],
      edges: [],
    };
    kg.merge(unrelated);
    assert.equal(kg.edges.length, before);
    assertNoDanglingLinks(kg);
  });
});
