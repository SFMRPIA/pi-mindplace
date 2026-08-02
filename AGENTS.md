# pi-mindplace — Knowledge Graph Extension (fork)

Code knowledge graph for Pi. ONE graph per project root (monorepo-aware), auto-refreshed by a file watcher, queried with native tools. Fork of the original pi-mindplace with monorepo + accuracy + freshness improvements.

## How the agent should use this system

### Query-first discipline (enforced by the extension's prompt injection)

1. `mindplace_query` FIRST for any structure/relationship/data-flow question — never grep/read your way through the codebase when the graph can answer.
2. `mindplace_explain` to drill into one entity; `mindplace_impact` for "what breaks if I change X"; `mindplace_search` for symbol lookup.
3. Read raw files LAST (exact implementation, edits) — results include verbatim source snippets so you usually don't need to.

### What it knows (and doesn't)

- **Exact**: files, symbols, imports/inheritance, Laravel routes (live `php artisan route:list`, byte-exact), no duplicate nodes/edges
- **Approximate**: call edges resolve to ~12% of syntactic call sites (vendor/Eloquent/facade magic is correctly unlinked — not a bug); query ranking is lexical (TF-IDF + exact-label boost), not semantic
- **Ignored at detection**: `vendor`, `node_modules`, `dist`, `build`, `storage`, `test-results`, dotfiles, `graph-out`
- Tests are de-weighted in ranking; god nodes exclude test files

## Monorepo behavior

- **One graph at the monorepo root** (`<root>/graph-out/graph.json`) covering all subprojects — never per-folder graphs.
- Node paths are root-relative with subproject prefixes (`mynews-order-monitoring-backend/app/...`) so projects never collide.
- **Parent walk-up** (`findGraphRoot`, `src/paths.ts`): queries from any subfolder resolve the root graph automatically.
- Laravel subprojects get route extraction each (IDs prefixed `<projname>:`); a stray `artisan` wrapper without `composer.json` is skipped.
- **DANGER**: pointing tools at a container root (e.g. `D:/laragon/www` with ~40 unrelated projects) detects/extracts EVERYTHING and runs artisan in every Laravel subdir — always use a project root like `mynews`.

## Freshness (automatic)

- **File watcher** (`src/watcher.ts`): lazy-started on first query; 2s debounce; edits land in the graph within ~2-4s. Watcher is `unref()`'d — it never keeps a process alive.
- **Staleness banner**: results show `⚠️ N file(s) changed in the last ~2s` when the debounce hasn't flushed.
- **Fast fresh path**: with the watcher active, fresh queries skip route re-extraction (~200ms instead of ~3s).
- Queries can never fail from graph staleness — refresh happens lazily and safely.

## Tools

| Tool | Use |
|---|---|
| `mindplace_build` | Build/rebuild (`path=<project root>`, `force=true` for full rebuild) |
| `mindplace_query` | Structure questions (budget/minScore params) |
| `mindplace_explain` | One entity + connections |
| `mindplace_search` | FTS5 symbol search |
| `mindplace_impact` | Reverse dependency tree (depth ≤5) |

## Key internals (for maintainers)

| File | Role |
|---|---|
| `src/graph.ts` | `KnowledgeGraph` — adjacency, PageRank, communities, `merge()` (edge-deduped!) |
| `src/extract.ts` | Tree-sitter extraction; PHP dual-pass (tree-sitter + `bin/php-extract.php` via global `php`) |
| `src/routes.ts` | Laravel route extraction per subproject (artisan `route:list`) |
| `src/refresh.ts` | Staleness check (ALL files' mtimes) + rebuild; watcher hook |
| `src/watcher.ts` | Debounced fs.watch, pending-changes banner |
| `src/query.ts` | TF-IDF + exact-label boost + source snippets |
| `src/class-index.ts` | Property/method index; assignment inference (`$this->x = new Foo`) |

## Critical invariants (do not regress)

1. **Edge dedup**: `merge()` and route merging must never grow `edges[]` with duplicates (graph.json stays stable across watcher syncs — regression test `tests/graph.test.ts` "deduplicates edges on repeated merges").
2. **No node duplication**: PHP dual-pass node IDs must match tree-sitter's (relPath passed as `$argv[2]` to `bin/php-extract.php`).
3. **Watcher safety**: `watcher.unref()`, errors swallowed (lazy refresh still covers), ignore `storage/`+`test-results/` writes.
4. **Monorepo root**: never build per-folder graphs; `findGraphRoot` walk-up everywhere.

## Development

```bash
npm test   # node --test tests/*.test.ts (glob breaks on Windows — run files individually)
```
- Pre-existing failures on clean HEAD (env-related, unrelated): `extract.test.ts` "import edges", `detect.test.ts` "absolute root path".
- Windows/CRLF: use `ctx_edit` for edits; `write` creates LF (git autocrlf normalizes).
- `graph-out/` is gitignored — build artifacts never committed.

## Commits

Lowercase conventional commits (`feat:`/`fix:`/`perf:`/`docs:`).
