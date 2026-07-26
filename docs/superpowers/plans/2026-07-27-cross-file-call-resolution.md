# Cross-File Call Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `$this->storeService->pauseStore()` from a bare method-name edge to `GrabMartController → GrabMartStoreService.pauseStore`.

**Architecture:** 4 tasks — (1) add `callContext` to edge schema + PHP-Parser output, (2) build class index from graph + source files, (3) resolve call edges using class index + call context, (4) integrate into refresh and test.

**Tech Stack:** TypeScript, Node.js, PHP-Parser (nikic/php-parser v5), regex for source parsing.

## Global Constraints

- No new npm packages.
- TypeScript strict mode (existing).
- All changes under 100ms added to refresh (target: ~60ms).
- Property types from 3 sources: native typed properties (primary), PHPDoc `@var`, constructor injection (fallback).
- Class names resolved via: use imports → current namespace → direct short name.
- Option 2: retarget call edges in-place (replace old target, don't keep both).

---

### Task 1: Add call context to edges

**Problem:** The current PHP-Parser subprocess outputs only the method name for each call edge (e.g., `"pauseStore"`). There's no way to know if it was called via `$this->pauseStore()`, `$this->storeService->pauseStore()`, or `Log::info()`. We need this context for resolution.

**Files:**
- Modify: `src/types.ts` — add optional `callContext` to `GraphEdge`
- Modify: `bin/php-extract.php` — output receiver expression for each call
- Modify: `src/extract.ts` — preserve `callContext` during merge

- [ ] **Step 1: Add `callContext` to `GraphEdge` type**

```typescript
// src/types.ts — add to GraphEdge interface
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
  confidenceScore?: number;
  callContext?: string;  // NEW: receiver expression for call edges
  // Values: "$this->propName" (method on property),
  //         "ClassName" (static call),
  //         "$this" (same-class method call),
  //         "func" (global function call),
  //         omitted (unknown / not collected)
}
```

- [ ] **Step 2: Modify PHP-Parser to output call context**

In `bin/php-extract.php`, modify the `collectCalls()` visitor's `enterNode()` method to determine and output the receiver expression:

```php
// Inside the visitor's enterNode — for MethodCall nodes
if ($node instanceof Node\Expr\MethodCall) {
    $name = $node->name->name ?? (string)$node->name;
    if ($name) {
        // Determine receiver expression
        $receiver = $this->getReceiverExpr($node->var);
        $edge = [
            'source' => $this->sourceId,
            'target' => nodeId($this->relPath, $name),
            'relation' => 'calls',
            'confidence' => 'EXTRACTED',
        ];
        if ($receiver !== null) {
            $edge['callContext'] = $receiver;
        }
        $this->edges[] = $edge;
    }
}

// Add helper method to determine the receiver expression string
private function getReceiverExpr(Node\Expr $expr): ?string {
    if ($expr instanceof Node\Expr\Variable) {
        return '$' . $expr->name;
    }
    if ($expr instanceof Node\Expr\PropertyFetch) {
        $var = $expr->var instanceof Node\Expr\Variable ? '$' . $expr->var->name : (string)$expr->var;
        $prop = '$' . $expr->name->name ?? (string)$expr->name;
        // Simplify: "$this->storeService" → "$this->storeService"
        // Also handle: "$service->client" → keep as is
        return $var . '->' . ltrim($prop, '$');
    }
    if ($expr instanceof Node\Expr\StaticPropertyFetch) {
        return (string)$expr->class . '::$' . $expr->name;
    }
    // For complex expressions like function calls, just stringify
    return (string)$expr;
}
```

Also update StaticCall handling:

```php
if ($node instanceof Node\Expr\StaticCall) {
    $name = $node->name->name ?? (string)$node->name;
    $class = $node->class instanceof Node\Name ? $node->class->getLast() : (string)$node->class;
    if ($name && $class !== 'parent' && $class !== 'self' && $class !== 'static') {
        $edge = [
            'source' => $this->sourceId,
            'target' => nodeId($this->relPath, $name),
            'relation' => 'calls',
            'confidence' => 'EXTRACTED',
            'callContext' => $class,  // the class name for static calls
        ];
        $this->edges[] = $edge;
    }
}
```

- [ ] **Step 3: Preserve `callContext` in the merge step**

In `src/extract.ts`, the dual-pass merge currently filters out tree-sitter's call/import edges and replaces them with PHP-Parser's. This code already uses a spread operator that will pass through `callContext` automatically:

```typescript
const mergedEdges = [
  ...tsResult.edges.filter(e => e.relation !== "calls" && e.relation !== "imports"),
  ...ppResult.edges,  // PHP-Parser edges now include callContext — spread passes it through
];
```

No code change needed — the existing spread will carry `callContext` automatically since TypeScript interfaces are structural.

- [ ] **Step 4: Verify the output**

Run extraction on a known file and check that call edges include `callContext`:

```bash
cd "D:/laragon/www/pi-mindplace"
node -e "
import { extractFile } from './src/extract.ts';
const r = extractFile('app/Http/Controllers/GrabMartController.php', 'D:/laragon/www/mynews/mynews-order-monitoring-backend');
const calls = r.edges.filter(e => e.relation === 'calls');
console.log('Total call edges:', calls.length);
console.log('With callContext:', calls.filter(e => e.callContext).length);
console.log('Sample:', JSON.stringify(calls.slice(0, 5), null, 2));
"
```

Expected output: edges like `{ "target": "…_pauseStore", "callContext": "$this->storeService" }` and `{ "target": "…_info", "callContext": "Log" }`.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts bin/php-extract.php
git commit -m "feat: add callContext to call edges for cross-file resolution"
```

---

### Task 2: Create class-index.ts

**Files:**
- Create: `src/class-index.ts`

**Interfaces:**
- Produces: `buildClassIndex(cwd: string, kg: KnowledgeGraph) → ClassIndex`
- Produces: `saveClassIndex(cwd: string, index: ClassIndex) → void`
- Produces: `loadClassIndex(cwd: string) → ClassIndex | null`

- [ ] **Step 1: Define types**

```typescript
// src/class-index.ts

export interface PropertyInfo {
  name: string;         // "$storeService"
  type: string | null;  // "GrabMartStoreService" (short name or FQCN)
}

export interface MethodInfo {
  name: string;         // "pauseStore"
  params: Array<{ name: string; type: string | null }>;
}

export interface ClassInfo {
  name: string;         // "GrabMartStoreService"
  file: string;
  namespce: string;     // "App\Services\GrabMart"
  properties: Map<string, PropertyInfo>;
  methods: Map<string, MethodInfo>;
  imports: Map<string, string>;  // alias → FQCN: "Log" → "Illuminate\Support\Facades\Log"
}

export interface ClassIndex {
  classes: Map<string, ClassInfo>;
  methodIndex: Map<string, string[]>;  // methodName → [className, ...]
}
```

- [ ] **Step 2: Collect class/import info from graph**

```typescript
export function buildClassIndex(cwd: string, kg: KnowledgeGraph): ClassIndex {
  const classes = new Map<string, ClassInfo>();
  const fileClasses = new Map<string, string[]>();  // file → class names

  // Pass 1: collect class nodes and file→class mapping
  for (const [, node] of kg.nodes) {
    if (node.type === "class" && node.sourceFile) {
      const ci: ClassInfo = {
        name: node.label,
        file: node.sourceFile,
        namespce: "",
        properties: new Map(),
        methods: new Map(),
        imports: new Map(),
      };
      classes.set(node.label, ci);

      if (!fileClasses.has(node.sourceFile)) fileClasses.set(node.sourceFile, []);
      fileClasses.get(node.sourceFile)!.push(node.label);
    }
  }

  // Pass 2: collect imports from file→namespace edges
  // Import edges: source=fileId, target=namespaceNode, relation="imports"
  // The namespace node's label is the FQCN (e.g. "App\Services\GrabMart\GrabMartStoreService")
  // The short name is the last segment
  for (const edge of kg.edges) {
    if (edge.relation !== "imports") continue;
    const srcNode = kg.nodes.get(edge.source);
    if (!srcNode || srcNode.type !== "file") continue;

    const file = srcNode.label;
    const clses = fileClasses.get(file);
    if (!clses) continue;

    const nsNode = kg.nodes.get(edge.target);
    if (!nsNode) continue;
    const fqcn = nsNode.label;
    const short = fqcn.split("\\").pop() ?? fqcn;

    for (const clsName of clses) {
      const ci = classes.get(clsName);
      if (ci) ci.imports.set(short, fqcn);
    }
  }

  // Pass 3: collect namespace declarations
  // Namespace nodes with a "contains" edge from the file (not "imports")
  for (const edge of kg.edges) {
    if (edge.relation !== "contains") continue;
    const srcNode = kg.nodes.get(edge.source);
    const tgtNode = kg.nodes.get(edge.target);
    if (srcNode?.type === "file" && tgtNode?.type === "namespace") {
      const clses = fileClasses.get(srcNode.label);
      if (clses) {
        for (const clsName of clses) {
          const ci = classes.get(clsName);
          if (ci && !ci.namespce) ci.namespce = tgtNode.label;
        }
      }
    }
  }

  // Pass 4: collect methods from graph
  for (const [, node] of kg.nodes) {
    if (node.type !== "method" || !node.sourceFile) continue;
    const clses = fileClasses.get(node.sourceFile);
    if (!clses) continue;
    const ci = classes.get(clses[0]);
    if (!ci) continue;

    // Label is "ClassName.methodName"
    const dot = node.label.lastIndexOf(".");
    const methodName = dot >= 0 ? node.label.slice(dot + 1) : node.label;
    ci.methods.set(methodName, { name: methodName, params: [] });
  }

  // Pass 5: extract property types from source files
  for (const file of fileClasses.keys()) {
    const clses = fileClasses.get(file)!;
    const ci = classes.get(clses[0]);
    if (!ci) continue;

    const absPath = resolve(cwd, file);
    let source: string;
    try { source = readFileSync(absPath, "utf-8"); }
    catch { continue; }

    // Native typed properties: protected GrabMartStoreService $storeService;
    const propRe = /(?:public|protected|private|var)\s+([\w\\]+)\s+\$(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = propRe.exec(source)) !== null) {
      ci.properties.set("$" + m[2], { name: "$" + m[2], type: m[1] });
    }

    // PHPDoc @var (fallback for properties without native types)
    const phpdocRe = /@var\s+([\w\\]+)\s+\$(\w+)/g;
    while ((m = phpdocRe.exec(source)) !== null) {
      const name = "$" + m[2];
      if (!ci.properties.has(name)) {
        ci.properties.set(name, { name, type: m[1] });
      }
    }

    // Constructor injection (last fallback)
    const ctorRe = /function\s+__construct\s*\(([^)]*)\)/s;
    const ctorMatch = ctorRe.exec(source);
    if (ctorMatch) {
      const paramRe = /([\w\\]+)\s+\$(\w+)/g;
      while ((m = paramRe.exec(ctorMatch[1])) !== null) {
        const name = "$" + m[2];
        if (!ci.properties.has(name)) {
          ci.properties.set(name, { name, type: m[1] });
        }
      }
    }
  }

  // Build reverse method index
  const methodIndex = new Map<string, string[]>();
  for (const [clsName, ci] of classes) {
    for (const methodName of ci.methods.keys()) {
      if (!methodIndex.has(methodName)) methodIndex.set(methodName, []);
      methodIndex.get(methodName)!.push(clsName);
    }
  }

  return { classes, methodIndex };
}
```

- [ ] **Step 3: Implement `resolveShortName()` helper**

```typescript
export function resolveShortName(
  shortName: string,
  imports: Map<string, string>,
  currentNs: string,
): string | null {
  if (imports.has(shortName)) return imports.get(shortName)!;
  if (currentNs) return currentNs + "\\" + shortName;
  return shortName;  // best-effort: use short name directly
}
```

- [ ] **Step 4: Implement `saveClassIndex()` and `loadClassIndex()`**

```typescript
const INDEX_FILE = "class-index.json";

