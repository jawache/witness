# Feature Spec: Chaos Queue Panel

**Status:** Planned
**Created:** 2026-02-22
**Last Updated:** 2026-02-22

## Overview

A dedicated side panel for manually triaging chaos items, plus keyboard shortcuts, file explorer context menu actions, and bulk operations. The panel shows all untriaged chaos items grouped by priority ("Next Up" first, then everything else), with inline actions to acknowledge, prioritise, or archive items. The same data function powers both this panel and the `get_next_chaos` MCP tool, ensuring consistent ordering.

## Problem Statement

Today, chaos triage is exclusively AI-driven — you call `get_next_chaos` via an MCP client and go back and forth one item at a time. This works for deep processing (reading an article, extracting knowledge) but is overkill for the many items that just need a quick manual decision:

- **Bulk acknowledgement**: A folder of 200 Readwise highlights where you already know the content — you just want to mark them all as acknowledged in one action.
- **Quick kills**: Files you can tell from the title alone should go straight to death — old imports, duplicates, irrelevant captures.
- **Priority flagging**: While scanning the list, you spot three items you want to process next — you need a way to star them without opening each one.
- **Visual overview**: No way to see the full queue, its size, what folders are heaviest, or what you've already flagged as next up.

The MCP tools handle the AI workflow well. This feature handles the manual, visual, bulk workflow that complements it.

## Solution

### 1. Shared Data Function: `getChaosQueue()`

A single function used by both the Chaos Queue panel and the `get_next_chaos` MCP tool. Ensures identical filtering, sorting, and grouping everywhere.

```typescript
interface ChaosQueueItem {
    file: TFile;
    path: string;
    title: string;            // frontmatter title or file.basename
    date: string;             // frontmatter created/date or file mtime
    snippet: string;          // first ~150 chars of body (frontmatter stripped)
    folder: string;           // parent folder path for display
    priority: 'next' | 'normal';
    triageValue?: string;     // raw triage field value, if any (for deferred items)
}

interface ChaosQueueResult {
    items: ChaosQueueItem[];
    counts: {
        total: number;        // all pending items
        next: number;         // items with triage: next
        inPath: number;       // items within the requested subpath
    };
}

function getChaosQueue(options?: {
    path?: string;            // limit to subfolder
    limit?: number;           // max items to return
}): ChaosQueueResult
```

**Filtering rules** (same as current `get_next_chaos`):
- Include: no `triage` field, or `triage: next`, or `triage: deferred YYYY-MM-DD` where date has passed
- Exclude: `triage` is a bare date (processed), `acknowledged`, or `deferred` with future date

**Sort order:**
1. `triage: next` items first (the "Next Up" group)
2. Everything else (the "Queue" group)
3. Within each group: newest first (by frontmatter `created`/`date`, falling back to file mtime)

### 2. Triage Field Extension

One new value added to the existing `triage` frontmatter convention:

| Value | Meaning | Appears in queue? | Group |
|---|---|---|---|
| *(absent / null / empty)* | Untriaged | Yes | Queue |
| `next` | Flagged as high priority | Yes | Next Up |
| `2026-02-22` (date) | Processed on that date | No | — |
| `deferred 2026-03-15` | Deferred until that date | Yes, once date passes | Queue |
| `acknowledged` | Reviewed, no action needed | No | — |

**No additional priority levels.** Just "next" (starred) and everything else. Simple binary.

### 3. Chaos Queue Panel

A new `ItemView` registered as `witness-chaos-queue`, separate from the existing `witness-search` panel. Opens in the right sidebar.

#### Layout

```
┌──────────────────────────────────┐
│  Chaos Queue              [Edit] │  ← header + edit mode toggle
├──────────────────────────────────┤
│  ▸ Next Up (3)                   │  ← collapsible group header
│  ┌────────────────────────────┐  │
│  │ some-article.md            │  │  ← filename
│  │ 1-chaos/external/readwise  │  │  ← folder path (muted)
│  │ The key insight from this  │  │  ← snippet (1-2 lines, muted)
│  │ article is that...         │  │
│  │          [☑] [⊘] [☠]      │  │  ← action buttons (right-aligned)
│  └────────────────────────────┘  │
│  ┌────────────────────────────┐  │
│  │ meeting-notes.md           │  │
│  │ ...                        │  │
│  └────────────────────────────┘  │
│                                  │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │  ← visual divider
│                                  │
│  ▸ Queue (847)                   │  ← collapsible group header
│  ┌────────────────────────────┐  │
│  │ voice-note-2026-02-20.md   │  │
│  │ 1-chaos/internal/inbox     │  │
│  │ Thinking about the way     │  │
│  │ we approach...             │  │
│  │          [★] [☑] [⊘] [☠]  │  │  ← includes "mark next" button
│  └────────────────────────────┘  │
│  ...                             │
│                                  │
│  850 items pending               │  ← footer with total count
└──────────────────────────────────┘
```

