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
- Test using `test-vault/` directory

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

**Automated Testing with MCP Servers:**
- `applescript-mcp` - Launch/quit Obsidian programmatically
- `peekaboo` - Capture screenshots of Obsidian UI for verification
- MCP servers configured in `~/.claude/claude_code_config.json`

**Test Vault:**
- Located at `test-vault/` with proper chaos/order structure
- Use for development and testing file operations
- Sample files demonstrate the organizational system

**Critical Testing Flow:**
1. Build plugin: `source ~/.zshrc && npm run build`
2. Install in test vault: `cp main.js manifest.json test-vault/.obsidian/plugins/witness/`
3. Enable plugin: `echo '["witness"]' > test-vault/.obsidian/community-plugins.json`
4. Launch Obsidian with test-vault
5. Verify plugin loads and HTTP server responds
6. Test MCP endpoints
7. Capture screenshots to verify UI state

### Phase 1 Status: 🚧 IN PROGRESS

**Working:**
- ✅ Claude Desktop successfully connected to Witness MCP server
- ✅ `tools/list` - Returns 3 tools (read_file, write_file, list_files)
- ✅ `read_file` - Successfully reads vault files
- ✅ `write_file` - Creates and modifies files in vault
- ✅ `list_files` - Lists directory contents
- ✅ HTTP health endpoint responding
- ✅ Plugin loads in Obsidian on startup
- ✅ Files created via MCP visible in Obsidian UI
- ✅ Session management and SSE streams working correctly

**Still TODO:**
- ❌ `edit_file` - Find/replace for surgical file updates
- ❌ `search` - Text search across vault (+ semantic if Smart Connections available)
- ❌ `execute_command` - Trigger Obsidian commands via MCP

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

**Logs:** `~/Library/Logs/Claude/mcp-server-witness.log`

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
open "obsidian://open?path=$(pwd)/test-vault"

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
cat test-vault/.obsidian/plugins/witness/data.json

# Check enabled plugins
cat test-vault/.obsidian/community-plugins.json
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
- `test-vault/` - Test vault with chaos/order structure
- `README.md` - User-facing documentation
- `CLAUDE.md` - This file (technical guide for AI assistants)
- `src/main.ts` - Main plugin implementation

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
