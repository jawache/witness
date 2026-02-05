# Feature Spec: Dataview Integration

**Status:** Planned
**Phase:** 4 (Intelligence)
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

Integrate with Obsidian's Dataview plugin to give AI assistants the ability to run structured queries against vault metadata, and to read files with Dataview codeblocks pre-rendered into actual results.

## Problem Statement

Currently, when Claude reads a file through `read_file`, it sees raw Dataview codeblocks:

````markdown
## Available Prompts

```dataview
TABLE description FROM "2-life/prompts" SORT file.name
```
````

This is useless to Claude — it can't execute the query. The AI sees the query syntax instead of the data. This is especially problematic for the orientation file, which could use Dataview queries to dynamically list prompts, templates, collections, and other vault metadata that changes over time.

There's also no way for Claude to run ad-hoc DQL queries against the vault. Dataview is essentially a structured query language for Obsidian metadata — tags, frontmatter fields, links, file properties — and it's more powerful than text search for answering questions like "show me all events with status accepted" or "list people I met this quarter."

## Solution: Two Complementary Features

### 1. `dataview_query` MCP Tool

A standalone tool that executes a DQL (Dataview Query Language) query and returns the result as markdown.

### 2. Rendered File Reading

A flag on `read_file` (and always-on for `get_orientation`) that finds Dataview codeblocks in file content, executes each query, and substitutes the results inline before returning.

## Why This Works

Witness runs **inside** Obsidian's Electron process. This means it has direct access to the Dataview plugin API:

```typescript
const dvApi = (this.app as any).plugins.plugins.dataview?.api;
```

No external process, no REST API, no IPC — just a direct function call. This is a unique advantage over external MCP servers.

## Dataview API

Dataview exposes two relevant methods:

### `dvApi.query(dql)` — Structured Results

Returns a JS object with headers and typed values:

```typescript
const result = await dvApi.query('TABLE description FROM "2-life/prompts"');
// result.successful = true
// result.value.headers = ["File", "description"]
// result.value.values = [
//   [Link("daily-ritual"), "Morning reflection and metrics tracking"],
//   [Link("weekly-ritual"), "Weekly reflection and planning"],
//   ...
// ]
```

Good for programmatic use, but requires formatting the Link objects and other Dataview types into readable strings.

### `dvApi.queryMarkdown(dql)` — Markdown String

Returns the query result as a pre-formatted markdown table:

```typescript
const result = await dvApi.queryMarkdown('TABLE description FROM "2-life/prompts"');
// result.successful = true
// result.value = "| File | description |\n| --- | --- |\n| [[daily-ritual]] | Morning... |\n..."
```

Returns plain markdown — exactly what we need for MCP responses. No formatting required.

### What Doesn't Work

**`MarkdownRenderer.render()`** — Renders markdown to HTML, but Dataview codeblocks are processed asynchronously after the initial render. The HTML comes back before Dataview has injected its results. Not reliable for our use case.

## MCP Tool: `dataview_query`

### Parameters

```typescript
{
  query: string;        // DQL query string
  format?: 'markdown' | 'json';  // Output format (default: 'markdown')
}
```

### Returns (markdown format)

```typescript
{
  content: [{
    type: 'text',
    text: '| File | description |\n| --- | --- |\n| [[daily-ritual]] | Morning reflection... |\n...'
  }]
}
```

### Returns (json format)

```typescript
{
  content: [{
    type: 'text',
    text: '{"headers":["File","description"],"values":[["daily-ritual","Morning reflection..."],...]}'
  }]
}
```

### Example Queries

```
// List all events with status
TABLE status, date, location FROM "3-order/knowledge/events" SORT date DESC

// Find people met this quarter
TABLE date, attendees FROM "3-order/knowledge/meetings" WHERE date >= date("2026-01-01")

// Count notes by folder
TABLE length(rows) as Count FROM "" GROUP BY file.folder

// List all tags used in knowledge
FLATTEN file.tags as tag FROM "3-order/knowledge" GROUP BY tag SORT rows.file.name

// Find stale chaos items (older than 30 days)
TABLE file.cday as "Created", file.folder as "Location" FROM "1-chaos" WHERE file.cday <= date(today) - dur(30 days) SORT file.cday ASC
```

