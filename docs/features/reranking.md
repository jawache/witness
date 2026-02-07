# Feature Spec: Ollama-Based Re-ranking

**Status:** Planned
**Created:** 2026-02-07
**Last Updated:** 2026-02-07

## Overview

Add an optional re-ranking stage to semantic search that uses Ollama to score retrieved candidates against the query for higher precision. This is a two-stage retrieval pipeline: broad hybrid search first (optimised for recall), then LLM-based re-ranking (optimised for precision).

## Problem Statement

Embedding-based retrieval (bi-encoders) compresses query and document *independently* into fixed-size vectors, then compares them via cosine similarity. This is fast but lossy — fine-grained relevance signals between specific query terms and document passages are lost in the compression.

For example, searching "how to fix authentication timeout errors" might retrieve:
1. A note about authentication setup (high embedding similarity to "authentication")
2. A note about timeout configuration (high similarity to "timeout")
3. A note about debugging auth timeout errors (actually the most relevant)

Result #3 might rank below #1 and #2 because its overall embedding is a compromise between multiple concepts. A model that reads the query and document *together* can recognise that #3 is the best match.

## Solution

### Two-Stage Retrieval

```
Query
  |
  v
Stage 1: Hybrid Search (fast, broad)
  - Retrieve top-30 candidates
  - BM25 + semantic via Orama
  - Optimised for RECALL (don't miss relevant docs)
  |
  v
Stage 2: Re-ranking (slower, precise)
  - Score each candidate against query via Ollama
  - LLM reads query + document together
  - Optimised for PRECISION (rank the best ones highest)
  |
  v
Return top-K results
```

### Why Ollama for Re-ranking

Since Ollama is already a dependency for embeddings, using it for re-ranking adds no new infrastructure. A small, fast chat model (e.g. `llama3.2:1b`, `phi3:mini`, `qwen2.5:1.5b`) can serve as a relevance judge with reasonable latency.

This is the "LLM-as-judge" pattern, increasingly popular because:
- No specialised cross-encoder model needed
- Flexible prompt allows tuning relevance criteria
- Small models are fast enough for 15-30 candidates
- Works with any Ollama chat model the user already has

## Implementation Plan

### 1. Add `generate()` to OllamaProvider (`src/ollama-provider.ts`)

A new method for calling Ollama's `/api/generate` endpoint:

```typescript
async generate(model: string, prompt: string, options?: { temperature?: number }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { temperature: options?.temperature ?? 0 },
        }),
    });

    if (!res.ok) {
        throw new Error(`Ollama generate failed (${res.status})`);
    }

    const data = await res.json();
    return data.response;
}
```

### 2. Add `rerank()` Method (`src/ollama-provider.ts`)

A batched re-ranking method that sends all candidates in a single prompt:

```typescript
async rerank(
    model: string,
    query: string,
    candidates: Array<{ path: string; content: string }>,
    topK: number = 5
): Promise<Array<{ path: string; score: number }>> {
    // Build a single prompt with all candidates
    const candidateList = candidates.map((c, i) =>
        `[${i}] ${c.path}\n${c.content.substring(0, 500)}`
    ).join('\n\n');

    const prompt = `You are a search relevance judge. Given a query and a list of document excerpts, rate each document's relevance to the query on a scale of 0-10.

Query: "${query}"

Documents:
${candidateList}

For each document, output its index and score in the format: INDEX:SCORE
Output nothing else. One per line.`;

    const response = await this.generate(model, prompt, { temperature: 0 });

    // Parse scores from response
    // Sort by score, return top-K
}
```

**Single prompt approach** — sending all candidates in one prompt rather than one prompt per candidate reduces round-trips from 30 to 1. With a small model processing ~500 chars per candidate x 30 candidates = ~15,000 tokens input, this should complete in 1-3 seconds.

### 3. Search Pipeline (`src/vector-store.ts`)

A new method that chains hybrid search with optional re-ranking:

```typescript
async searchWithReranking(
    query: string,
    options?: {
        limit?: number;
        minScore?: number;
        paths?: string[];
        rerank?: boolean;
        rerankModel?: string;
    }
): Promise<SearchResult[]> {
    // Stage 1: Broad retrieval
    const candidateLimit = options?.rerank ? 30 : (options?.limit ?? 10);
    const candidates = await this.searchHybrid(query, {
        ...options,
        limit: candidateLimit,
    });

    // Stage 2: Re-rank (if enabled)
    if (options?.rerank && options?.rerankModel && candidates.length > 0) {
        // Read content for each candidate
        const withContent = await Promise.all(
            candidates.map(async (c) => ({
                path: c.path,
                content: await this.app.vault.cachedRead(
                    this.app.vault.getAbstractFileByPath(c.path) as TFile
                ),
            }))
        );

        const reranked = await this.ollama.rerank(
            options.rerankModel,
            query,
            withContent,
            options?.limit ?? 10
        );

        return reranked;
    }

    return candidates.slice(0, options?.limit ?? 10);
}
```

