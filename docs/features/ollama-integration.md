# Feature Spec: Ollama Integration

**Status:** Planned
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

Replace Smart Connections and the iframe WASM embedding hack with Ollama as the sole embedding provider. Witness will own its embedding index entirely, using Ollama's HTTP API for embedding generation. This eliminates the dependency on Smart Connections' proprietary `.ajson` format and the fragile iframe/WASM/WebGPU workaround.

## Problem Statement

The current semantic search implementation has two problems:

**1. External plugin dependency.** The current approach reads pre-built embeddings from Smart Connections' internal storage format. Coupling to another plugin's internal data format is fragile and limits Witness's ability to evolve independently.

**2. The iframe WASM approach is fragile.** Generating query embeddings requires an elaborate workaround: creating a hidden iframe with `srcdoc` to provide a clean browser context because ONNX runtime's backend selection breaks in Electron's hybrid Node.js/browser environment. This involves ~400 lines of code handling WebGPU detection, fp16/fp32 fallback, WASM fallback, throttling, error counting, and iframe lifecycle management. It works but is a maintenance burden.

## Solution: Ollama as Sole Embedding Provider

Replace both Smart Connections reading AND iframe WASM with simple HTTP calls to Ollama's `/api/embed` endpoint.

### Architecture

```
Before (current):
┌──────────────────────────────────────────────────────────────┐
│ Smart Connections Plugin                                      │
│ └── .smart-env/multi/*.ajson  ──read──→  Witness (documents) │
│                                                               │
│ Hidden Iframe (transformers.js + WASM)  ──→  Witness (query) │
└──────────────────────────────────────────────────────────────┘

After (Ollama):
┌──────────────────────────────────────────────────────────────┐
│ Ollama (localhost:11434)                                      │
│ └── /api/embed  ──HTTP──→  Witness (documents AND queries)   │
│                                                               │
│ .witness/embeddings/  ──→  Witness-owned vector index         │
└──────────────────────────────────────────────────────────────┘
```

### Why Ollama

- **Well-established OSS project** — widely adopted, multi-platform (macOS, Linux, Windows), active development
- **Simple HTTP API** — just `POST /api/embed`, no SDKs or iframe hacks needed
- **Batch support** — embed multiple documents in a single request
- **Better models** — `nomic-embed-text` (768d) significantly outperforms `bge-micro-v2` (384d)
- **Fast on Apple Silicon** — ~9,300 tokens/sec with Metal acceleration on M2 Max
- **Dual-purpose** — same instance can serve embeddings AND an LLM for future RAG features
- **Huge model ecosystem** — any GGUF-compatible embedding model works

### What Gets Removed

| Component | File | Lines | Replacement |
|-----------|------|-------|-------------|
| Smart Connections reader | `src/smart-connections-reader.ts` | ~200 | Ollama `/api/embed` |
| Iframe WASM embeddings | `src/embedding-service-iframe.ts` | ~400 | Ollama `/api/embed` |
| SC model validation | `src/smart-connections-reader.ts` | ~30 | Ollama model config |
| WebGPU/WASM fallback chain | `src/embedding-service-iframe.ts` | ~100 | Not needed |

**Total removed:** ~730 lines of complex, fragile code
**Replaced by:** ~150 lines of HTTP client code

## Ollama API

### Embedding (single or batch)

```typescript
const response = await fetch('http://localhost:11434/api/embed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'nomic-embed-text',
    input: ['document 1 text', 'document 2 text', 'document 3 text']
  })
});

const data = await response.json();
// data.embeddings = [[0.123, -0.456, ...], [0.789, ...], [0.345, ...]]
// All vectors are L2-normalised
```

### Availability check

```typescript
async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    return response.ok;
  } catch {
    return false;
  }
}
```

### Model check

```typescript
async function hasModel(model: string): Promise<boolean> {
  const response = await fetch('http://localhost:11434/api/tags');
  const data = await response.json();
  return data.models.some((m: any) => m.name.startsWith(model));
}
```

## Recommended Model

**Primary:** `nomic-embed-text`

| Property | Value |
|----------|-------|
| Dimensions | 768 |
| Context length | 8,192 tokens |
| Size on disk | ~274MB |
| MTEB retrieval score | 53.01 |
| Pulls on Ollama | 53.5M |

**Why:** Best balance of quality, speed, and size. Most popular embedding model on Ollama. Outperforms OpenAI ada-002. 8K context means most vault files fit without chunking.

**Alternatives the user could configure:**

| Model | Dimensions | Size | Use case |
|-------|-----------|------|----------|
| `all-minilm` | 384 | 46MB | Resource-constrained machines |
| `mxbai-embed-large` | 1,024 | 670MB | Maximum retrieval quality |
| `bge-m3` | 1,024 | 1.2GB | Multilingual vaults |

