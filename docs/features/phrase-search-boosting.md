# Feature Spec: Phrase Search Boosting

**Status:** Complete
**Created:** 2026-02-08
**Last Updated:** 2026-02-08

## Overview

When searching with quoted phrases like `"carbon intensity"`, results containing that exact phrase should appear at the top. Currently phrase matching is weak — it only checks the ~200-char snippet and discards non-matching results entirely instead of ranking them lower.

## Problem Statement

The current `filterByPhrases()` implementation has two issues:

1. **Only checks snippet and title** — not the full chunk content. A document could contain the exact phrase in its body but outside the snippet window, and it would be wrongly excluded.

2. **Binary filter, not a boost** — results without the phrase are discarded entirely. Users want phrase-matching results at the top, but still want to see other relevant results below them.

Orama has no native phrase search — no phrase parameter, no exact phrase mode. QPS (Quantum Proximity Scoring) helps with word proximity but doesn't guarantee contiguous word sequences.

## Solution

**Partition-and-concatenate boosting.** After Orama returns results, split into two groups:
- Results where the full chunk content contains ALL quoted phrases
- Results where it doesn't

Phrase matches appear first, preserving score order within each group. All results are kept — nothing is discarded.

### Why not additive score bonus?

Requires tuning a magic number and can still leave phrase matches below high-scoring non-matches. Partition is simple, deterministic, and matches the user's intent: "if it contains the exact phrase, show it first."

## Implementation Plan

### Step 1: Add `content?: string` to `SearchResult`

**File:** `src/search-engine.ts`

The full chunk text passes through from Orama to the tool handler for phrase checking. The search view and MCP response ignore it.

### Step 2: Populate `content` in `deduplicateAndFilter`

**File:** `src/vector-store.ts` — `deduplicateAndFilter` method

In the `bestPerFile.set()` call, add `content: doc.content` alongside the existing `snippet` field. The Orama schema already stores full content.

### Step 3: Replace `filterByPhrases` with `boostByPhrases`

**File:** `src/main.ts`

```typescript
private boostByPhrases(results: SearchResult[], phrases: string[]): SearchResult[] {
    const phraseMatches: SearchResult[] = [];
    const rest: SearchResult[] = [];

    for (const r of results) {
        const text = (r.content || r.snippet || '').toLowerCase();
        const title = (r.title || '').toLowerCase();
        const searchText = text + ' ' + title;
        const allMatch = phrases.every(p => searchText.includes(p.toLowerCase()));

        if (allMatch) {
            phraseMatches.push(r);
        } else {
            rest.push(r);
        }
    }

    return [...phraseMatches, ...rest];
}
```

### Step 4: Over-fetch when phrases are present

**File:** `src/main.ts` — search tool handler

Phrase boosting reorders results significantly. Fetch 3x the requested limit so phrase matches that QPS ranked low aren't missed, then trim after boosting:

```typescript
const effectiveLimit = phrases.length > 0 ? Math.max(limit * 3, 30) : limit;
```

### Step 5: Strip `content` from MCP response

The existing `jsonResults` mapping already selects only `path`, `title`, `section`, `score`, `snippet` — `content` is automatically excluded. No change needed.

## Files to modify

- `src/search-engine.ts` — add `content?: string` to `SearchResult`
- `src/vector-store.ts` — pass `doc.content` through in `deduplicateAndFilter`
- `src/main.ts` — replace `filterByPhrases` with `boostByPhrases`, over-fetch for phrase queries
- `src/search-view.ts` — **no changes**

## Verification

1. `npm run build` — compiles
2. `npm test` — unit tests pass
3. Search `"carbon intensity"` — docs with exact phrase appear first
4. Search `carbon intensity` (no quotes) — normal QPS ranking, no phrase boost
5. Search `"some phrase" other words` — phrase matches boosted, other words still contribute to ranking
