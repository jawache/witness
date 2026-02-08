# Feature Spec: Search Panel UI

**Status:** Planned
**Created:** 2026-02-07
**Last Updated:** 2026-02-07

## Overview

A dedicated side panel in Obsidian for running semantic, fulltext, and hybrid searches against the vault's vector index. Results display with relevance scores and content snippets, and clicking a result opens the file in the main editor.

## Problem Statement

Currently, semantic search is only accessible via the MCP `semantic_search` tool — meaning you need an AI client (Claude Desktop) to use it. There's no way for a user to directly query their own index from within Obsidian. The plugin indexes thousands of documents but provides no native UI to explore that index.

Additionally, the existing "Build Index" button and document count in settings are the only visibility into the index. Users have no way to verify search quality, test queries, or browse results without going through an MCP client.

## Solution

### Architecture

```
┌─────────────────────────────┐
│  Witness Search (Side Panel)│
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ 🔍 Search query...      │ │  ← Input with debounce
│ └─────────────────────────┘ │
│ Mode: [Hybrid ▾]           │  ← Dropdown: hybrid / vector / fulltext
│                             │
│ ┌─────────────────────────┐ │
│ │ recipes/bread.md   84.5%│ │  ← Result item
│ │ My go-to sourdough      │ │  ← Snippet (first ~200 chars)
│ │ recipe starts with...   │ │
│ ├─────────────────────────┤ │
│ │ projects/ferment..  72% │ │
│ │ Fermentation is the     │ │
│ │ process of...           │ │
│ ├─────────────────────────┤ │
│ │ chaos/inbox/note.. 65%  │ │
│ │ Picked up some new      │ │
│ │ starter cultures...     │ │
│ └─────────────────────────┘ │
│                             │
│ 3 results (142ms)           │  ← Result count + timing
└─────────────────────────────┘
```

### 1. Side Panel via Obsidian ItemView

Obsidian's `ItemView` API provides custom side panels that integrate with the workspace layout system. The panel registers as a view type and can be toggled open/closed.

```typescript
import { ItemView, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE_SEARCH = 'witness-search';

class WitnessSearchView extends ItemView {
    getViewType(): string {
        return VIEW_TYPE_SEARCH;
    }

    getDisplayText(): string {
        return 'Witness Search';
    }

    getIcon(): string {
        return 'search';  // Obsidian's built-in search icon
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();
        this.buildUI(container);
    }

    async onClose(): Promise<void> {
        // Cleanup
    }
}
```

**Registration in `onload()`:**

```typescript
this.registerView(VIEW_TYPE_SEARCH, (leaf) => new WitnessSearchView(leaf, this));

// Repurpose ribbon icon to toggle the panel
this.addRibbonIcon('search', 'Witness Search', () => {
    this.toggleSearchPanel();
});
```

**Toggle logic:**

```typescript
async toggleSearchPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH);
    if (existing.length > 0) {
        // Panel is open — close it
        existing[0].detach();
    } else {
        // Open in right sidebar
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_SEARCH, active: true });
            this.app.workspace.revealLeaf(leaf);
        }
    }
}
```

### 2. Search Input with Debounce

A text input at the top of the panel. Searches fire automatically after the user stops typing (300ms debounce), or immediately on Enter.

```typescript
private buildSearchInput(container: HTMLElement): void {
    const inputEl = container.createEl('input', {
        type: 'text',
        placeholder: 'Search vault...',
        cls: 'witness-search-input',
    });

    let debounceTimer: number;

    inputEl.addEventListener('input', () => {
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            this.executeSearch(inputEl.value);
        }, 300);
    });

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            window.clearTimeout(debounceTimer);
            this.executeSearch(inputEl.value);
        }
    });
}
```

**Why 300ms debounce:** Short enough to feel responsive, long enough to avoid firing mid-word. For fulltext search (no Ollama call), this could be even shorter. For hybrid/vector search (requires Ollama embedding), the Ollama round-trip (~50-100ms) dominates anyway, so debounce length matters less.

### 3. Search Mode Dropdown

A dropdown selector for choosing between search modes. Defaults to hybrid.

```typescript
private buildModeSelector(container: HTMLElement): void {
    const select = container.createEl('select', {
        cls: 'witness-search-mode',
    });

    const modes = [
        { value: 'hybrid', label: 'Hybrid (keyword + semantic)' },
        { value: 'vector', label: 'Vector (semantic only)' },
        { value: 'fulltext', label: 'Fulltext (keyword only)' },
    ];

    for (const mode of modes) {
        select.createEl('option', { value: mode.value, text: mode.label });
    }

    select.addEventListener('change', () => {
        this.currentMode = select.value as 'hybrid' | 'vector' | 'fulltext';
        // Re-run current query with new mode if there's a query
        if (this.currentQuery) {
            this.executeSearch(this.currentQuery);
        }
    });
}
```

