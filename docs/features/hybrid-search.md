# Feature Spec: Hybrid Search (BM25 + Semantic)

**Status:** Planned
**Created:** 2026-02-07
**Last Updated:** 2026-02-07

## Overview

Add hybrid search combining BM25 keyword matching with semantic vector similarity, using Orama's built-in `mode: 'hybrid'` and Reciprocal Rank Fusion (RRF). This is the single highest-impact improvement to semantic search quality with the lowest implementation effort, because Orama already has the machinery built in.

## Problem Statement

The current `semantic_search` tool uses only vector cosine similarity. This has a fundamental blind spot: **keyword-exact queries miss.** If you search for "Dataview" and a note mentions it once in the middle of a long document, pure semantic search may rank it low because the whole-document embedding represents a blurry average of all content. A keyword search finds it instantly.

Similarly, proper nouns, filenames, specific terminology, and rare words are poorly served by embedding-only retrieval. The embedding model may not have strong representations for domain-specific vocabulary in your vault.

## Solution

### Why Hybrid Works

Two retrieval methods cover each other's weaknesses:

| Query type | BM25 (keyword) | Semantic (vector) |
|------------|----------------|-------------------|
| Exact term: "Dataview" | Excellent | May miss |
| Concept: "managing daily notes" | Poor | Excellent |
| Proper noun: "John Smith" | Excellent | Variable |
| Synonym: "automobile" when doc says "car" | Misses | Excellent |
| Mixed: "Dataview daily notes query" | Partial | Partial |

Hybrid search runs both and merges results using **Reciprocal Rank Fusion (RRF)**, which combines ranked lists without needing to normalise incompatible score scales.

### RRF Formula

```
RRF Score = Sum across retrievers of: 1 / (rank + k)
```

Where `k = 60` (empirically optimal). RRF only looks at position in each ranked list, not raw scores, so it doesn't matter that BM25 scores are unbounded numbers while cosine similarity is 0-1.

### Key Insight: Orama Already Supports This

Orama v3.1.18 (already installed) has built-in hybrid search via the `search()` function with `mode: 'hybrid'`. It handles BM25 indexing, vector search, and RRF merging internally. The only thing missing is a `content` string field in our schema for BM25 to index against.

**Current schema** (vector-only):
```typescript
{
    path: 'string',
    title: 'string',
    mtime: 'number',
    embedding: `vector[768]`
}
```

**New schema** (hybrid-capable):
```typescript
{
    path: 'string',
    title: 'string',
    content: 'string',    // NEW: enables BM25 full-text search
    mtime: 'number',
    embedding: `vector[768]`
}
```

## Implementation Plan

### 1. Schema Change (`src/vector-store.ts`)

Add `content: 'string'` to the Orama schema. Store full document content (no truncation).

### 2. Import Change (`src/vector-store.ts`)

The current import:
```typescript
import { create, insert, remove, search, searchVector, save, load, count, getByID } from '@orama/orama';
```

Already includes `search` — this is the unified function that supports all three modes (`fulltext`, `vector`, `hybrid`).

### 3. Indexing Change (`src/vector-store.ts`)

In `indexFile()` and `indexFiles()`, store the document content alongside the embedding:

```typescript
await insert(this.db, {
    id: file.path,
    path: file.path,
    title: file.basename,
    content: content,          // Full document text for BM25
    mtime: file.stat.mtime,
    embedding,
});
```

### 4. New Hybrid Search Method (`src/vector-store.ts`)

Add a `searchHybrid()` method using Orama's unified `search()`:

```typescript
async searchHybrid(
    query: string,
    options?: { limit?: number; minScore?: number; paths?: string[] }
): Promise<SearchResult[]> {
    const queryEmbedding = await this.ollama.embedOne(query);

    const results = await search(this.db, {
        mode: 'hybrid',
        term: query,
        vector: { value: queryEmbedding, property: 'embedding' },
        properties: ['title', 'content'],
        similarity: options?.minScore ?? 0.3,
        limit: options?.limit ?? 10,
        hybridWeights: { text: 0.3, vector: 0.7 },
        boost: { title: 2 },
    });

    // Map hits to SearchResult[]
}
```

