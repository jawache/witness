# Feature Spec: Find Tool Sorting

**Status:** Complete
**Created:** 2026-02-08
**Last Updated:** 2026-02-08

## Overview

Add a `sortBy` parameter to the `find` MCP tool so results can be sorted by frontmatter properties (especially dates) or built-in file properties. The primary use case is finding files in a folder sorted by a date/datetime property in reverse chronological order.

## Problem Statement

The `find` tool currently returns files in whatever order the vault API provides, with no sorting capability. Users want to:

- Find files in a folder sorted by a frontmatter `created` property, newest first
- Sort by any frontmatter property that contains a date or datetime
- Sort by built-in properties like file modification time, size, or name

The existing `property` filter also only does exact string matching, which limits its usefulness for date-based queries.

## Solution

Add a `sortBy` parameter that accepts a property name and sort direction. Auto-detect date and datetime values from the actual data — ISO format strings (YYYY-MM-DD and YYYY-MM-DDTHH:MM:SS) sort correctly with `localeCompare`, so no Date parsing is needed.

### Key design decisions

- **Sort by the property the user specifies** — no implicit defaults to `mtime` or other built-in properties
- **Auto-detect dates and datetimes** — sample the actual values to check if they match ISO date/datetime patterns (`/^\d{4}-\d{2}-\d{2}/`)
- **Default direction** — `desc` for date/datetime properties, `asc` for strings
- **Nulls sort to end** — files missing the sort property always appear last regardless of direction
- **Support built-in properties** — `mtime`, `size`, `name` as convenience, extracted from `file.stat` / `file.basename`

## Implementation Plan

### Step 1: Add `sortBy` parameter to Zod schema

**File:** `src/main.ts` — find tool registration

```typescript
sortBy: z.object({
    property: z.string().describe('Property to sort by: frontmatter name (e.g., "created") or built-in: "mtime", "size", "name"'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction. Defaults to "desc" for dates, "asc" for strings'),
}).optional().describe('Sort results by a property'),
```

### Step 2: Implement sorting logic

**File:** `src/main.ts` — find tool handler, between property filter and limit

- Extract sort value: `mtime`/`size` from `file.stat`, `name` from `file.basename`, everything else from `metadataCache.getFileCache(file).frontmatter[prop]`
- Auto-detect dates/datetimes: sample files to check if values match `/^\d{4}-\d{2}-\d{2}/`
- Default direction: `desc` for dates/datetimes and `mtime`, `asc` otherwise
- Nulls always sort to end regardless of direction
- ISO date/datetime strings sort correctly with `localeCompare` (no Date parsing needed)

### Step 3: Update tool description

Add mention of `sortBy` to the tool's description string so AI clients know it's available.

### Step 4: Add `sortBy` to destructured params

`async ({ pattern, path, tag, property, limit, sortBy })`

## Frontmatter date storage

Obsidian's `metadataCache.getFileCache(file).frontmatter` stores dates as raw strings from YAML parsing:
- `created: 2026-01-20` → string `"2026-01-20"`
- `created: 2026-01-20T14:30:00` → string `"2026-01-20T14:30:00"`
- No automatic Date object conversion

Both date and datetime ISO strings sort correctly with `localeCompare`.

## Files to modify

- `src/main.ts` — add `sortBy` param, sorting logic, update tool description

## Verification

1. `npm run build` — compiles
2. `npm test` — unit tests pass
3. `find` with `sortBy: { property: "created", direction: "desc" }` and `path: "3-order/"` — files sorted by created date, newest first
4. `find` with `sortBy: { property: "created" }` — auto-defaults to desc (date detected)
5. `find` with `sortBy: { property: "name" }` — alphabetical ascending
6. Files missing the `created` property sort to the end
