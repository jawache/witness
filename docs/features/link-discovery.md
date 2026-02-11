# Feature Spec: Link Discovery

**Status:** Planned
**Created:** 2026-02-11
**Last Updated:** 2026-02-11

## Overview

Automatically discover meaningful connections between notes using existing embeddings for cheap candidate detection, then validate and generate link text via local Ollama LLM. Suggestions appear in a Grammarly-style review panel for human accept/reject decisions. The system is tuned to be conservative — most comparisons should yield no suggestion, surfacing only genuinely useful links.

## Problem Statement

Building a richly linked knowledge base is one of the most valuable things you can do in a vault, but it's also one of the most tedious. You have to remember that a relevant note exists, find it, choose the right anchor text, and create the link. With thousands of notes, the connections between them are invisible — two notes about the same concept sit unlinked because no human noticed the relationship.

Existing tools either auto-link based on exact title matches (too simplistic) or require expensive cloud AI calls (too costly for thousands of comparisons). Witness already has local embeddings for every chunk in the vault — we can use this infrastructure to discover connections cheaply, then use a local LLM for the creative work of validating and generating link text.

## Solution

### Two-Stage Pipeline

**Stage 1 — Candidate Discovery (Cheap)**

Use existing chunk embeddings to find similar chunks across *different* files. This is a vector similarity search, already built into the search engine. For a given chunk, find the top-N most similar chunks from other documents. If the similarity score exceeds a threshold, the pair becomes a candidate.

This stage is fast and free — no LLM calls, just cosine similarity on vectors we already have.

**Stage 2 — LLM Validation & Link Generation (Focused)**

Pass each candidate pair to a local Ollama LLM with a short, focused prompt:

> Here are two passages from different notes. If there's a meaningful connection, suggest a link by:
> 1. Picking a specific word or short phrase in Passage A that could naturally link to Passage B
> 2. Explaining briefly why they're connected
>
> If there's no meaningful connection, respond with "none".
>
> Passage A (from "Note Title A"):
> [chunk content]
>
> Passage B (from "Note Title B"):
> [chunk content]

The LLM does creative text generation — it finds the right anchor words in the source text and determines whether a link is genuinely useful. This is a short prompt with a short response, suitable for small local models.

### Link Model

- **Source**: A specific word or phrase in the body text of a note (the anchor). The LLM picks this creatively — it's not necessarily a heading or title match.
- **Target**: A heading within a document, or the document itself (if no specific heading is more relevant).
- **Bidirectional**: A suggestion to link A→B is independent from B→A. The system may suggest both, one, or neither. Each direction has its own anchor text and is accepted/rejected independently.

### Triggers

Three ways link discovery runs:

1. **On-demand command**: "Find relevant links" — scans the current file against the full index. The user triggers this explicitly via command palette.
2. **On-file-change**: When a file is indexed (new or modified), automatically check its chunks against the index. Suggestions appear without user action.
3. **Background sweep**: Systematic scan across all files. Can run overnight or during idle periods. Processes files that haven't been checked yet.

### Review Panel UI

A sidebar panel (similar to Witness Search) shows pending link suggestions:

- Each suggestion shows: source file, anchor text (highlighted), target file/heading, LLM's reasoning
- **Accept**: Inserts the `[[wikilink]]` at the anchor position in the source file. The anchor text becomes the link display text: `[[target|anchor text]]`
- **Reject**: Marks the suggestion as rejected. It disappears from the active list and won't be suggested again.
- **Undo**: Standard undo support — accepting a link can be reversed. The file edit is undoable via Obsidian's normal undo.

Clicking a suggestion navigates to the source file and highlights the anchor text, so the user can see it in context before deciding.

### Rejected Suggestions

- Stored persistently (in `.witness/` data files)
- A "Rejected" tab or section in the review panel shows all rejected suggestions, newest first
- Rejected suggestions are keyed by source chunk + target, so they survive file edits as long as the chunk exists
- Users can un-reject a suggestion if they change their mind

### Tuning & Noise Reduction

This is the critical design challenge. Most chunk pairs should yield no suggestion — the system must be conservative.

