# Feature Spec: Indexing Throttle

**Status:** Planned
**Created:** 2026-02-08
**Last Updated:** 2026-02-08

## Overview

Make background indexing invisible to the user by yielding to the main thread between files, pausing while the user is typing, and capping how many files each reconciliation pass processes.

## Problem Statement

The `indexFiles()` loop in `vector-store.ts` is a tight `for` loop with no yields to the main thread. Each iteration does synchronous Orama insert/remove operations plus an async Ollama HTTP call. While the Ollama call is async (it `await`s a `fetch`), the Orama operations before and after it are synchronous and CPU-intensive for large indexes.

On a ~2,000-file vault, the user experiences a visible typing stutter every 60 seconds when periodic reconciliation kicks in. Even event-driven indexing (3-second debounce) causes micro-freezes when multiple files are queued.

The root cause is that the renderer thread — which handles both UI repaints and our indexing logic — never gets a chance to process input events or repaint during a batch.

## Solution

Three orthogonal mechanisms, each addressing a different aspect:

### 1. Yield Between Files

**Where:** `vector-store.ts` → `indexFiles()` loop

After processing each file (both phases), yield back to the event loop:

```typescript
// At the end of each file iteration, yield to the renderer
await new Promise(resolve => setTimeout(resolve, 0));
```

This inserts a macrotask boundary, allowing the browser to:
- Process pending input events (keystrokes, mouse clicks)
- Run requestAnimationFrame callbacks
- Repaint the UI

**Cost:** ~4ms per file (one event loop tick). For 10 stale files = 40ms total overhead. Negligible compared to the Ollama embed call (~100-500ms per file).

### 2. Pause While Typing

**Where:** `main.ts` → new `lastEditorActivity` timestamp + check in `indexFiles()`

Track user typing activity via Obsidian's `editor-change` workspace event. Before processing each file in the indexing loop, check whether the user has been active recently. If so, wait until they stop.

```
Editor keystroke → update lastEditorActivity timestamp
                      ↓
indexFiles() loop → check: was there typing in the last 2 seconds?
                      ↓ yes
                    wait until 2 seconds of silence
                      ↓ no
                    process next file
```

**Implementation:**

In `main.ts`:
```typescript
private lastEditorActivity = 0;

// In onload():
this.registerEvent(this.app.workspace.on('editor-change', () => {
    this.lastEditorActivity = Date.now();
}));
```

Pass an `isUserActive` callback to `indexFiles()`:

```typescript
await this.vectorStore.indexFiles(staleFiles, {
    // ...existing options...
    isUserActive: () => Date.now() - this.lastEditorActivity < 2000,
});
```

In `indexFiles()`, between files:
```typescript
// Wait for user to stop typing before continuing
while (options?.isUserActive?.()) {
    await new Promise(resolve => setTimeout(resolve, 500));
}
```

**Why 2 seconds?** Matches common debounce for "user stopped typing" detection. Short enough to resume quickly, long enough to cover natural pauses between words.

**Why poll at 500ms?** Balances responsiveness (resume within 500ms of user stopping) with overhead (2 timer wakeups per second during typing).

### 3. Cap Batch Size Per Reconciliation

**Where:** `main.ts` → `reconcile()` method

Instead of indexing ALL stale files in one reconciliation pass, process at most N files. The rest are picked up in the next 60-second cycle.

```typescript
const RECONCILE_BATCH_SIZE = 10;

// In reconcile():
const staleFiles = await this.vectorStore.getStaleFiles(mdFiles);
const batch = staleFiles.slice(0, RECONCILE_BATCH_SIZE);

if (batch.length < staleFiles.length) {
    this.indexLogger.info(
        `Reconcile: processing ${batch.length}/${staleFiles.length} stale files (rest next cycle)`
    );
}
```

**Why 10?** At ~200-500ms per file (dominated by Ollama), 10 files = 2-5 seconds per cycle. Spread across 60-second intervals, this is unnoticeable. A 60-file Readwise dump takes 6 cycles (6 minutes) instead of blocking for 30+ seconds.

**processQueue() is NOT capped.** Event-driven indexing typically handles 1-3 files and should complete immediately. Capping is only needed for reconciliation, which can discover large backlogs.

## Implementation Plan

### Step 1: Add yield + typing pause to `indexFiles()`

**File:** `src/vector-store.ts`

- Add `isUserActive?: () => boolean` to the options parameter
- At the top of each file iteration: `while` loop checking `isUserActive`, sleeping 500ms
- At the bottom of each file iteration: `await new Promise(resolve => setTimeout(resolve, 0))`

### Step 2: Add typing detection to `main.ts`

**File:** `src/main.ts`

- Add `private lastEditorActivity = 0;` field
- Register `editor-change` event in `onload()`
- Pass `isUserActive` callback in both `processQueue()` and `reconcile()` calls to `indexFiles()`

### Step 3: Cap reconciliation batch size

**File:** `src/main.ts`

- Add `const RECONCILE_BATCH_SIZE = 10;` constant
- Slice `staleFiles` in `reconcile()` before passing to `indexFiles()`
- Log when batch is capped

### Step 4: Update `SearchEngine` interface

**File:** `src/search-engine.ts`

- No change needed — `indexFiles()` is only on the concrete `OramaSearchEngine` class, not the interface

## Files to Modify

| File | Changes |
|------|---------|
| `src/vector-store.ts` | Add `isUserActive` option to `indexFiles()`, add yield + typing pause |
| `src/main.ts` | Add `lastEditorActivity` field, register `editor-change` event, pass `isUserActive` callback, cap reconciliation batch |

## Risks & Mitigations

**Risk:** Yield adds latency to initial full index.
**Mitigation:** 4ms per file × 2000 files = 8 seconds extra. The Ollama calls dominate at 200-500ms each, so this is noise.

**Risk:** Typing detection pauses indexing indefinitely during long writing sessions.
**Mitigation:** Acceptable — the user doesn't need search results while actively typing. Indexing resumes the moment they pause for 2 seconds.

**Risk:** Batch cap means stale files take multiple cycles to catch up.
**Mitigation:** 10 files per 60 seconds = 600 files in 1 hour. More than enough for normal usage. Event-driven indexing handles the instant case.

## Verification

1. `npm run build` — compiles
2. `npm test` — unit + integration tests pass
3. Deploy to main vault, type continuously for 30+ seconds — no stutter
4. Check `indexing-YYYY-MM-DD.log` for "Reconcile: processing N/M stale files" entries when batch is capped
5. Modify a file, observe it indexed within 3 seconds (event listener still works)
6. Disable plugin, create 20 files, re-enable — observe them indexed across 2 reconciliation cycles
