# Witness

> Your AI companion for transforming chaos into order

Witness is an Obsidian plugin that turns your vault into an intelligent, AI-accessible knowledge base. It runs an MCP (Model Context Protocol) server directly inside Obsidian, allowing Claude Desktop and other AI assistants to read, write, and organize your notes on your behalf.

## Philosophy: Chaos → Order

Witness is built around a simple organizational philosophy:

- **Chaos**: Unprocessed information flowing in from the world (articles, videos, quick notes, transcripts)
- **Order**: Structured knowledge you've refined and organized (topics, projects, synthesis)

The plugin helps you move information from chaos to order, with AI assistance to process, categorize, and synthesize your notes.

## Features

### Current (Phase 1 + 2 + 3) ✅

- **MCP Server**: Runs inside Obsidian, no external dependencies
- **File Operations**: Read, write, edit, and list files in your vault via AI
- **Full-Text Search**: Search across all markdown files with optional filters
- **Semantic Search**: Find documents by meaning using Smart Connections embeddings
- **Command Execution**: Execute any Obsidian command via AI
- **Claude Desktop Integration**: Connect directly from Claude Desktop app
- **Remote Access**: Cloudflare Quick Tunnel or Named Tunnel (permanent URL) for access from anywhere
- **Named Tunnel Support**: Use your own domain with Cloudflare Named Tunnels for a permanent, stable URL
- **Primary Machine**: Designate which machine runs the tunnel when syncing across multiple devices
- **Token Authentication**: Protect your remote endpoint with a simple token
- **Privacy First**: Everything runs locally, your tunnel, your data

**13 MCP Tools Available**:

- `read_file` - Read file contents
- `write_file` - Create/modify files
- `list_files` - Browse directories
- `edit_file` - Find and replace text
- `search` - Full-text search with filters
- `find_files` - Search files by name pattern
- `move_file` - Move or rename files
- `copy_file` - Copy files to new location
- `create_folder` - Create folders (with mkdir -p support)
- `delete` - Delete files/folders (with trash support)
- `execute_command` - Run Obsidian commands
- `get_vault_context` - Load your vault's context document
- `semantic_search` - Find documents by meaning (requires Smart Connections plugin)

### Coming Soon

- **Chat Interface**: Connect via WhatsApp/Telegram for mobile access
- **Heartbeat Prompts**: Daily/weekly prompts to keep your vault fresh
- **Chaos Monitoring**: Get notified when unprocessed items pile up

## Installation

### Prerequisites

- Obsidian 1.0.0 or higher
- Node.js 20+ (for Claude Desktop connection)
- Claude Desktop app (optional, for AI integration)

### Install via BRAT (Recommended)

The easiest way to install Witness is using the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Obsidian's Community Plugins
2. Open BRAT settings and click "Add Beta Plugin"
3. Enter: `jawache/witness`
4. Click "Add Plugin"
5. Enable Witness in Community Plugins

BRAT will automatically keep Witness updated when new releases are published.

### Manual Installation

If you prefer to install manually:

