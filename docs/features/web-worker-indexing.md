# Feature Spec: Web Worker for Orama Indexing

**Status:** Planned
**Created:** 2026-02-08
**Last Updated:** 2026-02-08

## Overview

Move all Orama database operations (insert, remove, search) to a Web Worker so that indexing never blocks the UI thread. The current quick fix — yielding between individual Orama operations via `setTimeout(0)` — eliminates hard freezes but still causes micro-stutter because each operation runs synchronously on the renderer thread. A Web Worker moves this CPU work off-thread entirely.

## Problem Statement

Obsidian runs in Electron's renderer process, which shares a single JavaScript thread between UI rendering and plugin logic. Orama's `insert()` and `remove()` operations are synchronous and CPU-intensive — on a 2,000-file vault, a single reconciliation pass can queue hundreds of inserts.

The current mitigation yields to the event loop between every Orama operation:

```typescript
await insert(this.db, doc);
await new Promise(resolve => setTimeout(resolve, 0));
```

This prevents hard lockups but has drawbacks:

1. **Micro-stutter**: Each `insert()` still blocks for 1-5ms. At 60fps, frames are 16ms — a single insert can eat a third of a frame budget.
2. **Throughput penalty**: The yield overhead (~4ms per operation) adds up. 200 inserts = 800ms of pure yield overhead on top of the actual work.
3. **Fundamentally wrong thread**: CPU-bound work belongs on a background thread, not interleaved with UI work on the main thread.

## Solution

Create a dedicated Web Worker that owns the Orama database instance. The main thread communicates with it via `postMessage()` / `onmessage` — sending file content to index and receiving search results back. The Orama DB never touches the main thread.

### Architecture

```
Main Thread (renderer)              Web Worker
─────────────────────              ──────────

User types → UI repaints           Orama DB lives here
     │                                  │
     │  postMessage({ type: 'index',    │
     │    files: [...] })          ────→ │  insert() / remove()
     │                                  │  (blocks worker, not UI)
     │                                  │
     │  postMessage({ type: 'search',   │
     │    query: '...' })          ────→ │  search()
     │                             ←──── │  postMessage({ results })
     │                                  │
     │  postMessage({ type: 'save' })   │
     │                             ────→ │  serialize DB
     │                             ←──── │  postMessage({ data })
     │  write to disk                   │
```

### Worker Responsibilities

The worker owns:
- Orama DB instance (create, insert, remove, search)
- Embedding vector storage
- BM25 + hybrid search execution
- Index serialisation for persistence

The worker does NOT own:
- Ollama HTTP calls (these can run from either thread, but main thread is fine since `fetch()` is async and non-blocking)
- File system access (Obsidian vault API is main-thread only)
- Persistence to disk (main thread writes the serialised blob)

### Message Protocol

```typescript
// Main → Worker
type WorkerRequest =
  | { type: 'init'; schema: OramaSchema; data?: SerializedDB }
  | { type: 'insert'; docs: OramaDoc[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'search'; query: SearchQuery; id: string }
  | { type: 'serialize' }
  | { type: 'getStaleFiles'; files: { path: string; mtime: number }[] }
  | { type: 'getOrphanedPaths'; vaultPaths: string[] }
  | { type: 'clear' };

// Worker → Main
type WorkerResponse =
  | { type: 'ready' }
  | { type: 'inserted'; count: number }
  | { type: 'removed'; count: number }
  | { type: 'searchResult'; id: string; results: SearchResult[] }
  | { type: 'serialized'; data: string }
  | { type: 'staleFiles'; paths: string[] }
  | { type: 'orphanedPaths'; paths: string[] }
  | { type: 'error'; message: string };
```

### Two-Phase Indexing in Worker Context

The current two-phase approach (Phase 1: content + metadata, Phase 2: embeddings) still works:

1. **Main thread** reads file content via Obsidian API, sends to worker for Phase 1 insert
2. **Main thread** calls Ollama `/api/embed` with file content (async fetch, non-blocking)
3. **Main thread** sends embedding vectors to worker for Phase 2 update (remove + re-insert with vectors)

The worker handles the CPU-bound insert/remove; the main thread handles I/O (vault reads, Ollama calls).

### Persistence

Currently, `save()` calls Orama's `save(db)` to get a serialisable object, then writes it to `.witness/index.orama`. With a worker:

1. Main thread sends `{ type: 'serialize' }` to worker
2. Worker calls `save(db)` and posts back the serialised data
3. Main thread writes to disk via Obsidian adapter

This keeps file I/O on the main thread (required by Obsidian API) while serialisation happens off-thread.

### Web Worker in Obsidian/Electron