#### Item Cards

Each card shows:
- **Filename** — `file.basename` (or frontmatter `title` if present), normal weight
- **Folder path** — parent folder relative to vault root, muted colour, smaller font
- **Snippet** — first ~150 characters of body content after frontmatter, muted, 2-line clamp (same CSS pattern as search results)
- **Action buttons** — small icon buttons, right-aligned at bottom of card:
  - **★ Mark Next** (only shown in Queue group — Next Up items are already next)
  - **☑ Acknowledge** — sets `triage: acknowledged`, item disappears
  - **⊘ Reset** — removes `triage` field (only shown on Next Up items, to un-star them)
  - **☠ Move to Death** — moves file to `4-death/`, item disappears

Clicking the card itself opens the file in the editor (same as search results).

#### Edit Mode (Bulk Selection)

An "Edit" button in the panel header. When toggled:
- Checkboxes appear on each card (left side)
- A toolbar appears at the top with bulk action buttons: **Acknowledge Selected**, **Move to Death**
- A "Select All" / "Deselect All" toggle
- A count: "3 of 847 selected"
- Exiting edit mode clears all selections

Bulk actions always show a confirmation dialog before executing.

#### Panel Refresh

After any action (single or bulk):
- The affected item(s) disappear immediately from the list
- Queue counts update
- No full re-render — just remove the DOM elements and update count text
- The underlying `getChaosQueue()` is not re-called unless the panel is reopened or manually refreshed

### 4. MCP Tool Updates

#### `get_next_chaos` Changes

- Internally calls `getChaosQueue()` instead of its own filtering logic
- Items with `triage: next` appear first in results (both single and list modes)
- List mode includes the `priority` field: `'next'` or `'normal'`
- Queue counts gain a `next` field: `{ total: 850, next: 3, in_path: 312 }`

#### `mark_triage` Changes

Two new actions:

| Action | Effect | `triage` value |
|---|---|---|
| `next` | Flag as high priority | `next` |
| `reset` | Remove triage entirely | *(field deleted)* |

Existing actions unchanged: `processed`, `deferred`, `acknowledged`.

The `reset` action uses `processFrontMatter` to delete the `triage` key:
```typescript
// Inside processFrontMatter callback
if (action === 'reset') {
    delete fm.triage;
}
```

### 5. Keyboard Shortcuts (Editor-Scoped)

Hotkeys that operate on the file currently open in the editor. Registered via `this.addCommand()` with `editorCallback`.

| Command ID | Name | Action |
|---|---|---|
| `witness:acknowledge-file` | Acknowledge current file | Sets `triage: acknowledged` on active file |
| `witness:mark-next` | Mark as next up | Sets `triage: next` on active file |
| `witness:move-to-death` | Move to death | Moves active file to `4-death/` (with confirmation) |

**Behaviour:**
- Only operate on files within the chaos folder. If the active file is outside chaos, show a notice: "Not a chaos item"
- If the file already has a triage value, acknowledge and mark-next overwrite it (user is making a conscious decision)
- Move to death shows a confirmation notice before acting
- After action, show a brief Obsidian notice: "Acknowledged: filename.md" / "Moved to death: filename.md"
- If the Chaos Queue panel is open, it refreshes to reflect the change

**Default key bindings:** None assigned by default — users configure their own in Obsidian's Hotkeys settings. The commands are available in the command palette.

### 6. File Explorer Context Menu

Right-click actions on folders and files in Obsidian's file explorer, registered via `this.registerEvent(this.app.workspace.on('file-menu', ...))`.

#### Folder Actions

When right-clicking a folder within the chaos directory:

- **Acknowledge all in folder** — sets `triage: acknowledged` on every untriaged `.md` file in the folder (recursive)
- **Move folder to death** — moves the entire folder to `4-death/`, preserving path structure

#### File Actions

When right-clicking a single file within the chaos directory:

- **Acknowledge** — sets `triage: acknowledged`
- **Mark as next up** — sets `triage: next`
- **Move to death** — moves file to `4-death/`

#### Confirmation Dialogs

All bulk/destructive actions show a modal confirmation:

**Acknowledge all:**
> Acknowledge all files in `1-chaos/external/readwise/`?
>
> This will mark **47 untriaged files** as acknowledged. They will no longer appear in the triage queue.
>
> [Cancel] [Acknowledge All]