**`hybridWeights: { text: 0.3, vector: 0.7 }`** — semantic-heavy default, since most queries to a knowledge vault are conceptual. Can be tuned later.

**`boost: { title: 2 }`** — title matches count double in the BM25 component. A document titled "Sourdough Starter" should rank higher than one that merely mentions it.

### 5. MCP Tool Update (`src/main.ts`)

Add optional `mode` parameter to the `semantic_search` tool:

```typescript
mode: z.enum(['hybrid', 'vector', 'fulltext']).optional().default('hybrid')
    .describe('Search mode: hybrid (keyword+semantic), vector (semantic only), fulltext (keyword only)')
```

Route to the appropriate search method based on mode.

### 6. Index Migration

On `initialize()`, detect old schema (no `content` field). If detected, discard the saved index and trigger a full re-index on next search. Show an Obsidian `Notice`: "Search index upgrading to hybrid mode. First search will take a moment."

### 7. Orama API Reference

Key types from `@orama/orama`:

```typescript
type HybridWeights = {
    text: number;    // Weight for BM25 full-text results
    vector: number;  // Weight for vector similarity results
};

interface SearchParamsHybrid {
    mode: 'hybrid';
    term: string;                                    // Query text for BM25
    vector: { value: number[]; property: string };   // Query embedding for vector
    properties?: string[];                           // Which fields BM25 searches
    similarity?: number;                             // Min cosine similarity (0-1)
    limit?: number;
    hybridWeights?: HybridWeights;
    boost?: Record<string, number>;                  // BM25 field boosting
    relevance?: BM25Params;                          // BM25 tuning (k, b, d)
    threshold?: number;                              // BM25 term matching threshold
    where?: WhereCondition;                          // Filters
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/vector-store.ts` | Schema change, `searchHybrid()` method, content storage in indexing, migration logic |
| `src/main.ts` | `mode` parameter on `semantic_search` tool, route to hybrid/vector/fulltext |

## Memory Considerations

Storing full content in Orama increases RAM usage since Orama is fully in-memory. Rough estimates for a 4k-document vault:

| Component | Current | With content |
|-----------|---------|-------------|
| Vectors | ~12MB | ~12MB |
| BM25 index | None | ~20-40MB |
| Raw content | None | ~50-100MB |
| **Total** | **~15-20MB** | **~80-150MB** |

This is noticeable but tolerable for desktop Obsidian. If memory becomes a problem at larger vault sizes, alternative storage backends (e.g. SQLite with FTS5) could be explored as a separate feature.

## Risks and Mitigations

### Risk: Increased index size on disk

The persisted `.witness/index.orama` JSON file will grow significantly with full content stored.

**Mitigation:** Accept for now. The file is only loaded once on startup. If disk size becomes problematic, content could be excluded from the serialised snapshot and re-read from vault files on load.

### Risk: BM25 noise on short queries

Single-word queries may produce noisy BM25 results that dilute the hybrid ranking.

**Mitigation:** The `hybridWeights: { text: 0.3, vector: 0.7 }` default already favours semantic results. Users can also use `mode: 'vector'` to bypass BM25 entirely for specific queries.

### Risk: Re-index required on upgrade

Users upgrading from vector-only to hybrid will need a full re-index.

**Mitigation:** This happens automatically and lazily on first search. An Obsidian Notice informs the user. For a 4k-doc vault, re-indexing takes ~2-3 minutes.

---

*Depends on: [Ollama integration](ollama-integration.md) (complete)*
*Depended on by: [Markdown chunking](markdown-chunking.md), [Re-ranking](reranking.md)*
