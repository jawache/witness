# Feature Spec: Link Discovery Spike

**Status:** In Progress
**Created:** 2026-02-13
**Last Updated:** 2026-02-13
**Parent:** [Link Discovery](link-discovery.md) (full spec)

## Overview

A minimal, throwaway spike to validate whether local LLMs can produce useful link suggestions between vault notes. One command, one modal, no persistence. The goal is to answer: "Is the LLM output good enough to build a full feature around?"

## Problem Statement

The full link discovery spec describes a two-stage pipeline (vector candidates → LLM validation) with a review panel, persistence, background sweeps, and automation. Before building any of that, we need to know if small local models (3-8B) can reliably:

1. Judge whether two passages are meaningfully connected
2. Pick good anchor text in the source passage
3. Know when to say "no link here"

If the LLM quality is poor (as it was with re-ranking), the full feature isn't worth building yet.

## Solution

### Command: "Witness: Discover links"

A single command palette action that:

1. Gets the current file's chunks from the index (already indexed by background indexing)
2. For each chunk, runs a vector search for the top candidates from other files
3. Deduplicates candidates by target file (one suggestion per target, keep highest similarity)
4. Sends each candidate pair to Ollama with a validation prompt
5. Displays all suggestions in a modal

### Candidate Discovery

- Use `vectorStore.search()` with `mode: 'vector'` for each chunk
- Top 3 candidates per chunk, minimum similarity threshold of 0.75
- Exclude chunks from the same file
- Deduplicate by target file across all chunks — keep the pair with highest similarity
- Cap total candidates at 10 (to keep LLM calls fast)

### LLM Validation Prompt

```
You are a knowledge-linking assistant. Given two passages from different notes in a personal knowledge vault, determine if there is a meaningful connection that would benefit from a wiki-link.

If there IS a meaningful connection:
- Pick a specific word or short phrase (2-5 words) in Passage A that could naturally become a [[wiki-link]] to Passage B
- Explain the connection in one sentence

If there is NO meaningful connection, respond with just: NONE

Respond in this exact format (or NONE):
ANCHOR: [the word or phrase from Passage A]
REASON: [one sentence explanation]

Passage A (from "{{sourceTitle}}"):
{{sourceContent}}

Passage B (from "{{targetTitle}}"):
{{targetContent}}
```

### Response Parsing

Parse LLM response for `ANCHOR:` and `REASON:` lines. If response contains "NONE" or can't be parsed, discard the candidate. This mirrors the graceful degradation pattern from re-ranking (structured parse → regex fallback → discard).

### Results Modal

A simple Obsidian `Modal` showing:

- File title at top
- Each suggestion as a card:
  - Source chunk snippet (with anchor text highlighted if found)
  - Arrow → Target file title and heading
  - LLM's reasoning
  - Similarity score
- "No suggestions found" if all candidates returned NONE

No accept/reject buttons — this is read-only for evaluation. The user manually creates links if they agree with the suggestions.

## Implementation Plan

1. **Register command** in `main.ts`: "Witness: Discover links"
2. **`discoverLinks(file)` method** in `main.ts`:
   - Get file's chunks from index (by sourcePath)
   - For each chunk, vector search for candidates
   - Deduplicate by target file
   - Call Ollama for each candidate
   - Return array of suggestions
3. **`LinkDiscoveryModal`** class (new file or in `main.ts`):
   - Extends `Modal`
   - Renders suggestions as cards
   - Shows loading state while LLM processes
4. **Prompt template** and response parser

### Files to Change

- `src/main.ts` — Command registration, `discoverLinks()` method
- `src/link-discovery-modal.ts` — New file for the modal UI (or inline in main.ts if small enough)

### Dependencies

- Existing: `vectorStore.search()`, `ollamaProvider.generate()`, chunk index
- Requires: Ollama running with a chat model, index built

## What We're Evaluating

After the spike, assess:

1. **Anchor text quality**: Does the LLM pick sensible phrases, or forced/awkward ones?
2. **Connection judgement**: Does it correctly identify real connections and reject noise?
3. **"NONE" rate**: A good sign is that most candidates return NONE — the LLM is being selective
4. **Model sensitivity**: Do results vary significantly between models (llama3.2, mistral, phi3)?
5. **Speed**: How long does the full pipeline take for a typical file?

## Out of Scope

- Persistence (no saving suggestions)
- Accept/reject workflow
- Auto-insertion of wikilinks
- Background/automatic triggers
- Rejected suggestion tracking
- Settings UI

This is deliberately throwaway. If the results are promising, we build the real thing from the full spec.
