# Cross-File Call Resolution Design

**Date:** 2026-07-27
**Status:** Draft
**Feature:** Resolve `$this->property->method()` and similar call patterns to actual class methods across files.

## Problem

The current knowledge graph extracts call edges that point to bare method names:

```
selfServeActivate —calls→ pauseStore
```

The target `pauseStore` is a node keyed to the local file, not to the actual class (`GrabMartStoreService.pauseStore`). When querying "what calls `GrabMartStoreService.pauseStore`" the graph returns nothing, even though `GrabMartController` calls it via `$this->storeService->pauseStore()`.

## Scope: Approach A (Property Injection + $this + Parameters)

| Pattern | Example | Resolution Source |
|---|---|---|
| `$this->prop->method()` | `$this->storeService->pauseStore()` | `@var` annotation or constructor type hint on `$storeService` |
| `$this->method()` | `$this->syncProducts()` | Same class — edge already resolves |
| `ClassName::method()` | `Log::info()` | `use` statement in file |
| `$obj->method()` (parameter) | `fn(StoreService $svc, $svc->get())` | Parameter type hint |
| `new ClassName->method()` | `(new GrabMartStoreService())->pause()` | Direct class name |

**Not in scope (future B):** local variables (`$x = new Service()`), `app(Service::class)`, facades, return type chaining.

## Architecture

Two new modules, zero changes to existing extractors.

```
┌─────────────────────────────┐
│      graph-out/             │
│  graph.json (11K nodes)     │
│  class-index.json (new)     │
└─────────────────────────────┘
         ▲                         
         │ build                    
┌────────┴──────────────┐   ┌──────────────────┐
│   src/class-index.ts   │   │  src/resolve.ts   │
│                        │   │                   │
│  buildClassIndex(kg)   │──▶│ resolveCalls(kg,  │
│  → writes class-index  │   │   classIndex)     │
│  → returns ClassIndex  │   │  → retargets      │
│                        │   │    call edges     │
└────────────────────────┘   └────────┬─────────┘
                                      │
                           integrated into refreshGraphIfStale()
```

### Module 1: `src/class-index.ts`

```typescript
interface PropertyInfo {
  name: string;        // e.g. "storeService"
  type: string | null; // e.g. "App\Services\Store\StoreService" (resolved from @var or constructor)
  sourceFile: string;
  nullable?: boolean;
}

interface MethodInfo {
  name: string;
  params: Array<{ name: string; type: string | null }>;
  returnType: string | null;
}

interface ClassInfo {
  name: string;           // e.g. "GrabMartStoreService"
  fullName: string;       // e.g. "App\Services\GrabMart\GrabMartStoreService"
  file: string;
  properties: Map<string, PropertyInfo>;
  methods: Map<string, MethodInfo>;
  imports: Map<string, string>;  // alias → full class name e.g. "Log" → "Illuminate\Support\Facades\Log"
}

interface ClassIndex {
  classes: Map<string, ClassInfo>;  // keyed by simple class name
  fileClasses: Map<string, string[]>; // file → list of class names defined there
}
```

**Algorithm:**
1. Iterate all graph nodes.
2. For each `type: "class"` node → create `ClassInfo` entry.
3. For each `type: "property"` node → extract `@var Type` from its `description` (PHPDoc), add to properties map.
4. For each `type: "method"` node → extract parameter types from label (PHP-Parser encodes these), add to methods map.
5. For each file that has a class node → find `type: "namespace"` children with `relation: "imports"` → fill imports map.
6. Serialize to `graph-out/class-index.json`.

**Property type extraction:** Types come from two sources:

1. **PHPDoc `@var`** — already captured in the node's `description` field (e.g., `@var array<string, int>`). Handles cases where type info is in docblocks.

2. **Native PHP typed properties** — `protected GrabMartStoreService $storeService;` — in Laravel controllers this is the dominant pattern. These are NOT in the `description` field because there's no PHPDoc. We extract them during class index build by parsing the property declaration from source using PHP-Parser (already available as a dependency) or a simple regex:
   ```regex
   /(?:public|protected|private|var)\s+([\w\\]+)\s+\$(\w+)/
   ```

3. **Constructor injection** — for each class, find methods named `__construct`. Parse parameter type hints (e.g., `StoreService $storeService` in `__construct(GrabMartStoreService $storeService)`). This catches Laravel-style constructor injection AND serves as fallback when the property declaration doesn't have a type hint but the constructor does (common in older PHP code).

### Module 2: `src/resolve.ts`

```typescript
function resolveCalls(kg: KnowledgeGraph, index: ClassIndex): void
```

