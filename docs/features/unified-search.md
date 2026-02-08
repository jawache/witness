# Feature Spec: Unified Search

**Status:** Complete
**Created:** 2026-02-08
**Last Updated:** 2026-02-08

## Overview

Consolidate the three existing search-related MCP tools (`search`, `semantic_search`, `find_files`) into two cleaner tools (`search`, `find`) backed by Orama as the single search engine. Upgrade from BM25 to QPS (Quantum Proximity Scoring) for better phrase-like matching, expand the schema to store tags and metadata, and index all files regardless of embedding success.

## Problem Statement

The current search architecture has several issues:

1. **Tool overlap**: `search` (brute-force grep), `semantic_search` (Orama BM25 + vector), and `find_files` (filename matching) overlap in confusing ways. Claude has to choose between three tools that partially do the same thing.

2. **Blind spots**: Files that fail embedding generation are not in the Orama index at all, so they don't appear in any `semantic_search` results — even fulltext mode. The brute-force `search` tool catches them but returns 77KB of unranked noise.

3. **No phrase matching**: Searching for "carbon intensity" with Orama BM25 returns any document containing both words in any order, anywhere in the text. No proximity awareness.

4. **No metadata filtering**: Can't narrow search by tags, folder, or frontmatter properties through the search tools.

5. **No structured output**: `semantic_search` returns flat markdown text. `search` returns a grep dump. Neither returns structured data with snippets.

6. **Engine lock-in**: `VectorStore` is tightly coupled to Orama with no abstraction layer for future engine swaps.

## Solution

### Two MCP Tools

#### `find` — File and directory discovery

Like bash `find`. Uses Obsidian's `app.vault` and `metadataCache` directly. No index required, always works.

**Parameters:**
- `pattern` (string) — Glob or substring to match against filenames
- `path` (string, optional) — Limit to files under this folder
- `tag` (string, optional) — Only files with this tag (from metadataCache)
- `property` (object, optional) — `{ key: string, value: string }` — match frontmatter property
- `limit` (number, optional, default 50) — Max results

**Returns:** List of matching file paths with basic metadata (size, mtime, tags).

Replaces: `find_files` (which only did filename pattern matching).

**MCP Tool Description** (what the AI client sees):
```
Find files and folders in the vault by name, path, tag, or frontmatter property.
Use pattern to match filenames (e.g., "weekly" finds all files with "weekly" in the name).
Use path to limit results to a specific folder (e.g., "chaos/inbox").
Use tag to find files with a specific tag (e.g., "#recipe", "#meeting").
Use property to match frontmatter values (e.g., {"key": "status", "value": "draft"}).
Returns file paths with metadata (size, modified time, tags). Does not search file contents — use the search tool for that.
```

#### `search` — Unified content search

Single tool replacing both `search` and `semantic_search`. Powered by Orama.

**Parameters:**
- `query` (string) — Search query. Supports quoted phrases for exact matching.
- `mode` (enum, optional, default "hybrid") — `hybrid` | `vector` | `fulltext`
- `path` (string, optional) — Limit to files under this folder (Orama `where` filter)
- `tag` (string, optional) — Only files with this tag (Orama `where` filter on `enum[]`)
- `limit` (number, optional, default 10)
- `minScore` (number, optional, default 0.3)

**Returns:** JSON array of results:
```json
[
  {
    "path": "3-order/knowledge/topics/Philosophy of SCI.md",
    "title": "Philosophy of SCI",
    "section": "Motivation",
    "score": 0.87,
    "snippet": "The SCI specification was designed to drive the elimination of carbon emissions..."
  }
]
```

**MCP Tool Description** (what the AI client sees):

```text
Search for documents by meaning, keyword, or both. Returns ranked results with snippets.
Modes: "hybrid" (default, combines keyword + semantic), "vector" (semantic only), "fulltext" (keyword only).
Use "quoted phrases" in the query for exact phrase matching (e.g., '"carbon intensity"').
Use path to limit results to a folder (e.g., "chaos/" or "order/knowledge/").
Use tag to filter by Obsidian tag (e.g., "#recipe", "#topic").
Fulltext mode works without Ollama. Vector and hybrid modes require Ollama running with an embedding model.
Results are ranked by relevance score and deduplicated per file, returning the best-matching section.
```

**Quoted phrase handling:**
1. Parse query for `"quoted phrases"`
2. Extract phrases, pass remaining words as the `term` to Orama
3. After Orama returns results, post-filter by regex matching the exact phrase against chunk `content`
4. QPS proximity scoring naturally boosts documents where words appear close together, so even without quotes, phrase-like queries rank better than with BM25

### Orama Schema v5

Expand the schema to store metadata from Obsidian's `metadataCache`:

```typescript
const schema = {
    // Existing fields
    sourcePath: 'string',
    title: 'string',
    headingPath: 'string',
    content: 'string',
    chunkIndex: 'number',
    mtime: 'number',

    // New: metadata fields
    tags: 'enum[]',           // ['#topic', '#recipe', '#meeting'] from metadataCache
    folder: 'enum',           // top-level folder: '1-chaos', '3-order', etc.

    // Embedding (optional — omitted for files that fail embedding)
    embedding: 'vector[N]',
};
```

**Key insight:** All Orama schema fields are optional at insert time. Documents without embeddings are simply omitted from the vector index but remain fully searchable via BM25/QPS and filterable via `where` clauses.

### QPS Instead of BM25

