# TODO

## High Priority

## Next Up
- [ ] [Re-ranking](docs/features/reranking.md) — Optional Ollama-based re-ranking for higher precision results.
- [ ] [Link discovery](docs/features/link-discovery.md) — Discover connections between notes using embeddings + local LLM, Grammarly-style review panel

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
- [x] Remote access via Cloudflare Tunnel (quick + named)
- [x] [Unified search](docs/features/unified-search.md) — Consolidated search/semantic_search/find_files into two tools (search + find), QPS scoring, tag/path filtering, two-phase indexing
- [x] [Phrase search boosting](docs/features/phrase-search-boosting.md) — Stop word stripping, phrase boost via partition, shared search method for MCP + sidebar
- [x] [Find tool sorting](docs/features/find-sorting.md) — sortBy parameter with date auto-detection, nulls-to-end
- [x] [Search panel filters](docs/features/search-panel-filters.md) — Path and tag filtering in sidebar with AbstractInputSuggest autocomplete
- [x] [Background indexing](docs/features/background-indexing.md) — Automatic incremental indexing with periodic reconciliation, status bar indicator, and log viewer
- [x] [Chaos triage](docs/features/chaos-triage.md) — MCP tools for processing chaos items (get_next_chaos, mark_triage), AI guardrails for safe file operations