Obsidian plugins run in Electron's renderer process, which supports standard Web Workers. The worker script needs to be bundled separately.

**Bundling approach:**

```typescript
// In esbuild config, create a separate entry point for the worker
// Worker source: src/orama-worker.ts
// Worker output: worker.js (alongside main.js in plugin directory)

// In main plugin code:
const workerUrl = this.app.vault.adapter.getResourcePath(
  `${this.manifest.dir}/worker.js`
);
this.worker = new Worker(workerUrl);
```

**Alternative — inline worker via Blob URL:**

```typescript
// Bundle worker code as a string, create Blob URL at runtime
const workerCode = `/* bundled worker code */`;
const blob = new Blob([workerCode], { type: 'application/javascript' });
const url = URL.createObjectURL(blob);
this.worker = new Worker(url);
```

The inline approach avoids a separate file but makes debugging harder. The separate file approach is cleaner.

## Implementation Plan

### Step 1: Create worker entry point

**New file:** `src/orama-worker.ts`

- Import Orama (create, insert, remove, search, save, load)
- Handle incoming messages via `onmessage`
- Maintain DB instance in worker scope
- Post results back via `postMessage`

### Step 2: Create worker client wrapper

**New file:** `src/orama-worker-client.ts`

- `OramaWorkerClient` class that wraps `postMessage` / `onmessage` into async methods
- Implements same interface as current direct Orama usage
- Request/response correlation via message IDs
- Promise-based API: `await client.insert(docs)`, `await client.search(query)`

### Step 3: Update esbuild config

**File:** `esbuild.config.mjs`

- Add second entry point for `src/orama-worker.ts` → `worker.js`
- Ensure Orama is bundled into the worker (not imported at runtime)

### Step 4: Refactor vector-store.ts

**File:** `src/vector-store.ts`

- Replace direct Orama calls with `OramaWorkerClient` methods
- Remove per-operation `setTimeout(0)` yields (no longer needed — worker is off-thread)
- Keep `isUserActive` typing pause (still useful to avoid saturating Ollama during typing)
- Keep batch file yield (still useful for Ollama call pacing)

### Step 5: Update main.ts worker lifecycle

**File:** `src/main.ts`

- Create worker in `ensureSearchEngine()`
- Terminate worker in `onunload()`
- Pass worker reference to `OramaSearchEngine` constructor

### Step 6: Update tests

- Unit tests for worker message protocol
- Integration tests should work unchanged (they test MCP endpoints, not internal threading)

## Files to Create

| File | Purpose |
|------|---------|
| `src/orama-worker.ts` | Web Worker entry point — owns Orama DB instance |
| `src/orama-worker-client.ts` | Main-thread client wrapper with async API |

## Files to Modify

| File | Changes |
|------|---------|
| `src/vector-store.ts` | Replace direct Orama calls with worker client, remove per-op yields |
| `src/main.ts` | Worker lifecycle (create/terminate), pass to search engine |
| `esbuild.config.mjs` | Add worker entry point |

## Risks & Mitigations

**Risk:** Structured clone overhead for large messages (e.g., serialising entire DB for persistence).
**Mitigation:** Use `Transferable` objects where possible. Serialisation happens infrequently (on save, not per-operation). Can also use `SharedArrayBuffer` if needed, though this requires specific headers in Electron.

**Risk:** Orama may use APIs not available in Web Worker context (e.g., DOM APIs).
**Mitigation:** Orama is a pure JavaScript library with no DOM dependencies — it works in Node.js, so it will work in a Web Worker.

**Risk:** Debugging is harder with Web Workers (separate context, no shared breakpoints).
**Mitigation:** Chrome DevTools supports Worker debugging. Obsidian's dev tools (Cmd+Option+I) can inspect workers. Add structured logging in worker messages.

**Risk:** Worker creation overhead on plugin startup.
**Mitigation:** Workers are lightweight to create (~1ms). The Orama DB initialisation inside the worker is the bottleneck, same as today. Loading a saved index via `load()` is fast.

**Risk:** esbuild configuration complexity for dual entry points.
**Mitigation:** esbuild handles multiple entry points natively. Many Obsidian plugins already use custom esbuild configs.

## Verification

1. `npm run build` — produces both `main.js` and `worker.js`
2. `npm test` — all existing tests pass (MCP-level tests unchanged)
3. Deploy to main vault, type continuously during reconciliation — zero stutter
4. Open DevTools → Sources → Workers — confirm worker thread is active
5. Profile with DevTools → Performance — main thread shows no Orama-related blocking
6. Index 2,000 files — verify throughput is equal or better than current approach
7. Kill Obsidian during indexing — verify no data corruption on restart