**Move folder to death:**
> Move `1-chaos/external/old-imports/` to death?
>
> This will move the folder and all **132 files** to `4-death/1-chaos/external/old-imports/`. This can be undone by moving the folder back manually.
>
> [Cancel] [Move to Death]

**Reset triage (from panel, on a single item):**
> Reset triage for `some-article.md`?
>
> This will remove the triage status, putting the file back in the untriaged queue.
>
> [Cancel] [Reset]

For bulk reset (if ever needed — not in current scope), add a second confirmation step.

### 7. Move to Death Mechanics

When moving a file or folder to death:

1. **Path construction**: Strip nothing. `1-chaos/external/readwise/article.md` becomes `4-death/1-chaos/external/readwise/article.md`. The full original path is preserved under `4-death/` for traceability.

2. **Create intermediate directories**: If `4-death/1-chaos/external/readwise/` doesn't exist, create it.

3. **Use Obsidian's vault API**: `this.app.vault.rename(file, newPath)` — this is actually a move operation in Obsidian's API. It updates all internal links pointing to the file.

4. **Folder moves**: For folder moves, iterate all files in the folder and move each individually (Obsidian's API doesn't have a bulk folder move). Create the target folder structure first.

5. **Conflict handling**: If a file already exists at the target path (unlikely but possible), append a timestamp: `article-1708617600.md`.

## Files to Create/Modify

| File | Changes |
|---|---|
| `src/main.ts` | Extract `getChaosQueue()` shared function; update `get_next_chaos` and `mark_triage` tools; register new view type, commands, ribbon icon, file-menu events |
| `src/chaos-queue-view.ts` | **New file.** `WitnessChaosQueueView` extending `ItemView` — panel UI, edit mode, item rendering, action handlers |
| `styles.css` | New CSS classes for chaos queue panel (cards, groups, action buttons, edit mode) |

## Implementation Plan

### Phase 1: Shared function + MCP updates
1. Extract `getChaosQueue()` from existing `get_next_chaos` logic
2. Add `triage: next` to filtering/sorting logic
3. Update `get_next_chaos` to use `getChaosQueue()`
4. Add `next` and `reset` actions to `mark_triage`
5. Add integration tests for new triage values

### Phase 2: Chaos Queue panel
1. Create `src/chaos-queue-view.ts` with `WitnessChaosQueueView`
2. Register view type, ribbon icon (separate from search), toggle command
3. Implement item cards with inline action buttons
4. Implement "Next Up" / "Queue" grouping with visual divider
5. Implement panel refresh on action
6. Add CSS to `styles.css`

### Phase 3: Edit mode + bulk actions
1. Add edit mode toggle with checkbox UI
2. Implement select all / deselect all
3. Implement bulk acknowledge and bulk move-to-death
4. Add confirmation modals for bulk actions

### Phase 4: Keyboard shortcuts + file explorer
1. Register editor-scoped commands (acknowledge, mark next, move to death)
2. Register file-menu event handlers for folder/file context menus
3. Implement move-to-death path construction and file operations
4. Add confirmation modals for destructive actions

## Open Questions

- **Panel pagination / virtual scrolling**: With 850+ items, rendering all cards at once could be slow. May need virtual scrolling or "load more" pagination. Evaluate after Phase 2 — if the panel is sluggish with real data, add lazy loading.
- **Snippet extraction**: The panel needs body text minus frontmatter. `getChaosQueue()` could read file content for each item, but reading 850 files on panel open is expensive. Options: (a) read lazily as cards scroll into view, (b) use cached content from the search index if available, (c) read only the first N items and load more on scroll.
- **Panel as a tab vs separate panel**: The search panel and chaos queue panel could share a single sidebar view with tabs at the top instead of being two separate `ItemView`s. This is a UX preference — separate panels mean you can have both open simultaneously (e.g. search on right, queue on left), but tabs are more compact. Starting with separate panels, can consolidate later if it feels cluttered.
- **File explorer actions outside chaos**: Should the context menu items appear for files/folders outside the chaos directory? Probably not — they're chaos-specific concepts. Only show when the target is within `settings.chaosFolder`.
- **Undo support**: Move-to-death is reversible (manually move the file back) but there's no built-in undo. Could add an undo notice: "Moved to death. [Undo]" — Obsidian notices support action buttons. Worth considering for Phase 4.

---

*Extends: [Chaos Triage](chaos-triage.md) (the original MCP tool spec)*
*Uses: `4-death/` folder convention from [Witness Philosophy](../witness-philosophy.md)*