**Mode descriptions (shown as tooltip or subtitle):**

| Mode | Description | Ollama Required | Best For |
|------|-------------|-----------------|----------|
| Hybrid | BM25 keywords + semantic similarity, merged via RRF | Yes (embedding) | General queries — best default |
| Vector | Cosine similarity on embeddings only | Yes (embedding) | Conceptual/meaning-based queries |
| Fulltext | BM25 keyword matching, no embeddings | No | Exact terms, instant results |

### 4. Search Execution

The search method calls the appropriate VectorStore method based on the selected mode:

```typescript
private async executeSearch(query: string): Promise<void> {
    if (!query.trim()) {
        this.clearResults();
        return;
    }

    this.currentQuery = query;
    this.showLoading();
    const startTime = performance.now();

    try {
        let results: SearchResult[];

        switch (this.currentMode) {
            case 'hybrid':
                results = await this.vectorStore.searchHybrid(query, { limit: 20 });
                break;
            case 'vector':
                results = await this.vectorStore.searchVector(query, { limit: 20 });
                break;
            case 'fulltext':
                results = await this.vectorStore.searchFulltext(query, { limit: 20 });
                break;
        }

        const elapsed = Math.round(performance.now() - startTime);
        this.renderResults(results, elapsed);
    } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Search failed');
    }
}
```

### 5. Result Rendering

Each result is rendered as a clickable card showing the file path, relevance score, and a content snippet.

```typescript
private renderResults(results: SearchResult[], elapsedMs: number): void {
    this.resultsContainer.empty();

    // Summary line
    this.resultsContainer.createEl('div', {
        text: `${results.length} results (${elapsedMs}ms)`,
        cls: 'witness-search-summary',
    });

    for (const result of results) {
        const item = this.resultsContainer.createEl('div', {
            cls: 'witness-search-result',
        });

        // Header row: path + score
        const header = item.createEl('div', { cls: 'witness-search-result-header' });
        header.createEl('span', {
            text: result.path,
            cls: 'witness-search-result-path',
        });
        header.createEl('span', {
            text: `${Math.round(result.score * 100)}%`,
            cls: 'witness-search-result-score',
        });

        // Snippet
        if (result.snippet) {
            item.createEl('div', {
                text: result.snippet,
                cls: 'witness-search-result-snippet',
            });
        }

        // Click to open file
        item.addEventListener('click', () => {
            this.app.workspace.openLinkText(result.path, '', false);
        });
    }
}
```

**Score display:** Scores are shown as percentages (e.g. `84%`). For hybrid and vector modes, these are already 0-1 similarity scores from Orama. For fulltext mode, BM25 scores are normalised relative to the top result (already handled by `searchFulltext()`).

### 6. Snippets

Each result includes a content snippet — the first ~200 characters of the document (or matching chunk, when chunking is implemented). Snippets give enough context to decide whether to open the file without cluttering the results list.

```typescript
// In SearchResult interface (future update to vector-store.ts)
export interface SearchResult {
    path: string;
    title: string;
    score: number;
    snippet?: string;    // First ~200 chars of content
    headingPath?: string; // Which section matched (future, with chunking)
}
```

**Snippet source:** For whole-document search (current), the snippet is the first ~200 characters of the document's `content` field stored in Orama. When chunking is implemented, the snippet comes from the matched chunk's content.

**Implementation:** The `mapAndFilterHits()` method in VectorStore already has access to `hit.document.content` — it just needs to slice the first 200 characters and add it to the result.

### 7. Click-to-Open Behaviour

Clicking a result opens the file in the main editor panel using Obsidian's `openLinkText()` API:

```typescript
this.app.workspace.openLinkText(result.path, '', false);
```

The `false` parameter means "open in the current active leaf" rather than creating a new tab.

**Future enhancement (with chunking):** When markdown chunking is implemented, results will include a `headingPath` (e.g. `## Sourdough > ### Starter Maintenance`). The click handler can navigate to the specific heading:

```typescript
// With chunking, result.path might be "recipes/bread.md"
// and result.headingPath might be "## Starter Maintenance"
// Extract heading text and use it as a link fragment
const heading = result.headingPath?.split(' > ').pop()?.replace(/^#+\s*/, '');
if (heading) {
    this.app.workspace.openLinkText(`${result.path}#${heading}`, '', false);
} else {
    this.app.workspace.openLinkText(result.path, '', false);
}
```

Obsidian's `openLinkText` supports `#heading` fragments natively, so this will scroll directly to the matched section.

### 8. Ribbon Icon

The existing ribbon icon (currently does nothing) is repurposed to toggle the search panel. This gives users a visible, always-available entry point.

