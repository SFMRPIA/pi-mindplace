/**
 * Tests for Laravel route extraction (src/routes.ts).
 *
 * Each test writes a throwaway "Laravel app" — `composer.json` + an `artisan`
 * script that echoes a JSON payload (no framework needed) — and lets
 * extractRoutes() run it through a real PHP binary, because the PHP binary is
 * what extractRoutes actually executes.
 *
 * The important contract: `sources` reports only projects whose route list was
 * successfully obtained. A failed artisan run or unparseable output must NOT
 * look like "this project has zero routes", otherwise a transient failure would
 * wipe the graph's route nodes.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRoutes } from "../src/routes.ts";
import type { GraphNode } from "../src/types.ts";

/** True when a PHP binary extractRoutes() could use is runnable. */
function phpRunnable(): boolean {
  const candidates = ["php"];
  const roots = [process.env.LARAGON_DIR, "D:/laragon", "C:/laragon", "E:/laragon"]
    .filter(Boolean) as string[];
  for (const root of roots) {
    try {
      for (const dir of readdirSync(join(root, "bin", "php"))) {
        candidates.push(join(root, "bin", "php", dir, "php.exe"));
      }
    } catch {
      /* no Laragon install at this root */
    }
  }
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "ignore", timeout: 20000 });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

const HAS_PHP = phpRunnable();
const SKIP = HAS_PHP ? false : "no runnable php binary";

interface RouteSpec {
  method: string;
  uri: string;
  name?: string | null;
  action?: string;
  middleware?: string[];
}

const tempRoots: string[] = [];

/**
 * Create a throwaway Laravel-shaped project.
 *
 * `payload` is the JSON text the fake artisan prints; pass `null` to make
 * artisan fail, or any invalid text to test unparseable output.
 */
function makeApp(payload: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "mindplace-routes-"));
  tempRoots.push(root);
  writeFileSync(join(root, "composer.json"), "{}");
  if (payload === null) {
    // Non-zero exit — closest analogue of a broken/missing Laravel app.
    writeFileSync(join(root, "artisan"), "<?php exit(1);\n");
  } else {
    writeFileSync(join(root, "routes.json"), payload);
    writeFileSync(
      join(root, "artisan"),
      "<?php echo file_get_contents(__DIR__ . '/routes.json');\n",
    );
  }
  return root;
}

function routeList(routes: RouteSpec[]): string {
  return JSON.stringify(
    routes.map(route => ({
      method: route.method,
      uri: route.uri,
      name: route.name ?? null,
      // Closure routes are skipped by extractRoutes, so default to a real
      // controller action unless a test needs a specific one.
      action: route.action ?? "App\\Http\\Controllers\\HomeController@index",
      middleware: route.middleware ?? [],
    })),
  );
}

