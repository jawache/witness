# TODO

## High Priority

## Next Up

- [ ] [Chaos triage](docs/features/chaos-triage.md) — MCP tools and prompt for processing chaos items one at a time (get_next_chaos, triage_chaos)
- [ ] [Background indexing](docs/features/background-indexing.md) — Automatic incremental indexing with status bar indicator and log viewer.
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
- [x] Hybrid search — BM25 + semantic via Orama's built-in hybrid mode with RRF
- [x] Unit + integration test suite (53 tests)
- [x] [Unified search](docs/features/unified-search.md) — Consolidated search/semantic_search/find_files into two tools (search + find), QPS scoring, tag/path filtering, two-phase indexing
