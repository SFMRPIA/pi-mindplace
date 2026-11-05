/**
 * Vue SFC extraction (src/extract.ts → extractVue).
 *
 * Regression guard: `extractVue()` used to call `setLanguage(TsLang)` /
 * `setLanguage(JavaScript)` with names that exist nowhere in the module, so the
 * ReferenceError was swallowed by the surrounding try/catch and EVERY .vue file
 * degraded to a single bare `file` node — no symbols, no edges, no imports.
 * (ttl-crm alone has 561 .vue files affected.)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { detect } from "../src/detect.ts";
import { extract } from "../src/extract.ts";
import type { ExtractionResult, GraphNode } from "../src/types.ts";

const FIXTURES = resolve(import.meta.dirname ?? ".", "fixtures", "vue-project");

function extractAll(): ExtractionResult {
  const detected = detect(FIXTURES);
  return extract(FIXTURES, detected.files);
}

function nodesOf(result: ExtractionResult, file: string): GraphNode[] {
  return result.nodes.filter(n => n.sourceFile === file);
}

function labelsOf(result: ExtractionResult, file: string): string[] {
  return nodesOf(result, file).map(n => n.label);
}

function assertHasSymbol(result: ExtractionResult, file: string, symbol: string): void {
  const labels = labelsOf(result, file);
  assert.ok(
    labels.includes(symbol),
    `expected \`${symbol}\` from ${file}, got: [${labels.join(", ")}]`,
  );
}

describe("extractVue", () => {
  it("extracts symbols from a plain JavaScript script block", () => {
    const result = extractAll();
    const nodes = nodesOf(result, "Counter.vue");

    // The regression: exactly one node (the file itself) and nothing else.
    assert.ok(nodes.length > 1, `expected symbols inside Counter.vue, got ${nodes.length} node(s)`);
    assertHasSymbol(result, "Counter.vue", "increment");
  });

  it('extracts symbols from a lang="ts" script block', () => {
    const result = extractAll();

    assertHasSymbol(result, "Typed.vue", "renderLabel");
  });

  it('extracts symbols from a lang="tsx" script block', () => {
    const result = extractAll();

    // TSX must not be parsed as plain TS — JSX syntax would not parse there.
    assertHasSymbol(result, "Jsx.vue", "Widget");
  });

  it("keeps a single file node for an SFC without a script block", () => {
    const nodes = nodesOf(extractAll(), "NoScript.vue");

    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, "file");
  });

  it("keeps a single file node for an empty script block", () => {
    const nodes = nodesOf(extractAll(), "Empty.vue");

    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, "file");
  });

  it("does not throw on a malformed script block", () => {
    // A throw here would fail the whole extract() call, mirroring the crash
    // path the try/catch exists for.
    const result = extractAll();
    const nodes = nodesOf(result, "Broken.vue");

    assert.ok(nodes.length >= 1, "malformed script must still yield the file node");
  });

  it("emits import edges for relative imports inside a script block", () => {
    const result = extractAll();
    const imports = result.edges.filter(e => e.relation === "imports");

    assert.ok(
      imports.some(e => e.target.includes("format")),
      `expected an import edge to format.js, got: [${imports.map(e => e.target).join(", ")}]`,
    );
  });
});