function cleanup(): void {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

const controllerMethod: GraphNode = {
  id: "method_VoIPController_newCall",
  label: "VoIPController.newCall",
  type: "method",
  sourceFile: "modules/Calls/app/Http/Controllers/Api/VoIPController.php",
};

describe("extractRoutes", { skip: SKIP }, () => {
  it("reports one source per successfully extracted project", () => {
    const root = makeApp(routeList([
      { method: "POST", uri: "api/voip/call", name: "voip.call", middleware: ["api"] },
      { method: "GET", uri: "api/voip/token", middleware: ["api"] },
    ]));
    try {
      const result = extractRoutes(root, [controllerMethod]);

      assert.equal(result.sources.length, 1);
      assert.equal(result.sources[0].prefix, "");
      assert.deepEqual(
        result.sources[0].nodes.filter(n => n.type === "route").map(n => n.label).sort(),
        ["GET /api/voip/token", "POST /api/voip/call"],
      );
      // The flattened result mirrors the per-source one (callers may use either).
      assert.equal(result.nodes.length, result.sources[0].nodes.length);
      assert.equal(result.edges.length, result.sources[0].edges.length);
    } finally {
      cleanup();
    }
  });

  it("links routes to existing controller method nodes", () => {
    const root = makeApp(routeList([
      {
        method: "POST",
        uri: "api/voip/call",
        action: "Modules\\Calls\\Http\\Controllers\\Api\\VoIPController@newCall",
      },
    ]));
    try {
      const result = extractRoutes(root, [controllerMethod]);
      const routeId = result.nodes.find(n => n.type === "route")!.id;

      const targets = result.edges.filter(e => e.source === routeId).map(e => e.target).sort();
      assert.deepEqual(targets, ["method_VoIPController_newCall", "route_controller_VoIPController"]);

      const controller = result.nodes.find(n => n.type === "controller")!;
      assert.equal(controller.label, "VoIPController");
    } finally {
      cleanup();
    }
  });

  it("treats an empty route list as a successful extraction", () => {
    const root = makeApp("[]");
    try {
      const result = extractRoutes(root, []);

      // A source with zero nodes is deliberately distinct from "no source":
      // the caller clears that project's routes instead of keeping stale ones.
      assert.equal(result.sources.length, 1);
      assert.deepEqual(result.sources[0].nodes, []);
      assert.deepEqual(result.sources[0].edges, []);
    } finally {
      cleanup();
    }
  });

  it("reports no source when artisan fails", () => {
    const root = makeApp(null);
    try {
      const result = extractRoutes(root, [controllerMethod]);

      assert.deepEqual(result.sources, []);
      assert.deepEqual(result.nodes, []);
      assert.deepEqual(result.edges, []);
    } finally {
      cleanup();
    }
  });

  it("reports no source when artisan output does not parse", () => {
    const root = makeApp("this is not json");
    try {
      const result = extractRoutes(root, [controllerMethod]);

      assert.deepEqual(result.sources, []);
      assert.deepEqual(result.nodes, []);
    } finally {
      cleanup();
    }
  });

  it("reports no source when the payload is not an array", () => {
    const root = makeApp('{"error":"route:list failed"}');
    try {
      const result = extractRoutes(root, []);

      assert.deepEqual(result.sources, []);
      assert.deepEqual(result.nodes, []);
    } finally {
      cleanup();
    }
  });

  it("gives moved routes new sequential ids but stable labels", () => {
    const firstPayload = routeList([
      { method: "GET", uri: "api/a" },
      { method: "POST", uri: "api/b" },
    ]);
    const root = makeApp(firstPayload);
    try {
      const first = extractRoutes(root, []);
      const firstIds = first.nodes.filter(n => n.type === "route").map(n => n.id).sort();

      // Same two routes, one inserted at the top — positions shift.
      writeFileSync(join(root, "routes.json"), routeList([
        { method: "POST", uri: "api/new" },
        { method: "GET", uri: "api/a" },
        { method: "POST", uri: "api/b" },
      ]));
      const second = extractRoutes(root, []);
      const secondIds = second.nodes.filter(n => n.type === "route").map(n => n.id).sort();

      assert.notDeepEqual(firstIds, secondIds);
      // Labels are what make replacing (not merging) the correct strategy.
      assert.deepEqual(
        second.nodes.filter(n => n.type === "route").map(n => n.label).sort(),
        ["GET /api/a", "POST /api/b", "POST /api/new"],
      );
    } finally {
      cleanup();
    }
  });

  it("keeps monorepo sub-projects isolated by prefix", () => {
    const root = makeApp(routeList([{ method: "GET", uri: "api/root" }]));
    try {
      const backend = join(root, "backend");
      mkdirSync(backend);
      writeFileSync(join(backend, "composer.json"), "{}");
      writeFileSync(join(backend, "routes.json"), routeList([{ method: "GET", uri: "api/backend" }]));
      writeFileSync(
        join(backend, "artisan"),
        "<?php echo file_get_contents(__DIR__ . '/routes.json');\n",
      );

      const result = extractRoutes(root, []);
      const prefixes = result.sources.map(s => s.prefix).sort();
      assert.deepEqual(prefixes, ["", "backend:"]);

      const ids = result.nodes.filter(n => n.type === "route").map(n => n.id).sort();
      assert.deepEqual(ids, ["backend:route_1_GET__api_backend", "route_1_GET__api_root"]);
    } finally {
      cleanup();
    }
  });
});
