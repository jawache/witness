# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Witness is an Obsidian plugin that acts as an AI companion for managing a personal knowledge vault based on the **Chaos → Order** philosophy. The plugin itself IS an MCP (Model Context Protocol) server running inside Obsidian, enabling AI assistants to interact with the vault through file operations.

## Core Architecture

**Key Technical Decision:** The plugin runs an HTTP/WebSocket server inside Obsidian's Electron process and implements the MCP protocol directly. This is different from existing Obsidian MCP servers which run as external Node.js processes and connect via the Local REST API plugin.

```
MCP Client (Claude Desktop/Mobile)
    ↓ HTTP/WebSocket
Witness Plugin (inside Obsidian) ← MCP Server + Vault Operations
    ↓
Obsidian Vault (chaos/order structure)
```

## Vault Structure Convention

The plugin is designed to work with vaults organized into two top-level directories:

- **chaos/** - Unprocessed, incoming information
  - `external/` - Content from outside world (readwise, youtube, clippings, transcripts)
  - `inbox/` - Quick notes and fleeting thoughts

- **order/** - Structured, processed information
  - `knowledge/` - Databases (topics, people, quotes, recipes, meetings, events)
  - `heartbeat/` - Daily/weekly/quarterly rhythms
  - `projects/` - Active work
  - `synthesis/` - Published output

The plugin will eventually have native understanding of this structure to surface stale items and provide intelligent prompts.

## Development Phases

**Phase 1 (Current):** MCP Server Plugin
- Basic Obsidian plugin scaffold with settings page
- HTTP server running inside Obsidian
- MCP protocol implementation
- Core file operations: read, write, edit, list, search
- Demo vault at `demo-vault/` for manual testing
- Integration tests in `test/` directory

**Phase 2:** Chat Interface Integration
- Connect to WhatsApp/Telegram
- Remote access via Cloudflare Tunnel
- Persistent conversation threading

**Phase 3:** Heartbeat Scheduler
- Proactive prompts (morning ritual, weekly reflection)
- Chaos monitoring (trigger prompts when new items arrive)

**Phase 4:** Native Structure Understanding
- Automatic detection of stale chaos items
- Smart prompts based on vault state

## Testing Strategy

**Two Vaults:**

- `demo-vault/` - For manual testing, playing around, development demos
- `test/vault/` - Minimal, stable vault for automated integration tests

**Integration Test Suite:**
Located in `test/integration/`, uses Vitest to test MCP endpoints against a running Obsidian instance.

```bash
# 1. Build and install plugin in test vault
npm run test:install-plugin

# 2. Launch Obsidian with test vault (port 3001)
npm run test:start-obsidian

# 3. Run integration tests
npm test
```

**Test Vault Requirements:**
- Uses port 3001 (different from demo-vault's 3000)
- Contains files with known, fixed content for assertions
- Should not be modified during normal development
- Can be reset via git if needed

**MCP Automation Tools (for UI testing):**

- `applescript-mcp` - Launch/quit Obsidian programmatically
- `peekaboo` - Capture screenshots of Obsidian UI for verification
- MCP servers configured in `~/.claude/claude_code_config.json`

**Manual Testing Flow:**

1. Build plugin: `npm run build`
2. Install in demo vault: `cp main.js manifest.json demo-vault/.obsidian/plugins/witness/`
3. Launch Obsidian with demo-vault
4. Verify plugin loads and HTTP server responds
5. Test MCP endpoints manually

### Phase 1 Status: ✅ COMPLETE

All Core MCP Tools Implemented:

- ✅ Claude Desktop successfully connected to Witness MCP server
- ✅ `read_file` - Read file contents from vault
- ✅ `write_file` - Create new files in vault (create-only, errors on existing files)
- ✅ `list_files` - List directory contents
- ✅ `edit_file` - Find/replace for surgical file updates
- ✅ `search` - Full-text search across vault
- ✅ `execute_command` - Trigger Obsidian commands via MCP
- ✅ `find_files` - Search files by name pattern
- ✅ `move_file` - Move or rename files within vault
- ✅ `get_orientation` - Load orientation document
- ✅ HTTP health endpoint responding
- ✅ Plugin loads in Obsidian on startup
- ✅ Files created via MCP visible in Obsidian UI
- ✅ Session management and SSE streams working correctly
- ✅ File-based logging to `.obsidian/plugins/witness/logs/`
- ✅ Integration test suite (47 tests)

Total: 9 MCP tools registered and available

### Phase 2 Status: ✅ COMPLETE

Remote Access via Cloudflare Tunnel:

- ✅ Cloudflare Quick Tunnel integration (ephemeral URLs)
- ✅ Cloudflare Named Tunnel support (permanent URLs with own domain)
- ✅ Primary Machine designation for multi-device Obsidian Sync
- ✅ Auto-install cloudflared binary to `~/.witness/bin/`
- ✅ Tunnel URL displayed in settings with copy button
- ✅ Regenerate/reconnect tunnel button in settings UI
- ✅ Tunnel status indicator (connecting/connected/error)
- ✅ Token authentication for remote access

#### Named Tunnel Details

**`Tunnel.withToken(token)` vs `Tunnel.quick(url)`:**
- Quick tunnels emit a `url` event with the random trycloudflare.com URL
- Named tunnels do NOT emit `url` — they emit `connected` with `{ id, ip, location }`
- Named tunnel URL is user-configured in settings (from Cloudflare dashboard)
- Named tunnel token is a JWT from Cloudflare Zero Trust → Networks → Tunnels → Configure

**Primary Machine (`tunnelPrimaryHost`):**
- Stores `os.hostname()` of the designated machine
- Checked at the top of `startTunnel()` — skips silently if not primary
- Prevents round-robin when Obsidian Sync shares plugin settings across devices
- Settings UI shows current host, "Set as primary" button, and clear button

**Mobile Limitations:**
- `http.createServer()` and cloudflared binary are desktop-only
- Obsidian mobile cannot run the MCP server or tunnel
- Mobile devices access the vault as MCP clients through the tunnel URL

### Phase 3 Status: ✅ COMPLETE

Semantic Search via Ollama + Orama:

- ✅ `semantic_search` MCP tool — hybrid (BM25 + vector), vector-only, and fulltext modes
- ✅ Local embeddings via Ollama (no cloud dependency)
- ✅ Orama vector store with JSON persistence (`.witness/index.orama`)
- ✅ Dynamic model info resolution via `/api/show` (dimensions, context length)
- ✅ Client-side pre-truncation with conservative CHARS_PER_TOKEN=2
- ✅ Model-specific task prefixes (nomic-embed-text, mxbai-embed-large)
- ✅ Minimum content length filter to skip short/noisy documents
- ✅ Folder exclusions with FolderSuggestModal picker
- ✅ Incremental indexing with stale file detection (mtime-based)
- ✅ Search panel sidebar view
- ✅ Tabbed settings UI with model pull, index management, live progress
- ✅ Tested on 4,097-document vault
- ✅ Markdown chunking by H2/H3 headings (`src/chunker.ts`)
- ✅ Multi-chunk indexing with heading path tracking (schema v3)
- ✅ Click-to-heading navigation in search panel
- ✅ Frontmatter stripping from snippets
- ✅ Background indexing with vault event listeners (create/modify/delete/rename)
- ✅ Light file moves — renames update metadata without re-embedding
- ✅ Periodic reconciliation (60s) — catches orphans and stale files missed by events
- ✅ `indexedFiles` Set for accurate file count tracking
- ✅ Status bar with file count and indexing progress

Total: 16 MCP tools registered and available

### Chaos Triage Tools

Two tools for processing unread chaos items:

- **`get_next_chaos`** — Scans `1-chaos/` for untriaged items. Filters out processed, acknowledged, and future-deferred items. Two modes:
  - Single mode (default): Returns full file content of the next item
  - List mode (`list: true`): Returns compact `{path, title, date}` for up to 10 items
  - Every response includes `queue: {total, in_path}` counts

- **`mark_triage`** — Records triage decisions via `processFrontMatter` API. Three actions:
  - `processed`: Sets `triage: YYYY-MM-DD` (today's date)
  - `deferred`: Sets `triage: deferred YYYY-MM-DD` (requires `defer_until` param)
  - `acknowledged`: Sets `triage: acknowledged`

**Triage frontmatter convention:**
- `triage: 2026-02-08` → Processed on that date
- `triage: deferred 2026-03-01` → Resurfaces when date passes
- `triage: acknowledged` → Reviewed, no action needed
- No `triage` field → Untriaged, appears in queue

**AI Safety Guardrails:**
- `write_file` is create-only — errors on existing files with guidance toward `edit_file`
- `edit_file` error messages truncate search text, suggest re-reading, warn against delete+recreate
- `mark_triage` uses `processFrontMatter` to avoid AI fumbling with YAML

### Markdown Chunking

Documents are split into chunks by markdown headings before embedding. Each chunk carries its heading path (e.g., "## Overview > ### Principles") for context.

**Key files:**

- `src/chunker.ts` — Pure function `chunkMarkdown()` that splits by H2 boundaries, H3 subdivision, fixed-size fallback at 5000 chars
- `test/unit/chunker.test.ts` — 19 tests covering edge cases

**Chunk IDs:** `filepath#0`, `filepath#1`, etc. The VectorStore's `removeBySourcePath()` removes all chunks for a file by iterating sequential IDs until one is not found.

**Schema v3:** Added `sourcePath` (string), `headingPath` (string), `chunkIndex` (number) to the Orama schema. Bump from v2 forces full re-index.

### Background Indexing & Reconciliation

The index stays up-to-date through two mechanisms working together:

**Idle-gated execution**: All indexing work (both event-driven and reconciliation) waits until the app has been idle for 2 minutes (`IDLE_THRESHOLD_MS = 120_000`). Idle is defined as no mousemove, keydown, click, or scroll events on `document`. This eliminates UI stutter entirely — indexing only runs when the user isn't interacting with Obsidian.

**Event-driven indexing**: Vault event listeners (create/modify/delete/rename) feed an `IndexQueue` with a 3-second per-file debounce. `processQueue()` calls `waitForIdle()` first, then handles deletes, renames (light metadata update via `moveFile()`), and indexes (full embedding).

**Periodic reconciliation** (safety net): Every 60 seconds, `reconcile()` runs a bidirectional scan:

- **Forward**: `getStaleFiles()` compares vault file mtimes against indexed mtimes → finds new/modified files
- **Reverse**: `getOrphanedPaths()` compares `indexedFiles` Set against vault paths → finds deleted files

This catches everything events miss: files changed while the plugin was off, Obsidian Sync drift, external tools touching files, plugin restarts. Reconciliation also calls `waitForIdle()` (except on initial startup where `skipIdleWait=true`).

**Debounced saves**: Index saves are batched via `scheduleSave()` — a dirty flag + 30-second timer (`SAVE_INTERVAL_MS`). Avoids serialising the full 279 MB+ index after every small change. `flushSave()` is called on plugin unload to ensure nothing is lost.

**Active file deferral**: Both `processQueue()` and `reconcile()` check `app.workspace.getActiveFile()` and skip it, re-queuing for later. This avoids re-indexing a file that's about to change again while the user edits it.

**Status bar countdown**: When `waitForIdle()` is blocking, a 5-second interval timer updates the status bar with "N pending, indexing in M:SS". Resets on every user interaction. The `waitingForIdle` flag tracks whether any code path is currently blocked.

**Key implementation details:**

- `backgroundIndexing` flag acts as a mutex — prevents concurrent indexing from events and reconciliation
- `indexedFiles` Set tracks all indexed file paths, persisted in the save envelope, and self-heals via `getStaleFiles()` (adds up-to-date files it encounters)
- `moveFile()` does O(n chunks) remove+insert with `getByID()` — preserves the embedding vector, only updates sourcePath/title/folder/id
- `startBackgroundIndexing()` runs after a 5-second startup delay: init search engine → clear queued events → update status bar → `reconcile(true)` → start 60-second timer
- DOM activity listeners are registered with `{ passive: true }` to avoid performance impact
- The `isUserActive` callback passed to `indexFiles()` uses `!isAppIdle()` as a safety net pause within long-running indexing loops

**Architectural note (Web Worker rejection):** A web worker approach was prototyped and rejected. Even with Orama running off-thread, the main thread still blocks on: vault file reads (Obsidian API is main-thread-only), postMessage structured clone of the 279 MB index, and JSON.stringify for persistence. Idle detection is simpler and more effective — it doesn't make the work faster, it makes the work invisible.

### Unified Search Architecture (Planned)

See `docs/features/unified-search.md` for full spec. Key decisions:

- **Two tools**: `search` (content search via Orama) and `find` (file discovery via vault API)
- **QPS over BM25**: `@orama/plugin-qps` scores by token proximity — better for short phrase queries
- **All files indexed**: Two-phase indexing — content+metadata first (always succeeds), embeddings second (may fail). No blind spots.
- **Tag/path filtering**: Orama `enum[]` for tags, `enum` for folder, `where` clause filters
- **Engine abstraction**: `SearchEngine` interface for future engine swaps
- **Schema v5**: Adds `tags: 'enum[]'` and `folder: 'enum'` to existing fields

### Dataview Integration

- ✅ `dataview_query` MCP tool - execute DQL queries (markdown or JSON output)
- ✅ `read_file` render parameter - resolve Dataview codeblocks before returning
- ✅ `get_orientation` auto-renders Dataview blocks (AI sees live data)
- ✅ 8 integration tests for Dataview features
- ✅ Test vault includes Dataview plugin and topic test files

**Plugin Load Order:** Always register tools unconditionally and check Dataview availability at call time. Dataview may not be loaded when Witness starts.

**Dataview API Access:** `(this.app as any).plugins.plugins.dataview?.api` — returns the DV API or undefined.

Total: 16 MCP tools registered and available

### LLM Re-ranking

- ✅ `search` tool gains `rerank: true` parameter for two-stage search
- ✅ `generate()` method on OllamaProvider for `/api/generate` endpoint
- ✅ `listChatModels()` filters models by `completion` capability
- ✅ `rerank()` batch-scores candidates with JSON output + regex fallback
- ✅ Settings UI with model dropdown, suggested models, and pull buttons
- ✅ Search panel toggle with two-phase UX and animated status banner
- ✅ Enter-only search when re-rank enabled (no debounce)

**Architecture:** Stage 1 (hybrid search, top-30 candidates) → Stage 2 (LLM relevance scoring, top-K). Re-ranking is orchestrated in `main.ts`'s `search()` method, not in `vector-store.ts`.

**Quality Limitation:** Small chat models (1-4B) as relevance judges have poor discrimination — they tend to score everything similarly. Dedicated cross-encoder models (bge-reranker, jina-reranker) are purpose-built for this but Ollama doesn't yet expose a native rerank endpoint. The infrastructure is in place for when better options emerge.

**Graceful Degradation:** JSON parse → regex fallback (`\[?(\d+)\]?\s*[:\-=]\s*(\d+)`) → original ordering. If the LLM call fails entirely, results are returned in their stage 1 order.

### Contextual Search

- ✅ Toggle on search panel that auto-searches based on editor context
- ✅ Three event sources: `active-leaf-change` (500ms), `editor-change` (1500ms), `document.selectionchange` (800ms)
- ✅ Context extraction: selection priority (>= 2 chars), then paragraph around cursor
- ✅ Frontmatter excluded via `findBodyStart()` boundary
- ✅ Hash deduplication (DJB2) prevents redundant embedding calls
- ✅ Forces vector-only mode, disables mode selector and rerank
- ✅ Current file filtered from results
- ✅ Command palette: `Toggle contextual search`
- ✅ Clicks outside editor keep existing results (no clearing)
- ✅ Page Preview integration: Cmd+hover on search result cards triggers Obsidian's built-in Page Preview

**Architecture:** Contextual mode is a state toggle on `WitnessSearchView`. When enabled, it registers workspace and DOM event listeners that feed into `scheduleContextualSearch()` with per-source debounce timings. `extractContext()` reads from the active `MarkdownView` editor — selection first, then paragraph around cursor. The extracted text is hashed and compared to `lastContextHash` to skip redundant searches. Results are filtered to exclude the file being viewed.

**Page Preview:** Uses `app.workspace.trigger('hover-link', { event, source, hoverParent, targetEl, linktext, sourcePath })` to invoke Obsidian's Page Preview core plugin. Two listeners needed: `mouseover` for entering while holding Cmd, and a document-level `keydown` (registered on `mouseenter`, cleaned up on `mouseleave`) for pressing Cmd while already hovering.

**Key gotcha — `selectionchange`:** Obsidian's `editor-change` only fires on text edits, not cursor movement or text selection. The DOM-level `selectionchange` event is needed to detect clicks, arrow keys, and drag-select. But it fires on *any* click (including in the search panel), so `extractContext()` must gracefully handle the case where no `MarkdownView` is active — return null and keep existing results.

**Key gotcha — metadata cache race:** `processFrontMatter` writes to the file but `metadataCache.getFileCache()` updates asynchronously. In `mark_triage`, we wait for `metadataCache.on('changed')` before returning, so an immediate `get_next_chaos` call sees fresh frontmatter.

### Configurable Idle Threshold

The idle detection threshold for background indexing is configurable in Settings → Search → Indexing Filters. Default is 2 minutes. The hardcoded `static readonly IDLE_THRESHOLD_MS` was replaced with a settings-backed getter: `get IDLE_THRESHOLD_MS() { return (this.settings.idleThresholdMinutes ?? 2) * 60_000; }`.

## MCP Implementation Details

### StreamableHTTP Protocol & Session Management

The MCP SDK's `StreamableHTTPServerTransport` requires proper session management:

**Critical Pattern:**
1. **Session State**: Maintain `Map<sessionId, transport>` to track active sessions
2. **Transport Lifecycle**: Call `mcpServer.connect(transport)` ONCE per transport when initializing
3. **Request Handling**: Reuse the same transport for all requests within a session
4. **Dual Endpoints**: Handle both POST (JSON-RPC messages) and GET (SSE streams)

**Implementation in [src/main.ts:192-246](src/main.ts#L192-L246):**

```typescript
private transports: Map<string, StreamableHTTPServerTransport> = new Map();

private async handleMCPRequest(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Parse body only for POST requests
  let body: any = undefined;
  if (req.method === 'POST') {
    const bodyBuffer = await getRawBody(req);
    body = JSON.parse(bodyBuffer.toString());
  }

  const isInitialize = body?.method === 'initialize';

  // New session - create transport and connect
  if (!sessionId && isInitialize) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${Date.now()}-${Math.random()}`,
      onsessioninitialized: (newSessionId) => {
        this.transports.set(newSessionId, transport);
      },
    });

    await this.mcpServer.connect(transport); // Only once!
    await transport.handleRequest(req, res, body);
    return;
  }

  // Existing session - reuse transport
  if (sessionId && this.transports.has(sessionId)) {
    const transport = this.transports.get(sessionId)!;
    await transport.handleRequest(req, res, body);
    return;
  }
}
```

**Common Pitfalls:**
- ❌ Creating new transport for every request → "Server already initialized" error
- ❌ Only handling POST requests → SSE streams fail with 404
- ❌ Calling `connect()` multiple times → Protocol errors
- ✅ One transport per session, reused across requests

### Claude Desktop Connection

**Configuration ([~/.claude/claude_desktop_config.json](~/.claude/claude_desktop_config.json)):**

```json
{
  "mcpServers": {
    "witness": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://localhost:3000/mcp",
        "--transport",
        "http-only",
        "--allow-http"
      ]
    }
  }
}
```

**mcp-remote** acts as a stdio-to-HTTP bridge, allowing Claude Desktop's stdio-based MCP client to communicate with our HTTP-based server.

**Connection Flow:**
1. Claude Desktop launches `mcp-remote` as stdio subprocess
2. mcp-remote connects to `http://localhost:3000/mcp` via HTTP
3. Session initialized, transport created and stored
4. Tools listed and made available to Claude Desktop
5. SSE stream opened for receiving notifications
6. Bidirectional communication established

**Logs:**

- Plugin logs: `.obsidian/plugins/witness/logs/mcp-YYYY-MM-DD.log`
- Claude Desktop logs: `~/Library/Logs/Claude/mcp-server-witness.log`

### File-Based Logging

The plugin writes logs to both console and file using the `MCPLogger` class:

```typescript
// Log levels available
this.logger.info('Plugin loaded');      // [INFO] General information
this.logger.error('Failed', err);       // [ERROR] Errors
this.logger.debug('Button clicked');    // [DEBUG] Debug info
this.logger.mcp('POST /mcp');           // [MCP] Protocol-level logs
```

**Log Format:**

```text
[2026-01-31T17:49:56.003Z] [INFO] Witness plugin loaded
[2026-01-31T17:50:07.214Z] [MCP] POST /mcp
[2026-01-31T17:50:07.242Z] [MCP] read_file called with path: "test.md"
```

**Implementation Details:**

- Buffered writes (flushes every 1 second or 50 entries)
- Date-based log files for easy management
- Logs directory auto-created on first write
- Graceful shutdown flushes remaining logs

### Tool Registration

Tools are registered using Zod schemas for validation:

```typescript
this.mcpServer.tool(
  'read_file',
  'Read the contents of a file from the vault',
  {
    path: z.string().describe('Path to the file relative to vault root'),
  },
  async ({ path }) => {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) throw new Error('File not found');
    const content = await this.app.vault.read(file as any);
    return {
      content: [{ type: 'text', text: content }],
    };
  }
);
```

The SDK automatically generates JSON Schema from Zod definitions and handles request validation.

### Cloudflare Tunnel (Quick & Named)

The plugin can expose the MCP server to the internet via Cloudflare tunnels. Two modes are supported:

**Quick Tunnel** - Random trycloudflare.com URL, changes on restart. Zero config.
**Named Tunnel** - Permanent URL on your own domain. Requires Cloudflare account and tunnel token.

**Implementation:**

1. **Binary Management**: cloudflared binary is installed to `~/.witness/bin/` on first use
2. **Tunnel Lifecycle**: Starts on plugin load (if enabled), stops on unload
3. **Primary Host Check**: `os.hostname()` checked against `tunnelPrimaryHost` setting before starting
4. **Settings UI**: Tunnel type dropdown, token field, URL display with copy, status indicator

**Key Code Patterns:**

```typescript
// Quick tunnel - random URL
const tunnel = Tunnel.quick(`http://localhost:${port}`);
tunnel.once('url', (url) => { /* Save and display URL */ });

