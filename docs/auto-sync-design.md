# Auto-Sync Knowledge Graph on Query

## Problem

The mindplace knowledge graph requires a manual `mindplace_build` command to be kept up-to-date. When files change (during a session or between sessions), queries return stale data. The current workaround is a staleness warning injected into the system prompt telling the agent to rebuild — but the agent may ignore it or the user may not notice.

## Solution

Before every `mindplace_query` or `mindplace_explain` call, check if the graph is stale and silently refresh it if needed. The user never sees stale data and never has to remember to rebuild.

## Design

### Shared function: `refreshGraphIfStale(cwd)`

Located in `index.ts` alongside the existing `checkStaleness()` function.

```
refreshGraphIfStale(cwd)
  if no graph exists:
    → full build (detect all files, extract all, build graph, save)
    → return true (built)
  
  if graph exists and checkStaleness(cwd).stale:
    → detect files
    → extract changed files (SHA256 cache skips unchanged ones)
    → load existing graph
    → merge new extraction
    → computeCentrality + detectCommunities
    → save graph.json
    → return true (refreshed)
  
  return false (already fresh)
```

### Entry points

1. `mindplace_query.execute()` — call `refreshGraphIfStale(ctx.cwd)` as first step
2. `mindplace_explain.execute()` — same
3. `before_agent_start` — remove stale warning from injected prompt (no longer needed)

### Error handling

If the rebuild fails (PHP-Parser crash, disk error, etc.), log the error silently and fall back to the existing graph. The query still works — it just may be on slightly stale data. Never break the user's query because of a sync failure.

## Latency

- **No changes since last query**: ~0ms (just the mtime check)
- **1-2 files changed**: ~600ms (re-extract via PHP-Parser + merge)
- **Full build (no graph exists)**: ~2s (all files)

The SHA256 extract cache means only genuinely changed files are re-parsed.

## Files changed

- `index.ts` — add `refreshGraphIfStale()` function, update `before_agent_start` hook
- `src/tools/mindplace-query.ts` — call `refreshGraphIfStale()` at start
- `src/tools/mindplace-explain.ts` — call `refreshGraphIfStale()` at start
