# Feature Spec: Background Indexing

**Status:** Planned
**Created:** 2026-02-07
**Last Updated:** 2026-02-07

## Overview

Automatically index new and changed vault files in the background, with a status bar indicator, dedicated log file, and a settings UI log viewer. Silent by default — no popups, no notices, no interruptions.

## Problem Statement

Currently, indexing is entirely passive. It only happens when:

1. The user clicks "Build Index" in settings (shows Notice popups every 50 files)
2. The first `semantic_search` call triggers a lazy stale-file check

There are **no vault event listeners** — if you create, edit, or delete a file, the index doesn't know until the next search. This means search results can be stale for hours or days.

Smart Connections solves this with aggressive background indexing, but its constant popup notifications are disruptive. We want the indexing without the annoyance.

## Solution

### Architecture

```
Vault Events (create/modify/delete/rename)
    |
    v
Debounce Queue (3-second delay per file)
    |
    v
IndexWorker (batch processing, 20 files at a time)
    |
    v
VectorStore (Orama insert/remove)
    |
    v
Status Bar + Log File (silent feedback)
```

### 1. Vault Event Listeners

Register listeners on plugin load for all relevant vault events:

```typescript
// In onload(), after VectorStore is initialised
this.registerEvent(this.app.vault.on('create', (file) => {
    if (file instanceof TFile && file.extension === 'md') {
        this.indexQueue.add(file.path, 'create');
    }
}));

this.registerEvent(this.app.vault.on('modify', (file) => {
    if (file instanceof TFile && file.extension === 'md') {
        this.indexQueue.add(file.path, 'modify');
    }
}));

this.registerEvent(this.app.vault.on('delete', (file) => {
    if (file instanceof TFile && file.extension === 'md') {
        this.indexQueue.add(file.path, 'delete');
    }
}));

this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
    if (file instanceof TFile && file.extension === 'md') {
        this.indexQueue.add(oldPath, 'delete');
        this.indexQueue.add(file.path, 'create');
    }
}));
```

Using `this.registerEvent()` ensures Obsidian automatically cleans up listeners on plugin unload.

### 2. Debounce Queue

A file might be modified many times in quick succession (e.g. typing in a note). The queue debounces changes per file path:

```typescript
class IndexQueue {
    private pending: Map<string, { action: 'index' | 'delete'; timer: number }>;
    private debounceMs: number = 3000; // 3 seconds after last change
    private processing: boolean = false;
    private onReady: () => void; // Callback when queue has work

    add(path: string, event: 'create' | 'modify' | 'delete') {
        // Clear existing timer for this path
        const existing = this.pending.get(path);
        if (existing) window.clearTimeout(existing.timer);

        const action = event === 'delete' ? 'delete' : 'index';

        // Set new timer — when it fires, mark as ready for processing
        const timer = window.setTimeout(() => {
            this.onReady();
        }, this.debounceMs);

        this.pending.set(path, { action, timer });
    }

    drain(): Array<{ path: string; action: 'index' | 'delete' }> {
        const items = Array.from(this.pending.entries()).map(
            ([path, { action }]) => ({ path, action })
        );
        this.pending.clear();
        return items;
    }
}
```

### 3. Index Worker

Processes the queue in batches. Runs as an async loop that activates when the queue has items:

```typescript
private async processQueue(): Promise<void> {
    if (this.indexing) return; // Already processing
    this.indexing = true;

    try {
        const items = this.indexQueue.drain();
        if (items.length === 0) return;

        // Separate deletes from indexes
        const toDelete = items.filter(i => i.action === 'delete');
        const toIndex = items.filter(i => i.action === 'index');

        // Process deletes immediately
        for (const item of toDelete) {
            await this.vectorStore.removeByPath(item.path);
            this.indexLogger.info(`Removed: ${item.path}`);
        }

        // Process indexes in batches
        if (toIndex.length > 0) {
            const files = toIndex
                .map(i => this.app.vault.getAbstractFileByPath(i.path))
                .filter((f): f is TFile => f instanceof TFile);

            this.updateStatusBar(`indexing ${files.length} files...`);

            await this.vectorStore.indexFiles(files, (done, total) => {
                this.updateStatusBar(`indexing ${done}/${total}...`);
                this.indexLogger.info(`Progress: ${done}/${total}`);
            });

            this.indexLogger.info(`Indexed ${files.length} files`);
        }

        // Save index to disk
        await this.vectorStore.save();

    } catch (err) {
        this.indexLogger.error('Indexing failed', err);
        this.updateStatusBar('indexing error');
    } finally {
        this.indexing = false;
        this.updateStatusBar(); // Reset to idle state
    }
}
```

### 4. Startup Scan

On plugin load, after the VectorStore is initialised, scan for stale files and index them in the background:

