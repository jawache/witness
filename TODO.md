# TODO

## High Priority

## Next Up

- [ ] [Hybrid search](docs/features/hybrid-search.md) — Add BM25 + semantic hybrid search via Orama's built-in mode. Highest impact, lowest effort.
- [ ] [Markdown chunking](docs/features/markdown-chunking.md) — Split documents by headings before embedding. Improves retrieval for long documents.
- [ ] [Re-ranking](docs/features/reranking.md) — Optional Ollama-based re-ranking for higher precision results.

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
- [x] Integration test suite (23 tests, all MCP tools covered)
- [x] MCP server logging to file (.obsidian/plugins/witness/logs/)
- [x] Move/rename file tool (move_file)
- [x] Ollama integration — Local embeddings via Ollama + Orama vector store
- [x] Tabbed settings UI with Ollama configuration and model pull