// Named tunnel - permanent URL via token
const tunnel = Tunnel.withToken(this.settings.tunnelToken);
tunnel.once('connected', (conn) => { /* Mark as connected, URL from settings */ });
// IMPORTANT: Named tunnels do NOT emit 'url' event, only 'connected'
```

**Primary Machine Check (for Obsidian Sync):**

```typescript
const currentHost = os.hostname();
if (this.settings.tunnelPrimaryHost && this.settings.tunnelPrimaryHost !== currentHost) {
    this.logger.info(`Tunnel skipped: not primary host`);
    return;
}
```

**Why Custom Binary Path:**
Inside Obsidian's Electron environment, the cloudflared npm package can't resolve its default binary path correctly. We work around this by:

1. Installing to `~/.witness/bin/cloudflared`
2. Using `useCloudflared()` to point the package to our location

**Testing Tunnel:**

```bash
# Check health via tunnel
curl https://your-tunnel-url/health

# Test MCP endpoint (with auth)
curl -X POST "https://your-tunnel-url/mcp?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize",...}'
```

**Known Gotchas:**
- Named tunnel ingress rules in Cloudflare dashboard can restrict which paths are accessible (e.g., only `/mcp`). Keep ingress open or ensure all endpoints are covered.
- Multiple machines with the same tunnel token = Cloudflare round-robins between them. Use Primary Machine to prevent this.
- Orphaned cloudflared processes may accumulate if Obsidian crashes without cleanup.

### Semantic Search via Ollama + Orama

The plugin provides semantic search using local Ollama embeddings stored in an Orama vector database. This replaced the earlier Smart Connections + iframe WASM approach for a simpler, more reliable architecture.

**Architecture:**

```
Query → OllamaProvider.embedQuery() → Ollama /api/embed → Orama hybrid search
Files → OllamaProvider.embedDocuments() → Ollama /api/embed → Orama insert
```

**Key Files:**

- `src/search-engine.ts` — `SearchEngine` interface (abstraction over search implementations)
- `src/ollama-provider.ts` — Ollama HTTP client (embed, model info, task prefixes)
- `src/vector-store.ts` — `OramaSearchEngine implements SearchEngine` (index, search, persist)
- `src/search-view.ts` — Search panel sidebar UI

**Unified Search Architecture:**

Three old MCP tools (`search`, `find_files`, `semantic_search`) were consolidated into two:

- `search` — Unified content search with hybrid/vector/fulltext modes, tag/path filtering, quoted phrase support
- `find` — File discovery by name, path, tag, or frontmatter property (uses vault API directly, no index needed)

Uses QPS (Quantum Proximity Scoring) instead of BM25 for better phrase matching. Two-phase indexing ensures all files are fulltext-searchable even if embedding generation fails. Schema v5 adds `tags` (`enum[]`) and `folder` (`enum`) fields.

**Embedding Model Task Prefixes:**

Different embedding models require specific input prefixes for optimal retrieval quality. Without them, embeddings land in a generic space and similarity scores are meaningless.

```typescript
const MODEL_TASK_PREFIXES: Record<string, { document: string; query: string }> = {
  'nomic-embed-text':     { document: 'search_document: ', query: 'search_query: ' },
  'nomic-embed-text-v2-moe': { document: 'search_document: ', query: 'search_query: ' },
  'mxbai-embed-large':    { document: '', query: 'Represent this sentence for searching relevant passages: ' },
};
```

- **nomic-embed-text**: Both prefixes mandatory. Documents get `search_document: `, queries get `search_query: `.
- **mxbai-embed-large**: Query prefix only. Documents embedded as-is.
- **all-minilm, bge-m3, bge-large**: No prefixes needed.
- Use `embedDocuments()` for indexing and `embedQuery()` for searching — never raw `embed()`.

**Context Length & Pre-Truncation:**

Ollama's `truncate: true` parameter is unreliable on some versions, so we pre-truncate on the client side as a safety net.

```typescript
// Actual context lengths from model architecture (NOT Modelfile num_ctx!)
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'nomic-embed-text': 2048,   // nomic-bert.context_length (num_ctx 8192 is misleading)
  'all-minilm': 256,
  'mxbai-embed-large': 512,
  // ...
};