```typescript
// In onload(), after VectorStore.initialize()
private async startupIndexing(): Promise<void> {
    // Wait a few seconds for Obsidian to finish loading
    await sleep(5000);

    // Check if Ollama is available
    if (!(await this.ollamaProvider.isAvailable())) {
        this.indexLogger.info('Ollama not available, skipping startup indexing');
        this.updateStatusBar('Ollama offline');
        return;
    }

    const mdFiles = this.app.vault.getMarkdownFiles();
    const staleFiles = await this.vectorStore.getStaleFiles(mdFiles);

    if (staleFiles.length === 0) {
        this.indexLogger.info(`Startup scan: all ${mdFiles.length} files up to date`);
        this.updateStatusBar();
        return;
    }

    this.indexLogger.info(`Startup scan: ${staleFiles.length}/${mdFiles.length} files need indexing`);
    this.updateStatusBar(`indexing ${staleFiles.length} files...`);

    await this.vectorStore.indexFiles(staleFiles, (done, total) => {
        this.updateStatusBar(`indexing ${done}/${total}...`);
        this.indexLogger.info(`Startup progress: ${done}/${total}`);
    });

    await this.vectorStore.save();
    this.indexLogger.info('Startup indexing complete');
    this.updateStatusBar();
}
```

The 5-second delay avoids competing with Obsidian's own startup I/O. This runs non-blocking — the plugin is fully usable while it indexes.

### 5. Status Bar Indicator

A small text element in Obsidian's bottom status bar. Always visible, never interrupting.

**States:**

| State | Display | Example |
|-------|---------|---------|
| Idle | `Witness: N indexed` | `Witness: 1,234 indexed` |
| Indexing | `Witness: indexing N/M...` | `Witness: indexing 5/23...` |
| Error | `Witness: indexing error` | `Witness: indexing error` |
| Ollama offline | `Witness: Ollama offline` | `Witness: Ollama offline` |

**Click behaviour:** Opens the indexing log file in Obsidian. The log lives inside the vault's plugin directory, so it can be opened as a regular file.

```typescript
// In onload()
this.statusBarEl = this.addStatusBarItem();
this.statusBarEl.setText('Witness: loading...');
this.statusBarEl.onClickEvent(() => {
    // Open the indexing log file in Obsidian
    const logPath = `.obsidian/plugins/witness/logs/indexing-${today()}.log`;
    this.app.workspace.openLinkText(logPath, '', false);
});
```

**Why not the ribbon icon?** The ribbon icon currently does nothing. It could be repurposed, but the status bar is better for continuous status — it's always visible without taking up sidebar space.

### 6. Dedicated Indexing Log

A separate log file from the MCP protocol log, focused on indexing activity.

**Path:** `.obsidian/plugins/witness/logs/indexing-YYYY-MM-DD.log`

**Format:**
```
[2026-02-07T14:30:05.123Z] [INFO] Startup scan: 15/1234 files need indexing
[2026-02-07T14:30:07.456Z] [INFO] Progress: 10/15
[2026-02-07T14:30:09.789Z] [INFO] Progress: 15/15
[2026-02-07T14:30:09.890Z] [INFO] Startup indexing complete
[2026-02-07T14:35:12.345Z] [INFO] File changed: chaos/inbox/new-note.md
[2026-02-07T14:35:15.456Z] [INFO] Indexed 1 file
[2026-02-07T14:40:00.000Z] [INFO] Removed: chaos/inbox/deleted-note.md
```

**Implementation:** Reuse the `MCPLogger` class pattern (buffered writes, 1-second flush, 50-entry buffer). Either:
- Create a second `MCPLogger` instance with a different file prefix (`indexing-` vs `mcp-`)
- Or extract a generic `FileLogger` class that both MCP and indexing loggers use

The second option is cleaner — `MCPLogger` is currently hardcoded to `mcp-` prefix. A small refactor to make it configurable would benefit both use cases.

### 7. Settings UI: Log Viewer

Add a log viewer to the Semantic Search settings tab, styled like Obsidian's vault sync log panel.

