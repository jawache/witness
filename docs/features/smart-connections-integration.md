# Smart Connections Integration for Semantic Search

## Overview

Replace custom iframe-based embedding indexing with Smart Connections' pre-built embeddings. This leverages SC's mature, stable indexing while keeping query embedding capability for semantic search.

## Architecture

```
semantic_search request
    ↓
Check SC configured with TaylorAI/bge-micro-v2
    ↓
Load/refresh embedding cache (incremental)
    ↓
Generate query embedding (iframe)
    ↓
Cosine similarity against cached vectors
    ↓
Return ranked results
```

## Smart Connections File Format

**Location:** `.smart-env/multi/*.ajson`

**Format:** AJSON (append-only JSON), one entry per line:
```json
"smart_sources:path/to/file.md": {
  "path": "path/to/file.md",
  "embeddings": {
    "TaylorAI/bge-micro-v2": {
      "vec": [-0.098, 0.011, ...],  // 384 dimensions
      "last_embed": {"hash": "abc123", "tokens": 42}
    }
  },
  "blocks": {"#Heading": [1, 10]},
  "last_read": {"hash": "abc123", "at": 1234567890}
}
```

**Config:** `.smart-env/smart_env.json`
```json
{
  "smart_sources": {
    "embed_model": {
      "adapter": "transformers",
      "transformers": {
        "model_key": "TaylorAI/bge-micro-v2"
      }
    }
  }
}
```

## Incremental Caching Strategy

### Cache Structure
```typescript
interface EmbeddingCache {
  entries: Map<string, { path: string; vector: number[] }>;
  lastLoadTime: number;
  folderMtime: number;
}
```

### Cache Refresh Logic

1. **First search:**
   - Load ALL `.ajson` files from `.smart-env/multi/`
   - Store `lastLoadTime = Date.now()`
   - Store `folderMtime` of multi folder

2. **Subsequent searches:**
   - Check `multi/` folder mtime
   - If unchanged → use cache as-is
   - If changed:
     - Check each file's mtime
     - Only reload files where `mtime > lastLoadTime`
     - Update cache entries for changed files
     - Update `lastLoadTime`

### Memory Usage
- ~4000 files × 384 floats × 4 bytes = **6.3MB** vectors
- ~4000 paths × 100 bytes = **400KB** paths
- **Total: ~7MB** (negligible)

## MCP Tool Changes

### Remove
- `index_documents` tool - SC handles all indexing

### Update: `semantic_search`

**Parameters:**
- `query` (string, required) - Search query
- `limit` (number, optional) - Max results (default: 10)
- `minScore` (number, optional) - Minimum similarity (default: 0.3)
- `tags` (string[], optional) - Filter by tags
- `paths` (string[], optional) - Filter by folder paths

**Validation:**
1. Check `.smart-env/smart_env.json` exists
2. Verify `smart_sources.embed_model.transformers.model_key === "TaylorAI/bge-micro-v2"`
3. Check `.smart-env/multi/` folder exists and has files

**Errors:**
- "Smart Connections plugin not configured. Please install Smart Connections and enable embeddings."
- "Smart Connections is using a different embedding model ({model}). Please configure it to use TaylorAI/bge-micro-v2 for compatibility with Witness."
- "No embeddings found. Please run Smart Connections indexing first."

## Code Changes

### Files to Remove
- `src/embedding-index.ts` - Custom storage (replaced by SC)
- `src/document-indexer.ts` - Custom indexing logic

### Files to Keep
- `src/embedding-service-iframe.ts` - Query embedding generation

### Files to Create
- `src/smart-connections-reader.ts` - SC file reading and caching

### Files to Modify
- `src/main.ts`:
  - Remove `index_documents` tool
  - Update `semantic_search` to use SC reader
  - Remove file change listeners for custom indexing

## Implementation Phases

### Phase 1: SC Reader
- Create `SmartConnectionsReader` class
- Parse `.ajson` format
- Validate SC config and model
- Load embeddings into cache

### Phase 2: Incremental Updates
- Track file mtimes
- Implement folder mtime check optimization
- Refresh only changed files

### Phase 3: Tool Integration
- Update `semantic_search` to use SC reader
- Remove `index_documents` tool
- Add proper error messages

### Phase 4: Cleanup
- Remove unused embedding code
- Update tests
- Update documentation

## Testing

### Test Cases
1. SC not installed → helpful error message
2. SC wrong model → error with model name
3. SC no embeddings → prompt to run indexing
4. First search → loads all embeddings
5. Second search (no changes) → uses cache
6. File modified → refreshes that file only
7. Search with filters → correct filtering