1. **Download the latest release**
   - Go to [Releases](https://github.com/jawache/witness/releases)
   - Download `main.js` and `manifest.json`

2. **Install in your vault**
   ```bash
   # Create plugin folder
   mkdir -p /path/to/your/vault/.obsidian/plugins/witness/

   # Copy files
   cp main.js manifest.json /path/to/your/vault/.obsidian/plugins/witness/
   ```

3. **Enable in Obsidian**
   - Open Obsidian Settings → Community Plugins
   - Disable Safe Mode if prompted
   - Find "Witness" in the list and enable it

### Build from Source

For developers who want to build from source:

1. **Clone the repository**
   ```bash
   git clone https://github.com/jawache/witness.git
   cd witness
   ```

2. **Build the plugin**
   ```bash
   npm install
   npm run build
   ```

3. **Install in your vault**

   ```bash
   cp main.js manifest.json /path/to/your/vault/.obsidian/plugins/witness/
   ```

### Connect to Claude Desktop

1. **Configure Claude Desktop**

   Edit `~/.claude/claude_desktop_config.json` (or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

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

2. **Restart Claude Desktop**

3. **Verify Connection**

   In Claude Desktop, you should see "witness" in the MCP servers list. Try asking:

   > "Can you list the files in my vault?"

## Usage

### Organizing Your Vault

For best results, organize your vault with these top-level folders:

```
vault/
├── chaos/
│   ├── external/     # Articles, videos, clippings
│   └── inbox/        # Quick capture notes
└── order/
    ├── knowledge/    # Organized information
    ├── heartbeat/    # Daily/weekly notes
    ├── projects/     # Active work
    └── synthesis/    # Published output
```

This structure isn't required, but Witness is designed to help you maintain this flow.

### Settings

Open Obsidian Settings → Witness:

- **Enable MCP Server**: Turn the server on/off
- **Port**: HTTP server port (default: 3000)
- **Enable Quick Tunnel**: Expose your MCP server via Cloudflare tunnel
- **Require Authentication**: Protect remote access with a token

### Remote Access

Witness supports two types of Cloudflare tunnels to expose your vault remotely:

#### Option A: Quick Tunnel (Easy, Temporary)

A quick tunnel gives you a random URL that changes every time Obsidian restarts. Good for testing.

1. Go to Obsidian Settings → Witness
2. Toggle "Enable Tunnel"
3. Set Tunnel Type to "Quick Tunnel (ephemeral)"
4. Wait for the tunnel URL to appear
5. Enable "Require Authentication" and copy your MCP URL

The URL will look like: `https://random-words.trycloudflare.com/mcp?token=xxx`

#### Option B: Named Tunnel (Permanent URL)

A named tunnel gives you a permanent URL on your own domain. Requires a free Cloudflare account.

**Step 1: Create the tunnel in Cloudflare**

1. Sign up at [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. Go to **Networks → Tunnels**
3. Click **Create a tunnel**
4. Choose **Cloudflared** as the connector type
5. Name your tunnel (e.g., "witness")
6. On the "Install connector" page, **copy the tunnel token** (the long `eyJh...` string)
7. Skip the connector installation (Witness handles this automatically)
8. Add a **Public Hostname**:
   - Subdomain: e.g., `witness`
   - Domain: select your domain (e.g., `example.com`)
   - Service Type: `HTTP`
   - URL: `localhost:3456` (or whatever port you set in Witness settings)
9. Save the tunnel

**Step 2: Configure Witness**

1. Go to Obsidian Settings → Witness
2. Set the MCP Server Port to match your tunnel config (e.g., `3456`)
3. Toggle "Enable Tunnel"
4. Set Tunnel Type to **"Named Tunnel (permanent)"**
5. Paste your **Tunnel Token** from Cloudflare
6. Set **Tunnel URL** to your public hostname (e.g., `https://witness.example.com`)
7. Enable "Require Authentication" (recommended)
8. Click "Copy URL" to get your full MCP URL

**Step 3: Connect Claude**

Use the tunnel URL in your MCP client configuration:

```json
{
  "mcpServers": {
    "witness": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://witness.example.com/mcp?token=YOUR_TOKEN",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

This works with Claude Desktop, Claude.ai web, and Claude mobile.

### Multiple Devices (Obsidian Sync)

If you sync your vault across multiple computers using Obsidian Sync, the Witness plugin settings sync too — including the tunnel token. Without precaution, every machine would try to start the tunnel, and Cloudflare would round-robin traffic between them unpredictably.

To prevent this, Witness has a **Primary Machine** feature:

1. Open Obsidian Settings → Witness on the machine you want to run the tunnel
2. Under Named Tunnel settings, click **"Set as primary"**
3. This saves the machine's hostname — only this machine will start the tunnel
4. On other machines, the tunnel is silently skipped on startup

To switch the primary to a different machine, open Witness settings on that machine and click "Set as primary". To clear the restriction entirely, click the **✕** button next to the primary hostname.

### Mobile Devices

The tunnel and MCP server features are **desktop-only**. Obsidian mobile (iOS/Android) cannot run the HTTP server or cloudflared binary. To access your vault from a mobile device, connect to the tunnel URL from a client app (e.g., Claude mobile) — the vault is served by whichever desktop machine is running the tunnel.

### Security Notes

- The auth token is included in the URL query parameter. HTTPS encrypts this in transit, but be cautious about sharing URLs or logging them.
- For additional security, the token can also be passed via `Authorization: Bearer xxx` header instead of the query parameter.
- The `cloudflared` binary is automatically downloaded and stored in `~/.witness/bin/`.

### Example Commands

Once connected to Claude Desktop, you can ask:

- "Show me all the files in my chaos/inbox folder"
- "Read the contents of my daily note"
- "Create a new note in order/knowledge about [topic]"
- "List all markdown files in my vault"

## Development

### Building

```bash
npm run build          # Production build
npm run dev            # Development mode with watch
```

### Testing

```bash
# Build and install plugin in test vault
npm run test:install-plugin

# Start Obsidian with test vault
npm run test:start-obsidian

# Run integration tests (23 tests)
npm test

# Check server status
curl http://localhost:3000/health
```

### Logs

MCP server logs are written to your vault's plugin folder:

```text
.obsidian/plugins/witness/logs/mcp-YYYY-MM-DD.log
```

This makes it easy to:

- Share logs for bug reports
- Debug issues without Developer Console
- Let AI assistants read logs directly

Additional log locations:
- Obsidian console: `Cmd+Option+I` → Console tab
- Claude Desktop: `~/Library/Logs/Claude/mcp-server-witness.log`

## Troubleshooting

### Plugin won't load

1. Check Obsidian console for errors
2. Verify files are in correct location: `.obsidian/plugins/witness/`
3. Try disabling and re-enabling the plugin

### Claude Desktop won't connect

1. Check the MCP server is running:
   ```bash
   curl http://localhost:3000/health
   # Should return: {"status":"ok","plugin":"witness"}
   ```

2. Check Claude Desktop logs:
   ```bash
   tail -f ~/Library/Logs/Claude/mcp-server-witness.log
   ```

3. Verify Node.js version:
   ```bash
   node --version  # Should be 20.x or higher
   ```

### Port already in use

If port 3000 is taken:
1. Open Obsidian Settings → Witness
2. Change the port number (e.g., 3001)
3. Update your Claude Desktop config to match

## Architecture

Witness runs an HTTP server inside Obsidian's Electron process:

```
Claude Desktop (MCP Client)
    ↓ stdio
mcp-remote bridge
    ↓ HTTP + SSE
Witness Plugin (MCP Server)
    ↓ Direct API
Obsidian Vault
```

This is different from other Obsidian MCP servers that run externally and connect via REST APIs. Witness has direct access to Obsidian's internal APIs for maximum reliability and performance.

## Roadmap

### Phase 1: MCP Server ✅

- [x] Basic plugin scaffold
- [x] HTTP server implementation
- [x] File operations (read, write, list, edit)
- [x] Claude Desktop integration
- [x] Full-text search
- [x] Command execution
- [x] Orientation document system
- [x] File-based logging
- [x] Integration test suite (23 tests)

### Phase 2: Remote Access ✅
- [x] Cloudflare Quick Tunnel integration
- [x] Cloudflare Named Tunnel support (permanent URLs)
- [x] Primary machine designation for multi-device sync
- [x] Token authentication for remote access
- [ ] WhatsApp/Telegram bot
- [ ] Multi-user sessions

### Phase 3: Semantic Search ✅

- [x] Smart Connections integration for document embeddings
- [x] Local WASM embeddings for query generation (transformers.js in iframe)
- [x] Cosine similarity search with incremental caching
- [x] Filter by paths
- [x] Tested on 4,097-document vault

### Phase 4: Intelligence

- [ ] Heartbeat scheduler (daily/weekly prompts)
- [ ] Chaos monitoring (detect stale items)
- [ ] Smart suggestions
- [ ] Auto-categorization

### Phase 5: Advanced Features

- [ ] Graph analysis
- [ ] Template system
- [ ] Workflow automation

## Contributing

Contributions are welcome! This project is in active early development.

### Guidelines

- Keep it simple and focused
- Maintain zero dependencies on other plugins
- Test with the included `test-vault/`
- Follow the existing code style

## License

MIT

## Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
- Inspired by the Zettelkasten and PARA methods
- Thanks to the Obsidian community for the amazing platform

## Support

- **Issues**: [GitHub Issues](https://github.com/jawache/witness/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jawache/witness/discussions)
- **Twitter**: [@jawache](https://twitter.com/jawache)

---

*"The best way to predict the future is to invent it." - Alan Kay*
