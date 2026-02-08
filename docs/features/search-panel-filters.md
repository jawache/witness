# Feature Spec: Search Panel Filters

**Status:** Complete
**Created:** 2026-02-08
**Last Updated:** 2026-02-08

## Overview

Add path and tag filtering to the Witness search panel sidebar. Users can narrow search results by selecting a folder path and/or tag before or after typing a query. Filters use Obsidian's built-in `AbstractInputSuggest` for inline autocomplete with fuzzy matching.

## Problem Statement

The MCP `search` tool already supports `paths` and `tags` parameters, but the sidebar search panel has no filtering UI. Users searching a large vault need to scope results to specific folders or tags without typing complex queries.

## Solution

Add two filter inputs below the search bar — one for path, one for tag — each backed by an `AbstractInputSuggest` subclass that provides fuzzy-matched autocomplete from the vault's actual folders and tags. Selected filters appear as removable chips below the inputs.

### UI Layout

```
[Search vault...                    ]
[Mode: Hybrid v]
[Filter by folder...] [Filter by tag...]
[x chaos/external] [x #project]       ← chips (if any selected)
[Results...]
```

### Key Design Decisions

- **`AbstractInputSuggest`** — Obsidian's built-in class for inline autocomplete popovers attached to input elements. Handles keyboard navigation, scrolling, and positioning automatically. Works in sidebar panels.
- **`prepareFuzzySearch()` + `renderResults()`** — Built-in Obsidian utilities for fuzzy matching with highlighted characters in the suggestion list.
- **Chips for selected filters** — Once a folder or tag is selected from the suggest popover, it becomes a removable chip and the input clears for adding more.
- **Immediate re-search** — Adding or removing a filter re-triggers the search if there's a current query.
- **Multiple selections** — Users can add multiple path and tag filters (OR within type, AND between types: results must match any selected path AND any selected tag).

## Implementation Plan

### Step 1: Create `FolderSuggest` and `TagSuggest` classes

**File:** `src/search-view.ts`

Two `AbstractInputSuggest<string>` subclasses:
- `FolderSuggest` — `getSuggestions()` calls `app.vault.getAllFolders()`, fuzzy-filters by query
- `TagSuggest` — `getSuggestions()` iterates `app.metadataCache` to collect all tags, fuzzy-filters by query
- Both use `prepareFuzzySearch()` for matching and `renderResults()` for highlighted rendering

### Step 2: Add filter inputs and chip container to UI

**File:** `src/search-view.ts` — `buildUI` method

Insert a filter row between the mode selector and results container:
- Two small text inputs side by side (path and tag)
- A chip container below for displaying active filters
- Each input has its `AbstractInputSuggest` attached

### Step 3: Wire filters into search

**File:** `src/search-view.ts` — `executeSearch` method

Pass selected paths and tags to `plugin.search()`:
```typescript
const results = await this.plugin.search(query, {
    mode: this.currentMode,
    limit: 20,
    paths: this.selectedPaths.length > 0 ? this.selectedPaths : undefined,
    tags: this.selectedTags.length > 0 ? this.selectedTags : undefined,
});
```

### Step 4: Add CSS for filter row and chips

**File:** `styles.css`

Compact styling for filter inputs (half-width each) and chip elements with remove buttons.

## Files to Modify

- `src/search-view.ts` — Add suggest classes, filter inputs, chips, wire into search
- `styles.css` — Filter row and chip styles

## Verification

1. `npm run build` — compiles
2. `npm test` — unit tests pass
3. Open search panel, type in path filter → folder suggestions appear with fuzzy matching
4. Select a folder → chip appears, search re-runs scoped to that folder
5. Type in tag filter → tag suggestions appear
6. Select a tag → chip appears, search re-runs scoped to that tag
7. Click chip X → filter removed, search re-runs
8. Multiple filters combine correctly