## Storage: Orama

Instead of individual JSON files per document (which caused multi-second load times), we use [Orama](https://github.com/oramasearch/orama) — a pure JavaScript embedded search engine with vector support. Under 2kb bundled, zero native dependencies, works in Electron.

```
.witness/
└── index.orama          # Single serialised Orama database
```

**Why Orama:**
- **Pure JS** — no native bindings, no WASM, guaranteed to work in Electron
- **Single file** — serialise/restore the entire database from one JSON blob
- **Fast** — microsecond-level queries, even with thousands of documents
- **Hybrid search** — vector + full-text in one query (bonus for vault search)
- **npm install** — `@orama/orama`, bundled with the plugin

**Schema:**
```typescript
import { create, insert, search, save, load } from '@orama/orama'

const db = await create({
  schema: {
    path: 'string',
    title: 'string',
    content: 'string',
    mtime: 'number',
    embedding: 'vector[768]'  // nomic-embed-text dimensions
  }
})
```

**Persistence:** Save on shutdown, load on startup:
```typescript
// Save
const snapshot = await save(db)
await this.app.vault.adapter.write('.witness/index.orama', JSON.stringify(snapshot))

// Load
const raw = await this.app.vault.adapter.read('.witness/index.orama')
const db = await load(JSON.parse(raw))
```

**Changing model requires full re-index** since vector dimensions differ between models.

## Implementation

### OllamaProvider

```typescript
interface EmbeddingProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
  getModelInfo(): { name: string; dimensions: number };
}

class OllamaProvider implements EmbeddingProvider {
  name = 'ollama';

  constructor(
    private baseUrl: string = 'http://localhost:11434',
    private model: string = 'nomic-embed-text'
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts })
    });

    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.embeddings;
  }

  getModelInfo() {
    // Dimension lookup for known models
    const dims: Record<string, number> = {
      'nomic-embed-text': 768,
      'all-minilm': 384,
      'mxbai-embed-large': 1024,
      'bge-m3': 1024,
    };
    return {
      name: this.model,
      dimensions: dims[this.model] || 768
    };
  }
}
```

### Indexing Service

```typescript
class EmbeddingIndexer {
  private provider: OllamaProvider;
  private batchSize = 20; // Documents per batch request

  async indexVault(files: TFile[], onProgress?: (done: number, total: number) => void) {
    const total = files.length;
    let done = 0;

    for (let i = 0; i < files.length; i += this.batchSize) {
      const batch = files.slice(i, i + this.batchSize);
      const texts = await Promise.all(
        batch.map(f => this.app.vault.cachedRead(f))
      );

      const embeddings = await this.provider.embed(texts);

      for (let j = 0; j < batch.length; j++) {
        await this.saveEmbedding(batch[j].path, embeddings[j], batch[j].stat.mtime);
      }

      done += batch.length;
      onProgress?.(done, total);
    }
  }

  async indexSingleFile(file: TFile) {
    const content = await this.app.vault.cachedRead(file);
    const [embedding] = await this.provider.embed([content]);
    await this.saveEmbedding(file.path, embedding, file.stat.mtime);
  }
}
```

### Incremental Updates

Same approach as the [semantic search spec](semantic-search.md): listen to vault events, debounce, re-embed only changed files.

```typescript
// On file modify: debounce 3s then re-embed
this.registerEvent(this.app.vault.on('modify', (file) => {
  if (file instanceof TFile && file.extension === 'md') {
    this.queueForReembedding(file);
  }
}));

// On file delete: remove embedding
this.registerEvent(this.app.vault.on('delete', (file) => {
  if (file instanceof TFile) {
    this.removeEmbedding(file.path);
  }
}));

// On file create: queue for embedding
this.registerEvent(this.app.vault.on('create', (file) => {
  if (file instanceof TFile && file.extension === 'md') {
    this.queueForReembedding(file);
  }
}));
```

## Settings UI

```
┌─────────────────────────────────────────────────────────────┐
│ Semantic Search                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ ☑ Enable Semantic Search                                     │
│                                                              │
│ Ollama URL: [http://localhost:11434          ]                │
│                                                              │
│ Embedding Model: [nomic-embed-text ▾]                        │
│                   ├─ nomic-embed-text (recommended)           │
│                   ├─ all-minilm (lightweight)                 │
│                   ├─ mxbai-embed-large (highest quality)      │
│                   └─ Custom...                                │
│                                                              │
│ Status:                                                      │
│ ● Ollama connected — nomic-embed-text ready                  │
│   1,234 documents indexed (last updated: 2 min ago)          │
│                                                              │
│ [Reindex All]  [Clear Index]                                 │
│                                                              │
│ Exclude paths: [.obsidian, templates, _archive       ]       │
│                                                              │
│ ─────────────────────────────────────────────────────────── │
│                                                              │
│ ⚠ Ollama not detected                                        │
│   Install Ollama from https://ollama.com and run:            │
│   ollama pull nomic-embed-text                               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Error Handling

### Ollama not running

- Show clear status in settings: "Ollama not detected at localhost:11434"
- `semantic_search` MCP tool returns a helpful error: "Semantic search requires Ollama. Install from https://ollama.com and run: ollama pull nomic-embed-text"
- Periodically retry connection (every 60s) and auto-enable when detected

### Model not pulled

- Detect via `/api/tags` that the configured model isn't available
- Show in settings: "Model nomic-embed-text not found. Run: ollama pull nomic-embed-text"
- Consider auto-pulling (Ollama auto-downloads models on first use of `/api/embed`)

### Ollama goes away mid-session

- Catch fetch errors gracefully
- Keep existing index functional for searching (query embedding will fail but cached results remain)
- Retry connection on next search attempt
- Log warning, don't crash

## Migration Path

### From current Smart Connections approach

1. Ship Ollama integration alongside SC reader initially
2. Settings toggle: "Embedding Provider: Smart Connections | Ollama"
3. Default new installs to Ollama
4. Mark Smart Connections as deprecated in settings
5. Remove Smart Connections reader in a future version

### Re-indexing

When switching from SC to Ollama, the entire index must be rebuilt because:
- Different model (bge-micro-v2 384d → nomic-embed-text 768d)
- Different storage format (.ajson → .witness/embeddings/)
- Different vector dimensions (incompatible for cosine similarity)

Show a one-time prompt: "Switching to Ollama requires re-indexing your vault. This will take a few minutes. Continue?"

## Performance Expectations

| Operation | Expected (nomic-embed-text, M2 Max) |
|-----------|-------------------------------------|
| Full vault index (4,000 docs) | ~3-4 minutes |
| Single file re-embed | <100ms |
| Query embedding | <50ms |
| Cosine similarity search (4,000 docs) | <100ms |
| Ollama model load (cold start) | 2-3 seconds |

Compare to current approach:
- Cached SC search: ~265ms (similar, slightly faster since we skip SC parsing)
- Query embedding (iframe WASM): variable, often >500ms first call

## Future: Ollama for RAG/Chat

With Ollama serving embeddings, adding local RAG is natural:

1. User asks a question via MCP
2. `semantic_search` finds relevant documents
3. Feed context + question to Ollama chat model (`llama3.2`, `qwen2.5`, etc.)
4. Return answer with citations

This is out of scope for this feature but the architecture enables it cleanly.

## Implementation Phases

### Phase 1: OllamaProvider + Own Index
- Implement `OllamaProvider` class
- Build `.witness/embeddings/` storage layer
- Background full-vault indexing with progress
- Incremental updates on file events
- Wire into existing `semantic_search` MCP tool
- Settings UI for Ollama URL and model selection

### Phase 2: Drop Smart Connections
- Remove `src/smart-connections-reader.ts`
- Remove `src/embedding-service-iframe.ts`
- Remove iframe creation code from main.ts
- Update settings to remove SC-related options
- Update integration tests

### Phase 3: Polish
- Ollama availability detection and helpful error messages
- Auto-retry connection
- Model auto-pull on first use
- Configurable Ollama URL (for remote Ollama instances)
- Batch size tuning for different hardware

## Risks & Mitigations

### Risk: Users don't have Ollama installed
**Mitigation:** Clear setup instructions in settings UI and error messages. Ollama is a one-line install (`brew install ollama` or download from ollama.com). Consider linking to setup guide in README.

### Risk: Ollama is desktop-only (no mobile)
**Mitigation:** Plugin is already `isDesktopOnly: true`. Mobile devices access the vault through the tunnel as MCP clients — they don't need local embeddings.

### Risk: Initial indexing is slow on large vaults
**Mitigation:** Batch API reduces round-trips. Background indexing with progress bar. Index persists across restarts. Only re-embed changed files.

### Risk: Ollama uses significant memory
**Mitigation:** `nomic-embed-text` is only 274MB. Can recommend `all-minilm` (46MB) for 8GB machines. Ollama auto-unloads models after `keep_alive` timeout.

---

*This spec supersedes the Smart Connections integration approach in [semantic-search.md](semantic-search.md). The storage format, search algorithm, MCP tool interface, and Obsidian UI from that spec remain valid — only the embedding provider changes.*
