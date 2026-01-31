# Witness

> Your AI companion for transforming chaos into order

Witness is an Obsidian plugin that turns your vault into an intelligent, AI-accessible knowledge base. It runs an MCP (Model Context Protocol) server directly inside Obsidian, allowing Claude Desktop and other AI assistants to read, write, and organize your notes on your behalf.

## Philosophy: Chaos → Order

Witness is built around a simple organizational philosophy:

- **Chaos**: Unprocessed information flowing in from the world (articles, videos, quick notes, transcripts)
- **Order**: Structured knowledge you've refined and organized (topics, projects, synthesis)

The plugin helps you move information from chaos to order, with AI assistance to process, categorize, and synthesize your notes.

## Features

### Current (Phase 1) ✅ COMPLETE

- **MCP Server**: Runs inside Obsidian, no external dependencies
- **File Operations**: Read, write, edit, and list files in your vault via AI
- **Full-Text Search**: Search across all markdown files with optional filters
- **Command Execution**: Execute any Obsidian command via AI
- **Claude Desktop Integration**: Connect directly from Claude Desktop app
- **Privacy First**: Everything runs locally, no external API calls

**8 MCP Tools Available**:

- `read_file` - Read file contents
- `write_file` - Create/modify files
- `list_files` - Browse directories
- `edit_file` - Find and replace text
- `search` - Full-text search with filters
- `find_files` - Search files by name pattern
- `execute_command` - Run Obsidian commands
- `get_orientation` - Load your vault's orientation document

### Coming Soon

- **Move/Rename**: Move and rename files within the vault
- **Chat Interface**: Connect via WhatsApp/Telegram for mobile access
- **Remote Access**: Cloudflare Tunnel for access from anywhere
- **Heartbeat Prompts**: Daily/weekly prompts to keep your vault fresh
- **Chaos Monitoring**: Get notified when unprocessed items pile up

## Installation

### Prerequisites

- Obsidian 1.0.0 or higher
- Node.js 20+ (for Claude Desktop connection)
- Claude Desktop app (optional, for AI integration)

### Install the Plugin

1. **Download the plugin**
   ```bash
   # Clone the repository
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
   # Copy to your vault's plugins folder
   cp main.js manifest.json /path/to/your/vault/.obsidian/plugins/witness/
   ```

4. **Enable in Obsidian**
   - Open Obsidian Settings → Community Plugins
   - Disable Safe Mode if prompted
   - Find "Witness" in the list and enable it

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
- **Authentication Token**: (Coming soon) Secure your server

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

# Run integration tests (19 tests)
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
- [x] Integration test suite (19 tests)

### Phase 2: Remote Access
- [ ] Cloudflare Tunnel integration
- [ ] WhatsApp/Telegram bot
- [ ] Mobile app support
- [ ] Multi-user sessions

### Phase 3: Intelligence
- [ ] Heartbeat scheduler (daily/weekly prompts)
- [ ] Chaos monitoring (detect stale items)
- [ ] Smart suggestions
- [ ] Auto-categorization

### Phase 4: Advanced Features
- [ ] Semantic search (Smart Connections integration)
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