```typescript
// Replace the current no-op ribbon icon
this.addRibbonIcon('search', 'Witness Search', () => {
    this.toggleSearchPanel();
});
```

### 9. Obsidian Command

Register a command so users can toggle the panel from the command palette (Cmd+P):

```typescript
this.addCommand({
    id: 'toggle-search-panel',
    name: 'Toggle search panel',
    callback: () => {
        this.toggleSearchPanel();
    },
});
```

### 10. Styling

The panel uses Obsidian's CSS variables for native look and feel. A `styles.css` file provides the layout:

```css
.witness-search-input {
    width: 100%;
    padding: 8px;
    margin-bottom: 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
}

.witness-search-mode {
    width: 100%;
    margin-bottom: 12px;
    padding: 4px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
}

.witness-search-summary {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-bottom: 8px;
}

.witness-search-result {
    padding: 8px;
    margin-bottom: 4px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--background-modifier-border);
}

.witness-search-result:hover {
    background: var(--background-modifier-hover);
}

.witness-search-result-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4px;
}

.witness-search-result-path {
    font-size: var(--font-ui-small);
    font-weight: 500;
    color: var(--text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    margin-right: 8px;
}

.witness-search-result-score {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    white-space: nowrap;
}

.witness-search-result-snippet {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.witness-search-loading {
    text-align: center;
    padding: 20px;
    color: var(--text-muted);
}

.witness-search-error {
    color: var(--text-error);
    padding: 8px;
    font-size: var(--font-ui-small);
}

.witness-search-empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-faint);
    font-size: var(--font-ui-small);
}
```

Using `var(--background-modifier-border)`, `var(--text-muted)`, etc. ensures the panel matches the user's theme (light, dark, or custom).

## Files to Create/Modify

| File | Changes |
|------|---------|
| `src/main.ts` | Register `ItemView`, ribbon icon, toggle command, pass VectorStore to view |
| `src/search-view.ts` | **New file.** `WitnessSearchView` class extending `ItemView` |
| `src/vector-store.ts` | Add `snippet` field to `SearchResult`, populate from `content` in `mapAndFilterHits()` |
| `styles.css` | Search panel CSS classes |

The view logic is in a separate file (`src/search-view.ts`) rather than in `main.ts` because it's a self-contained UI component with its own state, event handlers, and rendering logic. Keeping it separate avoids further bloating `main.ts`.

## Behaviour Summary

| Action | What Happens |
|--------|-------------|
| Click ribbon icon | Toggles search panel open/closed in right sidebar |
| Cmd+P → "Toggle search panel" | Same as ribbon icon |
| Type in search box | After 300ms pause, executes search in selected mode |
| Press Enter | Immediately executes search |
| Change mode dropdown | Re-runs current query with new mode |
| Click a result | Opens file in main editor |
| Empty query | Clears results, shows empty state |
| Search with no index | Shows error: "Index not built yet" |
| Ollama offline + vector/hybrid mode | Shows error: "Ollama not available" |
| Ollama offline + fulltext mode | Works normally (no Ollama needed) |

## Edge Cases

### No Index Built

If the VectorStore is empty or not initialised, show a message: "No documents indexed yet. Build the index in Settings → Witness → Semantic Search." with a link/button to open settings.

### Ollama Offline

For fulltext mode, searches work without Ollama. For hybrid and vector modes, the Ollama embedding call will fail. Show a clear error: "Ollama is not available. Fulltext search still works." and optionally auto-switch to fulltext mode.

### Very Long File Paths

Paths are truncated with CSS `text-overflow: ellipsis` to prevent layout overflow. The full path is available as a tooltip on hover.

### Empty Results

Show "No results found for '{query}'" with a suggestion to try a different mode or broader terms.

### Panel State Persistence

Obsidian's workspace layout system automatically persists which views are open. If the user opens the search panel and restarts Obsidian, the panel will reopen. The `ItemView` subclass handles this via `getViewType()`.

## Future Enhancements

### With Markdown Chunking

When chunking is implemented, results will show which section of a document matched:

```
recipes/bread.md > Starter Maintenance    84%
Feed the starter every 12 hours with equal parts flour and water...
```

Clicking navigates directly to the heading via Obsidian's `#heading` fragment support.

### With Re-ranking

A toggle or checkbox: "Re-rank results" that enables LLM-based re-ranking on the current result set. This adds 1-3 seconds but improves precision. The UI could show a subtle "re-ranking..." indicator while processing.

---

*Depends on: [Hybrid search](hybrid-search.md) (for search modes), [Ollama integration](ollama-integration.md) (for embeddings)*
*Enhanced by: [Markdown chunking](markdown-chunking.md) (heading navigation + better snippets), [Re-ranking](reranking.md) (precision toggle)*