const CHARS_PER_TOKEN = 2;  // Conservative — JSON/HTML/URLs can be ~1.5 chars/token
```

**Critical Gotcha — `num_ctx` vs `context_length`:** Ollama's Modelfile may set `num_ctx 8192`, but for BERT-based embedding models, the actual embedding context window is the architecture's `context_length` field from `/api/show → model_info`. For nomic-embed-text, this is 2048, not 8192. Using the wrong value causes 400 "index length exceeded context length" errors.

**Dynamic Model Info Resolution:**

Rather than relying solely on hardcoded maps, `OllamaProvider.resolveModelInfo()` queries `/api/show` once at startup to get the actual `embedding_length` (dimensions) and `context_length` from the model's architecture metadata. The hardcoded maps serve as fallbacks when Ollama is unreachable.

**Minimum Content Length:**

Short documents (e.g., a file containing just "gold") produce generic embeddings near the centre of the vector space. These match any query with spuriously high cosine similarity, polluting search results. The `minContentLength` setting (default 50 chars) filters these out at indexing time using `file.stat.size` as a proxy.

**Index Persistence:**

The Orama database is saved to `.witness/index.orama` as a JSON envelope with a schema version number. When the schema changes (e.g., adding the `content` field for BM25), the version is bumped and old indexes are discarded on load, triggering a full re-index.

**Known Gotchas:**
- `clearIndex()` must handle the case where `vectorStore` is null (e.g., after plugin restart before first search) — delete the file directly from disk.
- The Build Index button must capture a local reference to `vectorStore` before the async indexing loop. If `clearIndex()` runs during indexing, the plugin-level reference goes null, causing "cannot read properties of null" errors.
- `loadIndexCount()` (called on settings tab open) must not overwrite an existing `vectorStore` instance created by a concurrent operation.
- **Orama schema fields are optional at insert time** — documents without embeddings are omitted from vector index but remain fully searchable via BM25/QPS. Don't set embedding to `null` or `[]`; just omit the field entirely.
- **No headless search API in Obsidian** — `prepareFuzzySearch()` and `prepareSimpleSearch()` are low-level string matchers. The internal `global-search` plugin requires UI panel open and `setTimeout` guessing. Don't try to use Obsidian's built-in search programmatically.

### Token Authentication

The plugin supports simple token-based authentication for protecting remote access.

**How It Works:**

1. When "Require Authentication" is enabled in Remote Access settings, all `/mcp` requests require a valid token
2. Token can be provided via:
   - Query parameter: `?token=xxx`
   - Authorization header: `Bearer xxx`
3. Token is auto-generated when auth is first enabled, or can be regenerated via the reset button
4. The MCP URL in settings includes the token when auth is enabled

**Implementation in [src/main.ts:946-984](src/main.ts#L946-L984):**

```typescript
private validateAuth(req: IncomingMessage): boolean {
  const expectedToken = this.settings.authToken;

  if (!expectedToken) {
    return false; // Auth enabled but no token = deny
  }

  // Check query parameter first
  const url = new URL(req.url || '', `http://localhost:${this.settings.mcpPort}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken === expectedToken) return true;

  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    if (authHeader.split(' ')[1] === expectedToken) return true;
  }

  return false;
}
```

**Security Considerations:**

- Query parameter tokens are encrypted in HTTPS transit but may appear in server logs
- For maximum security, prefer the Authorization header method
- Tokens should be kept private and regenerated if compromised
- The `/health` endpoint does NOT require authentication (for monitoring)

**Testing Authentication:**

```bash
# Without token (should fail with 401)
curl -X POST https://tunnel-url/mcp -d '...'

# With query parameter token
curl -X POST "https://tunnel-url/mcp?token=YOUR_TOKEN" -d '...'

# With Authorization header
curl -X POST https://tunnel-url/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '...'
```

## Obsidian Automation Guide

**Important Multi-Monitor Setup:**
- User has 3 monitors
- Obsidian runs on main laptop screen (Display 1)
- ALWAYS use `screencapture -D 1` to capture main screen only
- Using `screencapture` without `-D 1` captures all displays

**Launching/Controlling Obsidian:**

```bash
# Kill Obsidian
osascript -e 'tell application "Obsidian" to quit'

# Launch Obsidian
open -a Obsidian

# Open specific vault (use path, not vault name)
open "obsidian://open?path=$(pwd)/demo-vault"

# Check if Obsidian is running
osascript << 'EOF'
tell application "System Events"
    set obsidianRunning to (name of processes) contains "Obsidian"
    return obsidianRunning
end tell
EOF
```

**Taking Screenshots:**

```bash
# Capture main screen only (Display 1)
screencapture -D 1 -x /tmp/screenshot.png

# Wait before capturing to allow UI to update
sleep 1 && screencapture -D 1 -x /tmp/screenshot.png
```

**Interacting with Obsidian UI:**

```bash
# Open settings
osascript << 'EOF'
tell application "System Events"
    tell process "Obsidian"
        set frontmost to true
        delay 0.5
        keystroke "," using {command down}
        delay 1
    end tell
end tell
EOF

# Close dialog/settings with Escape
osascript << 'EOF'
tell application "System Events"
    tell process "Obsidian"
        key code 53  # Escape key
        delay 0.5
    end tell
end tell
EOF

# Open command palette
osascript << 'EOF'
tell application "System Events"
    tell process "Obsidian"
        keystroke "p" using {command down}
        delay 0.5
    end tell
end tell
EOF
```

**GUI Automation Tools:**

`cliclick` - Precise mouse clicking at screen coordinates

```bash
# Install cliclick
brew install cliclick

# Click at specific coordinates
cliclick c:100,200

# Move mouse to position
cliclick m:100,200

# Double click
cliclick dc:100,200
```

**Advanced MCP Servers for GUI Automation:**

- Added `macos-ui-automation` to `~/.claude/claude_code_config.json`
- Uses native macOS Accessibility APIs for more reliable UI interaction
- Can click elements by description rather than coordinates

**Verifying Plugin Status:**

```bash
# Check if HTTP server is running
curl -s http://localhost:3000/health
# Should return: {"status":"ok","plugin":"witness"}

# Check if plugin created data file (indicates it loaded)
cat demo-vault/.obsidian/plugins/witness/data.json

# Check enabled plugins
cat demo-vault/.obsidian/community-plugins.json
```

**Developer Console:**
- Press `Cmd+Option+I` in Obsidian to open Developer Tools
- Console tab shows plugin logs including:
  - "Witness plugin loaded"
  - "Witness MCP server listening on http://localhost:3000"
- Use screenshots to read console output

**Known Issues:**
- Navigation to specific settings pages via AppleScript is challenging
- Command palette approach may not work when settings panel is open
- UI element clicking requires precise identification
- Keyboard navigation (Tab, Arrow keys, End) is more reliable than clicking

## Plugin Requirements

- **Zero dependencies** on other Obsidian plugins (though can integrate with Smart Connections, Dataview if present)
- **Direct vault access** - no middleware or external REST APIs
- **Security** - Auth tokens, path restrictions
- **Network accessible** - Must expose HTTP/WebSocket interface for remote access

## Key Files

- `witness-overview.md` - Complete vision, architecture, and requirements document
- `demo-vault/` - Demo vault for manual testing (chaos/order structure)
- `test/` - Integration test suite and minimal test vault
- `README.md` - User-facing documentation
- `CLAUDE.md` - This file (technical guide for AI assistants)
- `src/main.ts` - Main plugin implementation
- `DEVLOG` - Development log with dated entries
- `PHASE1-COMPLETE.md` - Phase 1 completion summary

## Development Process

### Session Wrap-Up Protocol

At the end of each development session, use the `/wrap-up` slash command or follow this process:

1. **Update DEVLOG**
   - Add new dated entry at the bottom
   - Format: `## YYYY-MM-DD - Session Title`
   - Include: objectives, what was built, challenges, learnings, statistics
   - Write narratively, capturing the journey not just the commits

2. **Update CLAUDE.md**
   - Add new learnings to relevant sections
   - Update Phase status if changed
   - Document any new patterns or pitfalls discovered

3. **Update README.md** (if needed)
   - Add new features to feature list
   - Update installation instructions if changed
   - Add new examples or usage patterns

4. **Commit Everything**
   - Review all changes with `git status`
   - Create comprehensive commit message
   - Include Co-Authored-By line

5. **Create Session Summary**
   - Statistics (commits, files changed, lines added)
   - Key achievements
   - Blockers encountered and resolved
   - Next session priorities

### DEVLOG Format

```markdown
## YYYY-MM-DD - Session Title

**Objective**: Clear statement of what we set out to do

### What We Built

Bulleted list of concrete deliverables

### The Journey

Narrative of the development process, including:
- Key decisions and why
- Problems encountered
- Debugging process
- Breakthroughs and insights

### Technical Achievements

Specific technical wins

### Key Learnings

Lessons that will help future development

### Statistics

Quantitative measures of progress

### Next Steps

What's coming in the next session

### Reflections

Meta-observations about the process

---

*End of log entry*
```

## Development Log

### Session 1: Initial MCP Server Implementation (2026-01-30)

**Objective**: Create Obsidian plugin that acts as MCP server inside Obsidian

**Key Decisions**:

1. ✅ Chose "Approach A" - Plugin IS the MCP server (vs external server connecting via REST API)
2. ✅ Used official `@modelcontextprotocol/sdk` package (vs manual JSON-RPC implementation)
3. ✅ Used `StreamableHTTPServerTransport` for HTTP+SSE transport
4. ✅ Connected via `mcp-remote` bridge (stdio → HTTP) for Claude Desktop

**Major Challenges**:

1. **Session Management Bug** (Most Critical)
   - **Symptom**: "Server already initialized" error on every connection attempt
   - **Root Cause**: Creating new transport per request instead of per session
   - **Solution**: Maintain `Map<sessionId, transport>` and only call `connect()` once per session
   - **Learning**: StreamableHTTP is stateful - sessions span multiple HTTP requests
   - **Reference**: SDK examples at `node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js`

2. **SSE Stream 404 Errors**
   - **Symptom**: Tools listed successfully, then "Failed to open SSE stream: Not Found"
   - **Root Cause**: Only handling POST requests, not GET requests for SSE
   - **Solution**: Handle both `POST` (messages) and `GET` (SSE) to `/mcp` endpoint
   - **Learning**: StreamableHTTP uses dual endpoints - POST for sending, GET for receiving

3. **Request Body Parsing**
   - **Symptom**: Errors when handling GET requests
   - **Root Cause**: Trying to parse body on GET requests (SSE streams)
   - **Solution**: Only parse body for POST, pass `undefined` for GET
   - **Learning**: GET requests in HTTP don't have bodies

4. **Node Version Confusion** (Red Herring)
   - **Symptom**: mcp-remote failing with "File is not defined" (Node 18 vs 20 issue)
   - **Investigation**: Extensive attempts to force Node v24 via PATH environment
   - **Reality**: This was never the real blocker - session management was the issue
   - **Status**: Still using Node v18 but everything works anyway
   - **Learning**: PATH env variable in Claude Desktop config doesn't override which `npx` binary is found first

**Timeline**:

- Initial implementation: Manual JSON-RPC handling → buggy and incomplete
- Refactor: Switched to official SDK → cleaner API but still buggy
- Debug phase: Multiple connection attempts, all failing with various errors
- Deep dive: Explored SDK source code and found session management examples
- Breakthrough: Discovered session management pattern in SDK examples
- Final fix: Proper session map + SSE endpoint support → success!

**Code Structure**:

- `startMCPServer()`: Creates McpServer instance and HTTP server
- `registerTools()`: Registers read_file, write_file, list_files with Zod schemas
- `handleMCPRequest()`: Routes requests, manages sessions, handles POST/GET
- `stopMCPServer()`: Cleans up all transports and closes server
- `transports: Map<string, transport>`: Session state management

**Critical Implementation Pattern**:

```typescript
// NEW SESSION: create transport, connect, store
if (!sessionId && isInitialize) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `session-${Date.now()}-${Math.random()}`,
    onsessioninitialized: (id) => this.transports.set(id, transport)
  });
  await this.mcpServer.connect(transport);  // Only once per session!
  await transport.handleRequest(req, res, body);
}

// EXISTING SESSION: retrieve and reuse
if (sessionId && this.transports.has(sessionId)) {
  const transport = this.transports.get(sessionId)!;
  await transport.handleRequest(req, res, body);  // No reconnect!
}
```

**Testing Approach**:

- Health endpoint (`/health`) for quick verification
- Direct HTTP calls with curl for debugging
- Claude Desktop logs (`~/Library/Logs/Claude/mcp-server-witness.log`)
- Screenshots for UI verification
- Force quit/restart cycle for clean testing

**Dependencies Added**:

- `@modelcontextprotocol/sdk`: ^1.25.3
- `raw-body`: ^3.0.0
- `zod`: ^4.3.6

**Config Files Modified**:

- `tsconfig.json`: Added `esModuleInterop` and `allowSyntheticDefaultImports`
- `~/.claude/claude_desktop_config.json`: Added witness MCP server config
- `package.json`: Added dependencies

**Current State**: Phase 1 partially complete

- ✅ Claude Desktop connected and working
- ✅ Three file operation tools available
- ✅ Session management working correctly
- ✅ SSE streams established
- ❌ Still need: edit, search, command execution tools

**Next Steps**:

1. Implement `edit_file` tool with find/replace
2. Implement `search` tool for text and semantic search
3. Implement `execute_command` tool for Obsidian commands
4. Add authentication token support
5. Test end-to-end workflows