export function saveClassIndex(cwd: string, index: ClassIndex): void {
  const outDir = join(cwd, "graph-out");
  mkdirSync(outDir, { recursive: true });
  // Convert Maps to plain objects for JSON serialization
  const data = {
    classes: Array.from(index.classes.entries()).map(([k, v]) => [
      k,
      { ...v, properties: Array.from(v.properties.entries()), methods: Array.from(v.methods.entries()), imports: Array.from(v.imports.entries()) },
    ]),
    methodIndex: Array.from(index.methodIndex.entries()),
  };
  writeFileSync(join(outDir, INDEX_FILE), JSON.stringify(data), "utf-8");
}

export function loadClassIndex(cwd: string): ClassIndex | null {
  const p = join(cwd, "graph-out", INDEX_FILE);
  if (!existsSync(p)) return null;
  const data = JSON.parse(readFileSync(p, "utf-8"));
  return {
    classes: new Map(data.classes.map(([k, v]: [string, any]) => [
      k,
      { ...v, properties: new Map(v.properties), methods: new Map(v.methods), imports: new Map(v.imports) },
    ])),
    methodIndex: new Map(data.methodIndex as [string, string[]][]),
  };
}
```

- [ ] **Step 5: Verify class index building**

Run the index builder on the Laravel project and validate key entries:

```
Expected:
- GrabMartController properties: $storeService → GrabMartStoreService, $menuService → MenuService, etc.
- GrabMartController imports: includes "Log" → "Illuminate\Support\Facades\Log" (if used)
- GrabMartStoreService methods: pauseStore, createSelfServeJourney, etc.
```

- [ ] **Step 6: Commit**

```bash
git add src/class-index.ts
git commit -m "feat: add class index builder with property type extraction"
```

---

### Task 3: Create resolve.ts

**Files:**
- Create: `src/resolve.ts`
- Modify: `src/types.ts` (already done in Task 1)

**Interfaces:**
- Consumes: `ClassIndex` from Task 2, `KnowledgeGraph` (existing)
- Produces: `resolveCalls(kg: KnowledgeGraph, index: ClassIndex) → number` (count of resolved edges)

- [ ] **Step 1: Implement `resolveCalls()`**

```typescript
export function resolveCalls(kg: KnowledgeGraph, index: ClassIndex): number {
  let resolved = 0;

  for (const edge of kg.edges) {
    if (edge.relation !== "calls") continue;

    // Get source method node
    const srcNode = kg.nodes.get(edge.source);
    if (!srcNode || srcNode.type !== "method") continue;

    // Extract source class name from method label "GrabMartController.selfServeActivate"
    const label = srcNode.label;
    const dot = label.lastIndexOf(".");
    const srcClass = dot >= 0 ? label.slice(0, dot) : null;
    if (!srcClass) continue;

    const ci = index.classes.get(srcClass);
    if (!ci) continue;

    // Get call method name from the target node label
    const tgtNode = kg.nodes.get(edge.target);
    if (!tgtNode) continue;
    const methodName = tgtNode.label;

    // Resolve based on callContext
    const ctx = edge.callContext;
    let resolvedClass: string | null = null;

    if (!ctx || ctx === "$this") {
      // $this->method() — same class
      if (ci.methods.has(methodName)) {
        resolvedClass = ci.name;
      }
    } else if (ctx && ctx.startsWith("$this->")) {
      // $this->prop->method() — look up property type
      const propName = "$" + ctx.slice("$this->".length);
      const propInfo = ci.properties.get(propName);
      if (propInfo && propInfo.type) {
        // Resolve short name to full class
        const fqcn = resolveShortName(propInfo.type, ci.imports, ci.namespce);
        if (fqcn) {
          // Find the class in the index (by short name or FQCN)
          const targetClass = index.classes.get(propInfo.type) ?? index.classes.get(fqcn);
          if (targetClass && targetClass.methods.has(methodName)) {
            resolvedClass = propInfo.type;  // Use short name as key
          }
        }
      }
    } else if (ctx && !ctx.startsWith("$") && !ctx.startsWith("$")) {
      // Static call: ClassName::method() — ctx is the class name
      const fqcn = resolveShortName(ctx, ci.imports, ci.namespce);
      if (fqcn) {
        const targetClass = index.classes.get(ctx) ?? index.classes.get(fqcn);
        if (targetClass && targetClass.methods.has(methodName)) {
          resolvedClass = ctx;
        }
      }
    }

    // Retarget edge if resolved
    if (resolvedClass) {
      const targetMethodLabel = resolvedClass + "." + methodName;
      // Find the method node in the graph
      const methodNode = findMethodNode(kg, resolvedClass, methodName);
      if (methodNode) {
        edge.target = methodNode.id;
        resolved++;
      } else {
        // Method node doesn't exist yet — create a placeholder
        // This shouldn't happen since the graph should have all class methods
        // But handle gracefully
        const file = index.classes.get(resolvedClass)?.file ?? srcNode.sourceFile ?? "";
        const newId = `${resolvedClass}.${methodName}`.replace(/[^a-zA-Z0-9_$]/g, "_");
        const existing = kg.nodes.get(newId);
        if (!existing) {
          kg.nodes.set(newId, {
            id: newId,
            label: targetMethodLabel,
            type: "method",
            sourceFile: file,
          });
          kg.adjacency.set(newId, new Set());
        }
        edge.target = newId;
        resolved++;
      }
    }
  }

  return resolved;
}