**Design:**
```
┌─────────────────────────────────────────────────────────┐
│ Indexing                                                  │
├─────────────────────────────────────────────────────────┤
│                                                           │
│ Status: ● 1,234 documents indexed                         │
│ Last indexed: 2 minutes ago                               │
│                                                           │
│ [Reindex All]  [Clear Index]                              │
│                                                           │
│ Indexing Log:                                             │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ 14:30:05 Startup scan: 15/1234 files need indexing    │ │
│ │ 14:30:07 Progress: 10/15                              │ │
│ │ 14:30:09 Startup indexing complete                    │ │
│ │ 14:35:15 Indexed: chaos/inbox/new-note.md             │ │
│ │ 14:40:00 Removed: chaos/inbox/deleted-note.md         │ │
│ │                                                       │ │
│ └───────────────────────────────────────────────────────┘ │
│                                                           │
│ [Open Full Log]                                           │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

The log viewer is a scrollable `<div>` or `<textarea>` that displays the most recent ~50 log lines. It updates in real-time when the settings tab is open by reading from the in-memory log buffer (not polling the file).

**"Open Full Log"** button opens the log file in Obsidian for the complete history.

### 8. Obsidian Command: Reindex Vault

Register an Obsidian command accessible from the command palette (Cmd+P):

```typescript
this.addCommand({
    id: 'reindex-vault',
    name: 'Reindex vault',
    callback: async () => {
        // Clear and rebuild entire index
        await this.vectorStore.clear();
        const mdFiles = this.app.vault.getMarkdownFiles();
        this.indexLogger.info(`Manual reindex: ${mdFiles.length} files`);
        this.updateStatusBar(`reindexing ${mdFiles.length} files...`);

        await this.vectorStore.indexFiles(mdFiles, (done, total) => {
            this.updateStatusBar(`reindexing ${done}/${total}...`);
        });

        await this.vectorStore.save();
        this.indexLogger.info('Manual reindex complete');
        this.updateStatusBar();
    }
});
```

This is also wired to the "Reindex All" button in settings (same logic).

## Files to Create/Modify

| File | Changes |
|------|---------|
| `src/main.ts` | Vault event listeners, IndexQueue, processQueue(), startupIndexing(), status bar, Obsidian command, settings UI log viewer |
| `src/main.ts` (MCPLogger) | Refactor to generic `FileLogger` with configurable prefix, or create second instance |

No new source files needed — the queue and worker logic lives in `src/main.ts` alongside the existing plugin class. If it grows large, it could be extracted to `src/index-worker.ts` later.

## Behaviour Summary

| Trigger | What Happens | UI Feedback |
|---------|-------------|-------------|
| Plugin loads | Startup scan, index stale files | Status bar: "indexing N/M..." |
| File created | Queued, indexed after 3s debounce | Status bar updates |
| File modified | Queued, re-indexed after 3s debounce | Status bar updates |
| File deleted | Queued, removed from index after 3s | Status bar updates |
| File renamed | Old path removed, new path indexed | Status bar updates |
| "Reindex vault" command | Full re-index from scratch | Status bar: "reindexing N/M..." |
| Settings "Reindex All" button | Same as command | Status bar + log viewer |
| Ollama goes offline | Queue pauses, resumes when available | Status bar: "Ollama offline" |
| All idle | Nothing | Status bar: "Witness: 1,234 indexed" |

## Edge Cases

### Ollama Not Running

If Ollama is offline during background indexing:
- Log the error, don't crash
- Set status bar to "Ollama offline"
- Keep the queue — don't discard pending items
- Retry periodically (every 60 seconds)
- When Ollama comes back, process the accumulated queue

### Rapid File Changes

A user editing a note continuously would trigger many modify events. The 3-second debounce per file path ensures we only index once, after the user pauses typing. The debounce timer resets on each new event for the same path.

### Large Initial Index

On first install with a large vault (4k+ files), startup indexing could take several minutes. This runs entirely in the background. The status bar shows progress. Search works on whatever is indexed so far — results just improve as more files are indexed.

### Plugin Unload During Indexing

If the plugin is disabled or Obsidian closes while indexing:
- Save the current index state (whatever has been indexed so far)
- Flush the log buffer
- The incomplete index will be detected as stale on next startup and resumed

### Index Persistence

Save the index to disk:
- After every batch during background indexing
- After startup indexing completes
- On plugin unload
- NOT on every single file change (would be too frequent during bulk edits)

A periodic save (every 30 seconds during active indexing) provides a safety net against crashes.

## Risks and Mitigations

### Risk: Ollama API rate limiting or overload

Background indexing fires embedding requests constantly as files change.

**Mitigation:** Batch processing (20 files per request) already minimises API calls. The debounce queue ensures rapid edits don't create a flood. Could add a configurable throttle (e.g. max 1 batch per 5 seconds) if needed.

### Risk: Indexing interferes with search performance

If a search happens while indexing is in progress, both compete for Ollama.

**Mitigation:** Search embedding (one vector for the query) is fast and small. Indexing can yield between batches. In practice, Ollama handles concurrent requests fine.

### Risk: Status bar click doesn't work for log files in plugin directory

Obsidian may not be able to open `.obsidian/` files as regular notes.

**Mitigation:** Test this during implementation. Fallback: open the log in a modal/dialog within the settings UI instead, or use `this.app.vault.adapter.read()` to read the file and display it.

---

*Depends on: [Ollama integration](ollama-integration.md) (complete)*
*Enhances: [Hybrid search](hybrid-search.md), [Markdown chunking](markdown-chunking.md) (both benefit from up-to-date index)*