**Algorithm:**
1. Build a reverse-lookup: `methodName → Set<ClassName>` from the class index (e.g., `pauseStore → [GrabMartStoreService, StoreController]`).
2. For each edge with `relation: "calls"`:
   a. Find the source node — it's a method like `GrabMartController.selfServeActivate`.
   b. Extract the class name from the source method label (everything before the `.`).
   c. Look up that class in the index.
   d. Examine the call target. Parse the call name from the edge target label.

   **Resolution rules (in order):**

   | Call pattern | How to resolve |
   |---|---|
   | `$this->method()` | Look up `method()` in the current class's own methods → retarget to same-class method node |
   | `$this->prop->method()` | Look up `prop` in current class's property type map → get type (e.g. `GrabMartStoreService`) → resolve short name via imports/namespace → find `Type.method()` in graph → retarget |
   | `ClassName::method()` | `ClassName` is a use import alias → resolve to FQCN → find `FQCN.method()` in graph. If alias not found, try current namespace + ClassName |
   | `$param->method()` (function/method parameter) | Look up `param` in current method's parameter types → resolve via imports/namespace → find `Type.method()` → retarget |
   | `new ClassName()->method()` | `ClassName` is a direct class reference → resolve same as static calls → retarget |
   
   e. If resolved: change the edge target from `nodeId(filePath, "methodName")` to `nodeId(targetFile, "ClassName.methodName")`.
   f. If not resolved: leave the edge as-is (unresolved calls are still useful as local references).

3. Remove the local method-name node if no remaining edges reference it (optional cleanup).

**Resolving the class name from type hints.**  
Type hints are typically short names like `GrabMartStoreService` — not fully qualified. To resolve them:
1. Check the file's `use` imports: `use App\Services\GrabMart\GrabMartStoreService` → `GrabMartStoreService` maps to that class.
2. If not imported, the file's namespace + short name → e.g., `App\Http\Controllers\GrabMartStoreService`.
3. If still not found, treat the short name as the class key (the class index uses short names as primary keys).

**Edge case: ambiguous method names.**  
If `pauseStore` exists in both `GrabMartStoreService` and `StoreController`, the resolver uses the property type to disambiguate. If property type is `GrabMartStoreService`, it resolves to that class. If still ambiguous (e.g., parent/child share a method name), keep the original edge.

### Integration: `refreshGraphIfStale()`

```typescript
// In src/refresh.ts, after route extraction, before buildSearchIndex:

import { buildClassIndex } from "./class-index.ts";
import { resolveCalls } from "./resolve.ts";

const classIndex = buildClassIndex(kg);
resolveCalls(kg, classIndex);
```

No changes needed to `mindplace-build.ts` — the refresh function handles both auto-sync and manual builds.

### Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Property `@var` missing but constructor injection exists | Use constructor parameter type |
| Neither `@var` nor constructor type | Leave edge unresolved |
| Multiple classes define the same method name | Use property type to disambiguate; if still ambiguous, keep unresolved |
| Call target doesn't exist in resolved class (e.g., call to `nonExistentMethod()`) | Leave edge unresolved — the original edge remains |
| Class index references a node that was deleted | Gracefully skip — edge stays unresolved |
| Same-file method call (`$this->syncProducts()`) | Resolves to current class — edge already correct, no change needed |

### Testing Plan

| Test | What to verify |
|---|---|
| `$this->storeService->pauseStore()` in GrabMartController | Edge retargeted to `GrabMartStoreService.pauseStore` |
| `$this->method()` in same class | Edge unchanged (already correct) |
| `Log::info()` with `use Illuminate\Support\Facades\Log` | Edge retargeted to `Log.info` from the imported class |
| Constructor injection | Property type inferred from `__construct(StoreService $storeService)` |
| Missing `@var` with no constructor | Edge left as-is |
| Ambiguous method names | Original edge preserved |
| No class index (fresh build) | Index built before resolution, no data loss |

### Performance

| Operation | Estimated time |
|---|---|
| Build class index (11K nodes) | ~30ms (in-memory Map iteration) |
| Resolve calls (~1,500 edges) | ~20ms (Map lookups only) |
| **Total added to refresh** | **~50ms** |
| Class index to disk (write) | ~10ms |

No file I/O for PHP files, no subprocess calls. Negligible impact on existing timings.

### Future: Approach B Extensions

The `class-index.ts` → `resolve.ts` pipeline is designed so that the index can grow richer without changing the resolution interface:

- Local variable type tracking → add to ClassInfo once inferred
- `app()` / `resolve()` resolution → add resolved types to the index
- Return type chaining → traverse method return types in the index
- Facade root resolution → map facade class to underlying service class

The resolution algorithm in `resolve.ts` only cares about `varName → className` — however that map is populated.