### Why Better Than Search

| Capability | `search` | `dataview_query` |
|-----------|----------|------------------|
| Full-text content search | Yes | No |
| Frontmatter field queries | No | Yes |
| Date range filters | No | Yes |
| Aggregation (GROUP BY, COUNT) | No | Yes |
| Sorting by metadata fields | No | Yes |
| Cross-note relationships (links) | No | Yes |
| Tag-based filtering | No | Yes |

They're complementary — `search` finds content, `dataview_query` finds structure.

## Rendered File Reading

### Approach

When reading a file, detect Dataview codeblocks and replace them with their executed results.

**Input (raw file content):**

````markdown
## Available Prompts

```dataview
TABLE description FROM "2-life/prompts" SORT file.name
```

## Recent Meetings

```dataview
TABLE date, attendees FROM "3-order/knowledge/meetings" SORT date DESC LIMIT 5
```
````

**Output (rendered content):**

```markdown
## Available Prompts

| File | description |
| --- | --- |
| [[daily-ritual]] | Morning reflection and metrics tracking |
| [[generate-articles]] | Transform podcast transcripts to articles |
| [[quarterly-ritual]] | Define 3 quarterly outcomes |
| [[weekly-ritual]] | Weekly reflection and planning |

## Recent Meetings

| File | date | attendees |
| --- | --- |
| [[2026-02-03 - Team Sync]] | 2026-02-03 | [[Jamie]], [[Russel]] |
| [[2026-01-28 - Board Update]] | 2026-01-28 | [[Board]] |
```

### Implementation

```typescript
/**
 * Process a markdown string, replacing Dataview codeblocks with query results.
 * Returns the original content if Dataview is not available.
 */
async resolveDataviewBlocks(content: string): Promise<string> {
    const dvApi = (this.app as any).plugins.plugins.dataview?.api;
    if (!dvApi) return content;

    // Match ```dataview ... ``` blocks
    const dataviewBlockRegex = /```dataview\n([\s\S]*?)```/g;

    let result = content;
    let match;

    // Collect all matches first (to avoid regex state issues with async)
    const matches: Array<{ full: string; query: string }> = [];
    while ((match = dataviewBlockRegex.exec(content)) !== null) {
        matches.push({ full: match[0], query: match[1].trim() });
    }

    // Execute each query and substitute
    for (const m of matches) {
        try {
            const queryResult = await dvApi.queryMarkdown(m.query);
            if (queryResult.successful) {
                result = result.replace(m.full, queryResult.value.trim());
            } else {
                // Leave a useful error message instead of the raw query
                result = result.replace(m.full, `> [!warning] Dataview query failed: ${queryResult.error}`);
            }
        } catch (err) {
            result = result.replace(m.full, `> [!warning] Dataview error: ${err.message}`);
        }
    }

    return result;
}
```

### Where Rendering Applies

| Tool | Rendering | Rationale |
|------|-----------|-----------|
| `get_orientation` | **Always on** | The orientation file is the AI's map — it must show live data |
| `read_file` | **Flag: `render`** | Opt-in to avoid surprises; raw content is the default |
| `dataview_query` | N/A | Already returns query results directly |

### `read_file` Changes

Add an optional `render` parameter:

```typescript
this.mcpServer.tool(
    'read_file',
    'Read the contents of a file from the vault',
    {
        path: z.string().describe('Path to the file relative to vault root'),
        render: z.boolean().optional().default(false)
            .describe('Resolve Dataview queries in the file before returning'),
    },
    async ({ path, render }) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) throw new Error('File not found');

        let content = await this.app.vault.read(file as any);

        if (render) {
            content = await this.resolveDataviewBlocks(content);
        }

        return { content: [{ type: 'text', text: content }] };
    }
);
```

### `get_orientation` Changes

Always resolve Dataview blocks:

```typescript
// In get_orientation handler
let content = await this.app.vault.read(file as any);
content = await this.resolveDataviewBlocks(content);
return { content: [{ type: 'text', text: content }] };
```

