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
- ✅ `write_file` - Create and modify files in vault
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
- ✅ Integration test suite (23 tests)

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

Semantic Search via Smart Connections Integration:

- ✅ `semantic_search` MCP tool - find documents by meaning
- ✅ Reads embeddings from Smart Connections plugin (`.smart-env/multi/*.ajson`)
- ✅ Validates SC model compatibility (`TaylorAI/bge-micro-v2`)
- ✅ Incremental caching with mtime tracking (~265ms cached searches)
- ✅ Iframe WASM embeddings for query embedding only (transformers.js)
- ✅ Cosine similarity search with path filtering
- ✅ Tested on 4,097-document vault

Total: 13 MCP tools registered and available

### Dataview Integration

- ✅ `dataview_query` MCP tool - execute DQL queries (markdown or JSON output)
- ✅ `read_file` render parameter - resolve Dataview codeblocks before returning
- ✅ `get_orientation` auto-renders Dataview blocks (AI sees live data)
- ✅ 8 integration tests for Dataview features
- ✅ Test vault includes Dataview plugin and topic test files

**Plugin Load Order:** Always register tools unconditionally and check Dataview availability at call time. Dataview may not be loaded when Witness starts.

**Dataview API Access:** `(this.app as any).plugins.plugins.dataview?.api` — returns the DV API or undefined.

Total: 15 MCP tools registered and available

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

### Semantic Search & Iframe WASM Pattern

The plugin includes semantic search powered by local WASM embeddings. This was challenging to implement due to Obsidian's hybrid Electron environment.

**The Problem:**
Obsidian's Electron renderer has both Node.js and browser APIs available. This confuses ONNX runtime's backend selection - it detects Node.js, tries native bindings, fails, then can't properly initialize WASM fallback.

**The Solution: Iframe Isolation**
Create a hidden iframe with `srcdoc` to provide a clean browser-only context:

```typescript
// Create isolated browser context
this.iframe = document.createElement('iframe');
this.iframe.style.display = 'none';
this.iframe.srcdoc = `
  <script type="module">
    const transformers = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0');
    // WASM initializes correctly in clean browser context!
  </script>
`;
document.body.appendChild(this.iframe);
```

**Key Files:**

- `src/embedding-service-iframe.ts` - Iframe-based embedding service (query embeddings only)
- `src/smart-connections-reader.ts` - Reads pre-built embeddings from Smart Connections plugin

**Credit:** The iframe isolation pattern was learned from the Smart Connections plugin's approach.

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
