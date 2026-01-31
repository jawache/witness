# TODO

## High Priority

### Testing Infrastructure
Build automated testing for the MCP server and plugin functionality. We've implemented a lot of features without proper test coverage.

### MCP Server Logging to File
Store MCP server logs in the Obsidian plugin folder (`test-vault/.obsidian/plugins/witness/logs/`). Benefits:
- Claude Code can read logs directly to debug issues
- End users can easily access and share logs for bug reports
- No need to dig through system logs or Developer Console

## Features

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
