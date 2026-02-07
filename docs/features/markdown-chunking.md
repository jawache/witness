# Feature Spec: Markdown-Aware Chunking

**Status:** Planned
**Created:** 2026-02-07
**Last Updated:** 2026-02-07

## Overview

Split documents into sections based on markdown headings before embedding, so each section gets its own vector. This dramatically improves retrieval for long documents where relevant content is buried in a specific section.

## Problem Statement

The current system embeds entire documents as single vectors. Embedding a 5,000-word document into a single 768-dimensional vector is extreme lossy compression — the vector represents a blurry average of everything in the file. If a query is about "sourdough starter" and it's discussed in one paragraph of a 10-page recipe collection, the whole-document embedding won't strongly represent that concept.

This is the most common failure mode in the current system: **relevant content exists in the vault but is buried inside a long document that doesn't rank well as a whole.**

## Solution

### Chunking Strategy: Heading-Based with Fallback

Split documents by markdown headings, respecting the natural structure that already exists in most vault files.

**Primary boundary:** `##` (H2) headings. These represent major topic shifts in a document — "Setup", "Background", "Implementation", "Results". This is where content genuinely changes subject.

**Fallback for long sections:** If an H2 section exceeds ~6,000 characters (~1,500 words), subdivide at `###` (H3) headings within that section.

**Fallback for very long sections:** If a section still exceeds the threshold after H3 splitting, apply fixed-size splitting with 200-character overlap.

**Edge cases:**
- **Content before first heading** ("preamble") becomes its own chunk. This captures introductory text, YAML frontmatter context, and notes that start with content before any heading.
- **Files with no headings** stay as a single chunk — the entire document. No artificial splitting of unstructured notes.
- **H1 (`#`) headings** are treated as document-level separators. Most Obsidian notes have at most one H1 (the title) or none. H1 content before the first H2 is included in the preamble chunk.
- **H4+ headings** are ignored for chunking purposes — they stay within their parent chunk.

### Heading Path Context

Each chunk carries its heading hierarchy as metadata, providing structural context:

```
File: recipes/bread.md

Chunk 0: (preamble)
  headingPath: ""
  content: "A collection of bread recipes I've tested..."

Chunk 1:
  headingPath: "## Sourdough"
  content: "## Sourdough\nMy go-to sourdough recipe..."

Chunk 2:
  headingPath: "## Sourdough > ### Starter Maintenance"
  content: "### Starter Maintenance\nFeed the starter every 12 hours..."

Chunk 3:
  headingPath: "## Focaccia"
  content: "## Focaccia\nThis focaccia recipe uses..."
```

The heading path is prepended to the chunk content before embedding, giving the embedding model structural context about where this chunk sits in the document.

## Implementation Plan

### 1. New File: `src/chunker.ts`

A standalone module for markdown-aware chunking:

```typescript
export interface Chunk {
    content: string;        // The chunk text
    headingPath: string;    // e.g. "## Setup > ### Prerequisites"
    startLine: number;      // Line number in original file
    endLine: number;
    index: number;          // Chunk index within the file
}

export function chunkMarkdown(
    content: string,
    maxChunkChars?: number  // Default ~6000
): Chunk[]
```

**Algorithm:**
1. Scan for `##` heading lines (regex: `/^## /m`)
2. Split content at each `##` boundary
3. Content before the first `##` becomes the preamble chunk (index 0)
4. For each resulting section, check length against threshold
5. If too long, scan for `###` lines within that section and subdivide
6. If still too long, apply fixed-size split with 200-char overlap
7. Track heading hierarchy to build `headingPath` for each chunk
8. If no headings found at all, return the entire content as a single chunk

### 2. Schema Change (`src/vector-store.ts`)

The schema needs to support multiple chunks per document:

```typescript
const schema = {
    id: 'string',               // "filepath#chunk_index" or just filepath for single-chunk
    sourcePath: 'string',       // Original file path (for grouping/deduplication)
    title: 'string',            // File basename
    headingPath: 'string',      // Heading context, e.g. "## Setup > ### Prerequisites"
    content: 'string',          // Chunk text for BM25
    chunkIndex: 'number',       // Position within file (0-based)
    mtime: 'number',            // File modification time
    embedding: `vector[768]`,   // Chunk embedding
};
```

### 3. Indexing Changes (`src/vector-store.ts`)

**`indexFile()`** now calls `chunkMarkdown()` and creates one Orama document per chunk:

