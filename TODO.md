# TODO

## High Priority

(None currently)

## Features

### Move/Rename File Tool

Add `move_file` MCP tool to move or rename files within the vault. Currently would require delete + create which loses metadata and is error-prone. Obsidian has `vault.rename()` API for this.

### Remote Access via Internet Tunnel

Implement Cloudflare Tunnel or similar for remote access to the MCP server from Claude Desktop/Mobile when away from home network. See `docs/features/remote-access-tunneling.md` for details.

## Completed

- [x] Phase 1: Core MCP Server (6 tools)
- [x] Dynamic tool configuration via settings
- [x] Custom commands system
- [x] Permission hints (readOnlyHint/destructiveHint)
- [x] Orientation document (get_orientation tool)
- [x] Searchable command picker (SuggestModal)
- [x] File picker for orientation document
- [x] Server instructions configuration
- [x] Debug logging for MCP requests
- [x] Integration test suite (17 tests, all MCP tools covered)
- [x] MCP server logging to file (.obsidian/plugins/witness/logs/)