function findMethodNode(kg: KnowledgeGraph, className: string, methodName: string): GraphNode | undefined {
  const label = className + "." + methodName;
  for (const [, node] of kg.nodes) {
    if (node.type === "method" && node.label === label) {
      return node;
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Handle guard clauses and edge cases**

```typescript
// Guard clauses (in order in resolveCalls):

// 1. callContext is missing → same as "$this" (backward compat)
// 2. Method not found in any class → leave edge unresolved
// 3. Property type not found in class index → leave edge unresolved
// 4. Property type found but method doesn't exist on target class → leave edge unresolved
// 5. Multiple classes define the same method name, property type disambiguates →
//    use property type to pick the correct class
// 6. Static call on a class that doesn't exist in the index → leave edge unresolved
// 7. Retargeted edge target may not exist as a node in kg → create placeholder node
```

- [ ] **Step 3: Verify resolution on real data**

Extract + build class index + resolve on the Laravel project:

```
Expected resolution counts (approximate):
- $this->storeService->pauseStore() → GrabMartStoreService.pauseStore ✓
- $this->storeService->getStoreHours() → GrabMartStoreService.getStoreHours ✓
- $this->storeService->createSelfServeJourney() → GrabMartStoreService.createSelfServeJourney ✓
- $this->menuService->... → MenuService. ... ✓
- Log::info() → (no Log facade class in index — may not resolve)
```

- [ ] **Step 4: Commit**

```bash
git add src/resolve.ts
git commit -m "feat: add cross-file call resolver using class index and callContext"
```

---

### Task 4: Integration and testing

**Files:**
- Modify: `src/refresh.ts` — add class index build + resolution after route extraction
- Test: run full pipeline on the Laravel project

- [ ] **Step 1: Integrate into `refreshGraphIfStale()`**

```typescript
// In src/refresh.ts, add imports:
import { buildClassIndex, saveClassIndex } from "./class-index.ts";
import { resolveCalls } from "./resolve.ts";

// After route extraction, before buildSearchIndex:
const classIndex = buildClassIndex(cwd, kg);
const resolvedCount = resolveCalls(kg, classIndex);
saveClassIndex(cwd, classIndex);
console.log(`Cross-file call resolution: ${resolvedCount} edges retargeted`);
```

- [ ] **Step 2: Run full end-to-end test**

```bash
cd "D:/laragon/www/pi-mindplace"
node --input-type=module -e "
import { refreshGraphIfStale } from './src/refresh.ts';
import { resolveCalls, findMethodNode } from './src/resolve.ts';
import { buildClassIndex } from './src/class-index.ts';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = 'D:/laragon/www/mynews/mynews-order-monitoring-backend';

// Trigger full refresh
const r = await refreshGraphIfStale(root);
console.log('Refresh:', JSON.stringify(r));

// Load the graph and check specific edge resolution
const raw = JSON.parse(readFileSync(join(root, 'graph-out/graph.json'), 'utf-8'));
const calls = raw.edges.filter(e => e.relation === 'calls');
const resolvedCalls = calls.filter(e => e.target.includes('.'));
console.log('')
console.log('Total calls:', calls.length);
console.log('Resolved (has .):', resolvedCalls.length);

// Find pauseStore call
for (const e of resolvedCalls) {
    const src = raw.nodes.find(n => n.id === e.source);
    const tgt = raw.nodes.find(n => n.id === e.target);
    if (tgt && tgt.label.includes('pauseStore')) {
        console.log('pauseStore resolved:', src?.label, '→', tgt?.label);
    }
}
"
```

Expected output:
```
Refresh: {"refreshed":true,...}
Total calls: ~1500
Resolved: ~200-400
pauseStore resolved: GrabMartController.selfServeActivate → GrabMartStoreService.pauseStore
```

- [ ] **Step 3: Reinstall extension**

```bash
pi remove "D:/laragon/www/pi-mindplace" && pi install "D:/laragon/www/pi-mindplace"
```

- [ ] **Step 4: Final commit**

```bash
git add src/refresh.ts
git commit -m "feat: integrate cross-file call resolution into graph refresh"
git push origin main
```

---

### Verification Checklist

- [ ] `callContext` appears on call edges from PHP-Parser (Task 1)
- [ ] `class-index.json` written to `graph-out/` (Task 2)
- [ ] Class index has correct properties for GrabMartController (Task 2)
- [ ] `$this->storeService->pauseStore()` resolves to `GrabMartStoreService.pauseStore` (Task 3)
- [ ] `$this->method()` edges stay unchanged (Task 3)
- [ ] Resolution runs on every graph refresh (Task 4)
- [ ] Unresolved calls (missing property type, ambiguous) left as-is (Task 3)
- [ ] No regressions in existing graph queries (Task 4)
