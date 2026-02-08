# Feature Spec: Chaos Triage

**Status:** Planned
**Created:** 2026-02-07
**Last Updated:** 2026-02-07

## Overview

A system for processing chaos items one at a time — surfacing the most recent unprocessed item, presenting it for review, and recording the triage decision. Two MCP tools provide the plumbing; a triage prompt drives the conversation.

## Problem Statement

Nearly 1,000 items sit in `1-chaos/` across readwise highlights, inbox captures, transcripts, old evernote imports, and notes. There's no mechanism to systematically work through them, no way to distinguish items that have been reviewed from those that haven't, and no structured workflow for deciding what to do with each one.

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

Returns the next unprocessed chaos item for review.

**Parameters:**
- `path` (optional) — Limit to a specific subfolder, e.g. `1-chaos/internal/inbox` or `1-chaos/external/readwise/articles`. Defaults to all of `1-chaos/`.

**Behaviour:**
1. Scan the target path for markdown files
2. Filter out files where `triage` is set (processed, acknowledged, or deferred with a future date)
3. Include files where `triage` is `deferred` and the deferred date has passed (boomerang)
4. Order by frontmatter `created` or `date` field descending, falling back to file modification time
5. Return the first result: file path, full content, and metadata (source folder, frontmatter)

**Returns:** The file content, path, and metadata — or a message indicating the queue is empty for that path.

#### `triage_chaos`

Records a triage decision for a chaos item.

**Parameters:**
- `path` (required) — Path to the chaos file
- `action` (required) — One of: `processed`, `deferred`, `acknowledged`
- `defer_until` (optional) — Required when action is `deferred`. Date string `YYYY-MM-DD`.

**Behaviour:**
1. Read the file
2. Add or update the `triage` frontmatter field:
   - `processed` → set `triage: YYYY-MM-DD` (today's date)
   - `deferred` → set `triage: deferred YYYY-MM-DD` (the defer_until date)
   - `acknowledged` → set `triage: acknowledged`
3. Write the file back

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

## Implementation Plan

### Phase 1: MCP Tools
1. Implement `get_next_chaos` tool in `src/main.ts`
   - Scan chaos directory recursively for `.md` files
   - Parse frontmatter to check `triage` field
   - Sort by date (frontmatter `created`/`date` field, then file mtime as fallback)
   - Return next unprocessed item with content and metadata
2. Implement `triage_chaos` tool in `src/main.ts`
   - Accept path, action, and optional defer_until
   - Update frontmatter `triage` field accordingly
   - Preserve existing frontmatter fields
3. Add integration tests for both tools

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
- **Queue depth visibility:** Should `get_next_chaos` also return a count of remaining items? Useful for motivation/progress tracking.
- **Re-processing:** A processed item might become relevant again when processing a related item later. The current design doesn't prevent re-visiting, but there's no explicit "re-open" action. May not be needed — the triage prompt can always read any file regardless of its triage status.
