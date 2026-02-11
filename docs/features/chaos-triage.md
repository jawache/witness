# Feature Spec: Chaos Triage

**Status:** Planned
**Created:** 2026-02-07
**Last Updated:** 2026-02-11

## Overview

A system for processing chaos items — surfacing unprocessed items for review and recording triage decisions. Two MCP tools handle the mechanics: `get_next_chaos` fetches items with full content, `mark_triage` records the decision by writing frontmatter. This removes the AI's need to manually query files, parse frontmatter, or figure out what fields to set.

## Problem Statement

Nearly 1,000 items sit in `1-chaos/` across readwise highlights, inbox captures, transcripts, old evernote imports, and notes. There's no mechanism to systematically work through them, no way to distinguish items that have been reviewed from those that haven't, and no structured workflow for deciding what to do with each one.

Two additional problems surfaced from real usage:

1. **AI fumbles frontmatter:** When asked to triage, the AI guesses at field names, formats, and values. It tries to read files, parse YAML, set fields via `edit_file`, and frequently gets it wrong. Dedicated tools eliminate this — the AI calls `mark_triage` with an action, and the tool handles the frontmatter correctly every time.

2. **Redundant round-trips:** The AI calls `get_next_chaos` to get a path, then calls `read_file` to read the content. By returning the full file content in `get_next_chaos`, we save a tool call and make the workflow snappier.

The goal isn't to process everything — it's to keep on top of new incoming items by working most-recent-first, making a conscious decision about each one, and recording that decision so items don't resurface.

## Solution

### Frontmatter: The `triage` Field

A single frontmatter field tracks the state of every chaos item:

```yaml
# Not yet reviewed (field absent entirely)
---
title: Some Article
---

# Processed — knowledge extracted, date records when
---
triage: 2026-02-07
---

# Deferred — come back after this date (boomerang)
---
triage: deferred 2026-02-14
---

# Acknowledged — seen it, no action needed, don't show again
---
triage: acknowledged
---
```

**Rules:**
- No `triage` field = unprocessed (the default for all existing files)
- A bare date (`YYYY-MM-DD`) = processed on that date
- `deferred YYYY-MM-DD` = show again after that date
- `acknowledged` = consciously reviewed, no extraction needed, stays in chaos as-is for semantic search

**Files never move.** A processed chaos item stays exactly where it is. The extracted knowledge in `3-order/` links back to it via the `references` frontmatter field for provenance.

### MCP Tools

#### `get_next_chaos`

Returns unprocessed chaos items for review — either the next single item (default) or a list.

**Parameters:**
- `path` (optional) — Limit to a specific subfolder, e.g. `1-chaos/internal/inbox` or `1-chaos/external/readwise/articles`. Defaults to `1-chaos/`.
- `list` (optional, boolean) — When `true`, return a list of all pending items with metadata (not full content). Defaults to `false` (returns the next single item with full content).

**Behaviour:**
1. Scan the target path recursively for markdown files
2. Filter out files where `triage` is set to a date (processed), `acknowledged`, or `deferred` with a future date
3. Include files where `triage` is `deferred` and the deferred date has passed (boomerang)
4. Order by frontmatter `created` or `date` field descending, falling back to file modification time
5. **Single mode** (default): Return the first result with full file content, path, frontmatter, and queue count
6. **List mode** (`list: true`): Return all pending items with path, frontmatter summary (title, description, date, source/author if present), and queue count — but not full content

**Returns (single mode):**
```json
{
  "path": "1-chaos/external/readwise/articles/some-article.md",
  "content": "---\ntitle: Some Article\nauthor: ...\n---\n\nFull file content here...",
  "frontmatter": { "title": "Some Article", "author": "...", "date": "2026-02-01" },
  "queue": { "total": 847, "in_path": 312 }
}
```

**Returns (list mode):**
```json
{
  "items": [
    {
      "path": "1-chaos/external/readwise/articles/some-article.md",
      "title": "Some Article",
      "description": "First 100 chars or frontmatter description...",
      "date": "2026-02-01",
      "source": "readwise"
    }
  ],
  "queue": { "total": 847, "in_path": 312 }
}
```

**Returns (empty):** A message indicating the queue is empty for that path, with queue counts showing zero.

#### `mark_triage`

Records a triage decision for a chaos item. Handles all frontmatter manipulation — the AI never needs to parse or write YAML directly.