### 4. MCP Tool Update (`src/main.ts`)

Add `rerank` parameter to the `semantic_search` tool:

```typescript
rerank: z.boolean().optional().default(false)
    .describe('Enable LLM re-ranking for higher precision (slower, ~1-3s extra)')
```

When `rerank: true`, the tool uses the configured re-rank model from settings.

### 5. Settings (`src/main.ts`)

New settings fields:

```typescript
interface WitnessSettings {
    // ... existing settings ...
    enableReranking: boolean;    // Default: false
    rerankModel: string;         // Default: '' (user must configure)
}
```

**Settings UI additions:**
- Toggle: "Enable re-ranking" (with explanation text)
- Model dropdown: populated from Ollama's available chat models (filtered to exclude embedding-only models)
- Note: "Re-ranking uses a small chat model to improve result quality. Adds 1-3 seconds per search."

## Design Decisions

### Why a Batched Single-Prompt Approach

**Option A: One prompt per candidate** — 30 separate Ollama calls, each asking "rate this document". Simple parsing but 30x latency (~30-60 seconds).

**Option B: All candidates in one prompt** (chosen) — One Ollama call with all 30 candidates. Faster (~1-3 seconds total) but requires structured output parsing. The prompt asks for `INDEX:SCORE` format which is straightforward to parse.

### Why Top-30 for Stage 1

30 candidates is a sweet spot: enough to catch relevant documents that hybrid search might rank at positions 10-30, but not so many that the re-ranking prompt becomes too long. With ~500 chars per candidate, 30 candidates produce ~15,000 tokens — well within context limits of even small models.

### Why Optional by Default

Re-ranking adds latency (1-3 seconds) and requires a separate chat model to be pulled. For quick lookups, hybrid search alone is usually sufficient. Re-ranking shines for ambiguous queries or when you need high confidence in the top results.

The MCP client (e.g. Claude) can decide when to use re-ranking based on the query complexity. Simple lookups use `rerank: false`, complex queries use `rerank: true`.

## Files to Modify

| File | Changes |
|------|---------|
| `src/ollama-provider.ts` | Add `generate()` and `rerank()` methods |
| `src/vector-store.ts` | Add `searchWithReranking()` pipeline method |
| `src/main.ts` | `rerank` parameter on MCP tool, new settings fields and UI |

## Risks and Mitigations

### Risk: Re-ranking model not available

User enables re-ranking but hasn't pulled a suitable chat model.

**Mitigation:** Validate model availability when settings change. Show clear error: "Re-ranking requires a chat model. Run: `ollama pull llama3.2:1b`". Fall back to hybrid-only search if the re-rank model is unavailable at query time.

### Risk: Unreliable structured output from small models

Small models may produce inconsistent `INDEX:SCORE` formatting.

**Mitigation:** Robust parsing with fallbacks. If parsing fails for a candidate, assign it a neutral score (5/10). If total parsing failure, fall back to hybrid-only results. Log warnings for debugging.

### Risk: Latency too high for interactive use

If the re-rank model is slow or large, search could take 5+ seconds.

**Mitigation:** Recommend small models in the settings UI. Show expected latency in the model dropdown. The `rerank` parameter is per-query, so users/clients can choose when the extra precision is worth the wait.

### Risk: Content length exceeds model context

30 candidates x 500 chars = 15,000 chars, but some candidates may be much longer.

**Mitigation:** Truncate each candidate's content to 500 characters in the re-ranking prompt. The model only needs enough context to judge relevance, not the full document. If chunking is enabled, the chunk content is already a manageable size.

### Risk: Re-ranking model disagrees with embedding model

The re-ranker might have different notions of relevance than the embedding model, leading to counterintuitive reorderings.

**Mitigation:** This is actually a feature, not a bug. The re-ranker's cross-attention between query and document provides a different (often better) relevance signal. If results feel wrong, the user can disable re-ranking for that query.

---

*Depends on: [Hybrid search](hybrid-search.md), [Markdown chunking](markdown-chunking.md)*