Replace the default BM25 algorithm with [QPS (Quantum Proximity Scoring)](https://docs.orama.com/docs/orama-js/plugins/plugin-qps):

```typescript
import { pluginQPS } from '@orama/plugin-qps';

const db = create({
    schema,
    id: 'witness-vectors',
    plugins: [pluginQPS()],
});
```

QPS tokenises content into "quantums" and scores based on token proximity. Searching for "carbon intensity" will rank documents where those words appear adjacent much higher than documents where they're scattered.

**Why QPS over BM25 for Witness:**
- Queries are short (2-5 words) — QPS excels at short, focused queries
- Proximity matters — "green software" as a phrase is more relevant than scattered occurrences
- Smaller index size — QPS doesn't store term frequencies
- In hybrid mode, vector search handles longer/semantic queries anyway

### Engine Abstraction

Introduce a `SearchEngine` interface so the Orama implementation can be swapped in the future:

```typescript
interface SearchEngine {
    initialize(): Promise<void>;
    indexFile(file: TFile, options?: { embedding?: number[]; tags?: string[]; folder?: string }): Promise<void>;
    removeFile(path: string): Promise<void>;
    search(query: string, options: SearchOptions): Promise<SearchResult[]>;
    find(options: FindOptions): Promise<FindResult[]>;
    getStaleFiles(files: TFile[]): Promise<TFile[]>;
    getCount(): number;
    save(): Promise<void>;
    clear(): Promise<void>;
    destroy(): void;
}

interface SearchOptions {
    mode: 'hybrid' | 'vector' | 'fulltext';
    limit?: number;
    minScore?: number;
    paths?: string[];
    tags?: string[];
}

interface SearchResult {
    path: string;
    title: string;
    score: number;
    headingPath?: string;
    snippet?: string;
}
```

The current `VectorStore` class becomes `OramaSearchEngine implements SearchEngine`.

### Indexing: All Files, Embeddings Optional

The indexing pipeline changes:

1. **Phase 1 — Content + metadata**: For every markdown file, read content, chunk by headings, extract tags from `metadataCache`, determine folder. Insert into Orama **without embeddings**. This always succeeds.

2. **Phase 2 — Embeddings**: For files that pass the minimum content length filter and where Ollama is available, generate embeddings and update the documents. Failures here don't prevent the file from being searchable via fulltext.

This means:
- Fulltext search works on **every** file in the vault (no blind spots)
- Vector/hybrid search works on the subset that succeeded embedding
- Files that failed embedding are still findable, just without semantic ranking

## Implementation Plan

### Step 1: Engine abstraction
- Define `SearchEngine` interface
- Rename `VectorStore` to `OramaSearchEngine`, implement interface
- Update all consumers to use the interface

### Step 2: Schema v5 + metadata indexing
- Add `tags` (`enum[]`) and `folder` (`enum`) to schema
- Bump `SCHEMA_VERSION` to 5 (v4 was never shipped)
- During indexing, extract tags from `app.metadataCache.getFileCache(file)`
- Index all files first without embeddings, then add embeddings as phase 2
- Install `@orama/plugin-qps`, wire it into database creation

### Step 3: Unified `search` tool
- Replace `search` and `semantic_search` MCP tools with single `search` tool
- Add `path` and `tag` parameters, translate to Orama `where` filters
- Parse quoted phrases from query, post-filter with regex
- Return structured JSON array with snippets

### Step 4: `find` tool
- Replace `find_files` with `find` tool
- Use `app.vault` + `metadataCache` for filename, path, tag, property matching
- Return file list with metadata

### Step 5: Update search panel
- Update `WitnessSearchView` to use the new `SearchEngine` interface
- Add tag/path filter inputs to the search panel UI

### Step 6: Remove old tools
- Remove the brute-force `search` tool
- Remove `semantic_search` tool
- Remove `find_files` tool
- Update README, CLAUDE.md

## Migration

- Schema version bump (v3 → v5) forces full re-index on upgrade
- Old `search` and `semantic_search` tool names removed — MCP clients will see the new `search` tool on next connection
- `find_files` replaced by `find` — similar API but more capable

## Risks and Open Questions

1. **QPS + hybrid mode**: Need to verify that `pluginQPS()` works with Orama's `mode: 'hybrid'` search. The docs show it as a plugin replacement for BM25, but hybrid search's text component may need explicit compatibility testing.

2. **QPS index size vs BM25**: QPS claims smaller indexes, but proximity data may offset this. Need to benchmark on the 4,097-document vault.

3. **Two-phase indexing**: Inserting documents without embeddings then updating them requires either Orama `update()` support or remove-then-reinsert. Need to verify the cleanest approach.

4. **`where` filter + hybrid search**: Need to verify Orama's `where` clause works with all three search modes (fulltext, vector, hybrid).

5. **Breaking change**: Removing `semantic_search` and `search` tool names is a breaking change for any MCP client configurations that reference them by name. Consider keeping `semantic_search` as an alias temporarily.

## Verification

1. `npm run build` — compiles
2. `npm test` — existing tests pass
3. New unit tests for:
   - QPS proximity scoring (close words rank higher than distant)
   - Documents without embeddings found by fulltext
   - Tag filtering via `where` clause
   - Quoted phrase post-filtering
   - `find` tool with path/tag/property filters
4. Manual testing on main vault:
   - Build index, verify all files indexed (not just those with embeddings)
   - Search "carbon intensity" — verify proximity-ranked results
   - Search with `tag: "#topic"` — verify filtered results
   - Search with `path: "chaos/"` — verify folder filtering
   - Compare result quality: QPS vs BM25 on same queries