**Parameters:**
- `path` (required) — Path to the chaos file
- `action` (required) — One of: `processed`, `deferred`, `acknowledged`
- `defer_until` (optional) — Required when action is `deferred`. Date string `YYYY-MM-DD`.

**Behaviour:**
1. Read the file
2. Parse existing frontmatter (or create it if absent)
3. Add or update the `triage` frontmatter field:
   - `processed` → set `triage: YYYY-MM-DD` (today's date)
   - `deferred` → set `triage: deferred YYYY-MM-DD` (the defer_until date)
   - `acknowledged` → set `triage: acknowledged`
4. Preserve all existing frontmatter fields
5. Write the file back
6. Return confirmation with the action taken

**Returns:**
```json
{
  "path": "1-chaos/external/readwise/articles/some-article.md",
  "action": "processed",
  "triage": "2026-02-11"
}
```

### Triage Prompt

A prompt (living in `2-life/prompts/` in the main vault, or as a Witness skill) that drives the triage conversation. The prompt:

1. Calls `get_next_chaos` to fetch the next item
2. Reads the content and adapts based on what it's looking at:
   - **Article/highlights** — summarises key points, asks what's worth extracting as topics
   - **Voice transcript** — identifies key themes and insights, offers to extract quotes or reflections
   - **Quick capture/URL** — presents it, asks if it's worth expanding into a proper note
   - **Readwise book highlights** — groups highlights by theme, suggests which concepts deserve their own topic notes
3. Presents the item and asks: "What would you like to do?"
   - **Process it** — extract knowledge into `3-order/`, then mark as processed
   - **Defer it** — set a boomerang date, move on
   - **Acknowledge it** — it's fine as-is for search, mark and move on
4. After the action, offers to fetch the next item or stop

The prompt should evolve over time as patterns emerge from repeated triage sessions. Eventually, it could suggest likely actions based on the source type and content.

### Ancillary Fix: `edit_file` Error Guidance

When `edit_file` fails because the find text isn't found, the error message should guide the AI toward the right tool:

```
Text not found in file: "...". The file may have changed since you last read it.
To replace the entire file contents, use write_file instead.
To make targeted edits, re-read the file first with read_file, then retry edit_file with the current content.
Do NOT delete and recreate the file — this loses file metadata and timestamps.
```

This prevents the delete+recreate antipattern that loses file timestamps and metadata.

## Implementation Plan

### Phase 1: MCP Tools
1. Implement `get_next_chaos` tool in `src/main.ts`
   - Scan chaos directory recursively for `.md` files
   - Parse frontmatter to check `triage` field (using Obsidian's `metadataCache`)
   - Handle deferred date comparison (parse `deferred YYYY-MM-DD`, compare with today)
   - Sort by date (frontmatter `created`/`date` field, then file mtime as fallback)
   - Single mode: return next unprocessed item with full content and queue count
   - List mode: return all pending items with frontmatter summary and queue count
2. Implement `mark_triage` tool in `src/main.ts`
   - Accept path, action, and optional defer_until
   - Parse existing frontmatter robustly (handle absent frontmatter, malformed YAML)
   - Update `triage` field accordingly
   - Preserve all existing frontmatter fields
3. Improve `edit_file` error message to guide toward `write_file` and away from delete+recreate
4. Add integration tests for both triage tools

### Phase 2: Triage Prompt
1. Write the triage prompt for `2-life/prompts/chaos-triage.md` in the main vault
2. Include content-type detection logic (readwise vs transcript vs inbox vs notes)
3. Include instructions for knowledge extraction workflow (using existing orientation conventions)
4. Test with real chaos items across different source types

### Phase 3: Iteration
1. Refine the prompt based on actual triage sessions
2. Add statistics — "you've processed 47 items, 312 remaining in inbox"
3. Consider batch mode for similar items (e.g. "show me all readwise articles tagged #nutrition")
4. Evolve towards semi-autonomous processing for well-understood content types

## Open Questions

- **Timestamp normalisation:** Readwise bulk-synced files all share the same mtime. Need to ensure frontmatter `date`/`created` fields are reliable for ordering. May need a one-off script to normalise dates from Readwise metadata.
- **Triage field format:** The single-field approach (`triage: deferred 2026-02-14`) is compact but unconventional. If it proves awkward to query in Dataview, consider splitting into `triage-status` and `triage-date`.
- **Re-processing:** A processed item might become relevant again when processing a related item later. The current design doesn't prevent re-visiting, but there's no explicit "re-open" action. May not be needed — the triage prompt can always read any file regardless of its triage status.