**Similarity Threshold**: Only pass pairs above a configurable cosine similarity threshold to the LLM. This is the first line of defence against noise. Default should be high enough that most pairs are filtered out (e.g., 0.75+). Tunable in settings.

**Prompt Design**: The LLM prompt explicitly permits "none" responses and frames link-finding as optional:
- "If there's a meaningful connection..." (not "find the connection")
- "If there's no meaningful connection, respond with 'none'"
- The prompt should emphasise quality over quantity — only suggest links that a human would find genuinely useful

**Confidence Scoring**: The LLM can return a confidence level alongside suggestions. Low-confidence suggestions can be filtered or shown separately.

**Rate Limiting**: Cap the number of suggestions surfaced per file (e.g., max 5) to avoid overwhelming the user. Additional candidates are queued but not shown until existing ones are resolved.

**Same-file Exclusion**: Never suggest links between chunks in the same file.

**Existing Link Detection**: Skip suggestions where a link between the two files already exists in either direction.

## Implementation Plan

### Phase 1 — Core Pipeline

1. **Candidate discovery function**: Given a file's chunks, query the search engine for similar chunks from other files. Filter by similarity threshold and exclude same-file matches.
2. **LLM validation**: Send candidate pairs to Ollama chat endpoint. Parse structured response (anchor text, target, reasoning, or "none").
3. **Suggestion storage**: Persist pending and rejected suggestions in `.witness/link-suggestions.json`.
4. **On-demand command**: Register "Witness: Find relevant links" command that runs the pipeline for the active file.

### Phase 2 — Review Panel

5. **Sidebar view**: New `ItemView` showing pending suggestions with accept/reject buttons.
6. **Accept action**: Insert wikilink at anchor position in source file.
7. **Reject action**: Move suggestion to rejected store.
8. **Navigation**: Click suggestion to open source file and highlight anchor.
9. **Rejected tab**: View and un-reject past rejections.

### Phase 3 — Automation

10. **On-file-change trigger**: Hook into the existing indexing pipeline — after a file is indexed, run candidate discovery for its chunks.
11. **Background sweep**: Periodic scan of un-checked files, similar to reconciliation timer.
12. **Settings UI**: Threshold sliders, max suggestions per file, enable/disable triggers.

## Data Model

```typescript
interface LinkSuggestion {
  id: string;                    // Unique suggestion ID
  sourceFile: string;            // Path of the file containing the anchor
  sourceChunkId: string;         // Chunk ID in the source file
  anchorText: string;            // The word/phrase to become a link
  anchorOffset?: number;         // Character offset in the chunk (for precise insertion)
  targetFile: string;            // Path of the target file
  targetHeading?: string;        // Specific heading, if applicable
  similarity: number;            // Cosine similarity score from stage 1
  confidence?: number;           // LLM confidence score from stage 2
  reasoning: string;             // LLM's explanation of the connection
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;             // Timestamp
  resolvedAt?: number;           // When accepted/rejected
}
```

## Risks & Mitigations

### LLM Quality

Small local models may produce poor anchor text or force connections that aren't there.

**Mitigation:** Extensive prompt engineering. Allow "none" responses. Test with multiple models (llama3.2, mistral, phi3). The similarity threshold pre-filters most noise before the LLM sees it.

### Anchor Text Insertion

Finding the exact position in the source file to insert the link is fragile — the file may have changed since the suggestion was generated.

**Mitigation:** Store enough context around the anchor (surrounding sentence) to relocate it. If the anchor text can't be found, mark the suggestion as stale and discard it.

### Scale

A vault with 4,000 files could have millions of chunk pairs.

**Mitigation:** Only compare chunks above the similarity threshold (the vector search already handles this efficiently). Process in batches. The background sweep is low-priority and can be throttled.

### LLM Availability

Ollama may not be running when suggestions are needed.

**Mitigation:** Queue suggestions for LLM validation. Candidate discovery (stage 1) works without Ollama. Stage 2 runs when Ollama becomes available.

---

*Depends on: [Ollama integration](ollama-integration.md) (complete), [Background indexing](background-indexing.md) (complete)*
*Enhances: Vault interconnectedness, knowledge discovery*