## Availability Detection

Dataview may not be installed or enabled. Handle gracefully:

```typescript
private isDataviewAvailable(): boolean {
    return !!(this.app as any).plugins.plugins.dataview?.api;
}
```

**Behavior when Dataview is unavailable:**
- `dataview_query` tool: Not registered (skip during tool registration)
- `read_file` with `render: true`: Returns raw content unchanged (no error)
- `get_orientation`: Returns raw content unchanged (no error)

This means the orientation file works whether or not Dataview is installed — with Dataview you get live data, without it you see the raw query syntax (which is still informative as documentation).

## Dataview Query Types

DQL supports several query types, all of which should work:

| Type | Example | Returns |
|------|---------|---------|
| **TABLE** | `TABLE tags FROM "topics"` | Markdown table with columns |
| **LIST** | `LIST FROM #recipe` | Bullet list of matching files |
| **TASK** | `TASK FROM "2-life/projects"` | Task items with checkboxes |
| **CALENDAR** | `CALENDAR file.cday` | (Not useful for text — skip or return as list) |

`queryMarkdown()` handles all of these and returns appropriate markdown formatting.

## Implementation Plan

### Phase 1: Core Infrastructure

- Add `resolveDataviewBlocks()` utility method to the plugin
- Add Dataview availability detection
- Update `get_orientation` to always resolve Dataview blocks

### Phase 2: MCP Tools

- Register `dataview_query` tool (only when Dataview is available)
- Add `render` parameter to `read_file`
- Test with various DQL query types (TABLE, LIST, TASK)

### Phase 3: Error Handling & Polish

- Graceful degradation when Dataview unavailable
- Query timeout handling (long-running queries)
- Logging for query execution times

## Risks & Mitigations

### Risk: Dataview not installed

**Mitigation:** Graceful degradation — features simply don't register or pass through raw content. No errors, no broken behavior.

### Risk: Slow queries on large vaults

**Mitigation:** Dataview maintains its own index and queries are typically fast (<100ms). For the orientation file, queries are simple metadata lookups. If needed, add a timeout.

### Risk: Dataview API changes

**Mitigation:** The `query()` and `queryMarkdown()` methods have been stable across Dataview versions. Pin to known-good API surface. Check for API existence before calling.

### Risk: Recursive Dataview blocks

**Mitigation:** Only process top-level codeblocks in the file content. Dataview results are plain markdown and won't contain new codeblocks.

### Risk: Query injection via file content

**Mitigation:** Queries come from file content that the vault owner wrote. This is the same trust model as Obsidian itself — you trust your own vault files. The `dataview_query` tool takes queries from the AI, which operates under the same trust boundary.

## Use Cases

### 1. Self-Updating Orientation File

The orientation file uses Dataview queries to dynamically list vault contents:

````markdown
## Available Prompts

```dataview
TABLE description FROM "2-life/prompts" SORT file.name
```
````

When Claude reads the orientation, it sees the actual prompt list — no manual maintenance needed. Add a new prompt file with a `description` field and it appears automatically.

### 2. Vault Health Checks

Claude can run queries to surface issues:

```
"How many chaos items are older than 30 days?"

→ dataview_query("TABLE file.cday FROM \"1-chaos\" WHERE file.cday <= date(today) - dur(30 days)")
```

### 3. Context Gathering

Before creating a new note, Claude can check what already exists:

```
"I want to create a note about carbon accounting"

→ dataview_query("LIST FROM \"3-order/knowledge/topics\" WHERE contains(file.name, \"Carbon\")")
→ Already exists: [[Carbon Accounting]]
```

### 4. Meeting Prep

Pull relevant context before a meeting:

```
"What do I know about Jamie?"

→ dataview_query("TABLE date FROM \"3-order/knowledge/meetings\" WHERE contains(attendees, \"Jamie\") SORT date DESC LIMIT 5")
```

---

*This spec was developed after researching the Dataview plugin API and discovering that `dvApi.queryMarkdown()` returns plain markdown strings — making it straightforward to integrate with MCP text responses.*