```typescript
async indexFile(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const chunks = chunkMarkdown(content);

    // Remove all existing chunks for this file
    await this.removeBySourcePath(file.path);

    // Embed all chunks in one batch
    const textsToEmbed = chunks.map(c =>
        c.headingPath ? `${c.headingPath}\n${c.content}` : c.content
    );
    const embeddings = await this.ollama.embed(textsToEmbed);

    // Insert each chunk
    for (let i = 0; i < chunks.length; i++) {
        await insert(this.db, {
            id: `${file.path}#${i}`,
            sourcePath: file.path,
            title: file.basename,
            headingPath: chunks[i].headingPath,
            content: chunks[i].content,
            chunkIndex: i,
            mtime: file.stat.mtime,
            embedding: embeddings[i],
        });
    }
}
```

**`indexFiles()`** batching logic changes to batch chunks across files rather than whole files, to keep Ollama batch sizes consistent.

### 4. Removal Changes (`src/vector-store.ts`)

**`removeByPath()`** becomes **`removeBySourcePath()`** — must remove all chunks for a given file. Since chunks have IDs like `filepath#0`, `filepath#1`, etc., this needs to find all chunks with matching `sourcePath`.

### 5. Search Deduplication (`src/vector-store.ts`)

When multiple chunks from the same file match a query, deduplicate by taking the highest-scoring chunk per file:

```typescript
// After getting raw hits from Orama
const bestPerFile = new Map<string, SearchResult>();
for (const hit of rawHits) {
    const existing = bestPerFile.get(hit.sourcePath);
    if (!existing || hit.score > existing.score) {
        bestPerFile.set(hit.sourcePath, hit);
    }
}
return Array.from(bestPerFile.values())
    .sort((a, b) => b.score - a.score);
```

### 6. Updated Search Results

Results now include which section matched:

```typescript
export interface SearchResult {
    path: string;           // File path
    title: string;          // File name
    score: number;          // Relevance score
    headingPath?: string;   // Which section matched (e.g. "## Setup > ### Prerequisites")
    snippet?: string;       // First ~200 chars of matching chunk
}
```

The MCP tool result formatting changes to show sections:

```
1. **recipes/bread.md** > Starter Maintenance (84.5%)
2. **projects/fermentation.md** > Overview (72.1%)
```

### 7. Stale File Detection

`getStaleFiles()` checks mtime against the first chunk's stored mtime. If any chunk exists for a file, compare mtime. If different or no chunks exist, mark as stale.

### 8. Index Migration

The schema changes fundamentally (multiple records per file, new fields). On `initialize()`:
1. Load existing index
2. Check for `sourcePath` field in schema
3. If missing, discard old index, create fresh database
4. All files marked stale for re-indexing

## Files to Create/Modify

| File | Changes |
|------|---------|
| `src/chunker.ts` | **New file.** Markdown parsing and chunking logic |
| `src/vector-store.ts` | Multi-chunk schema, chunk-aware indexing, deduplication, `removeBySourcePath()` |
| `src/main.ts` | Updated result formatting to include headingPath/snippet |

## Performance Considerations

**Index size:** ~4k docs x ~5 chunks avg = ~20k vectors. Orama handles this well in-memory.

**Embedding time:** Proportional to total chunks. For 20k chunks at ~100ms per Ollama batch of 20, a full re-index takes ~100 seconds. Incremental indexing (only stale files) keeps day-to-day use fast.

**Persisted index size:** With 20k chunks + content, the JSON file could reach 300-500MB. This is the same memory concern from hybrid search, amplified by chunking. Worth monitoring.

**Search quality vs chunk granularity:** Smaller chunks are more precise but lose context. The heading-based approach preserves natural document structure. Prepending the heading path to the chunk before embedding helps the model understand the chunk's context within the larger document.

## Risks and Mitigations

### Risk: Over-fragmentation of short notes

Short notes (< 500 chars) with multiple headings could produce tiny, low-quality chunks.

**Mitigation:** Only chunk documents that exceed a minimum length threshold (e.g. 1,000 chars). Shorter documents stay as single chunks.

### Risk: Heading-less documents get no benefit

Files without any markdown headings remain as single chunks.

**Mitigation:** This is by design. Artificial splitting of unstructured text would produce chunks without meaningful boundaries. These files still benefit from hybrid search (BM25 keywords + semantic).

### Risk: Chunk boundary artifacts

Content that spans two chunks (a concept introduced at the end of one section and elaborated at the start of the next) may not match well.

**Mitigation:** Heading-based splitting naturally avoids this because headings mark genuine topic shifts. For the fixed-size fallback, 200-char overlap provides continuity.

### Risk: Deduplication hides relevant sections

When multiple chunks from the same file match, only the best-scoring chunk is shown.

**Mitigation:** The `snippet` and `headingPath` in results tell the user exactly which section matched. A future enhancement could optionally return all matching chunks per file.

---

*Depends on: [Hybrid search](hybrid-search.md) (for schema with `content` field)*
*Depended on by: [Re-ranking](reranking.md)*
