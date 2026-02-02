# Feature Spec: Semantic Search & Embeddings

**Status:** Planned
**Phase:** 3 (Intelligence)
**Created:** 2026-02-02
**Last Updated:** 2026-02-02

## Overview

Add semantic search capability to Witness that finds documents by meaning rather than exact keyword matches. Users can search their vault using natural language queries and find conceptually related notes.

## Problem Statement

The current `search` tool performs keyword-based text search. This misses:
- Documents that discuss a concept using different terminology
- Related notes that don't share exact keywords
- Semantic relationships between ideas

For example, searching "productivity systems" wouldn't find a note about "GTD methodology" even though they're semantically related.

## Solution: Web Worker-Based Embeddings

### Architecture

Run transformers.js inside Obsidian using a **Web Worker** to generate embeddings locally.

```
┌─────────────────────────────────────────────────────────────┐
│  Obsidian (Electron)                                        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Main Thread (Witness Plugin)                          │  │
│  │ - MCP Server                                          │  │
│  │ - File operations                                     │  │
│  │ - Embedding storage                                   │  │
│  │ - Search orchestration                                │  │
│  └───────────────────────────────────────────────────────┘  │
│              ↕ postMessage / onmessage                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Web Worker Thread                                     │  │
│  │ - transformers.js                                     │  │
│  │ - ONNX WASM runtime                                   │  │
│  │ - Embedding generation                                │  │
│  │ - Model: TaylorAI/bge-micro-v2 (384 dimensions)       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Why Web Worker?

Our previous attempt ran transformers.js in the main Obsidian thread, which failed because ONNX WASM doesn't initialize properly in Electron's main context. Web Workers provide a better environment because they have:
- Separate execution context
- Better WASM support
- Less sandboxing interference

### Model Selection

**Decision:** Configurable with sensible default

**Default Model:** `TaylorAI/bge-micro-v2`
- **Dimensions:** 384
- **Token context:** 512 tokens
- **Size:** ~25MB
- **Speed:** ~25,000 tokens/sec
- **Why default:** Fastest startup, good balance of speed and quality

**Available Models:**

| Model | Dims | Context | Size | Quality | Best For |
|-------|------|---------|------|---------|----------|
| `TaylorAI/bge-micro-v2` | 384 | 512 | 25MB | ~58-60 | Fast startup, small vaults |
| `BAAI/bge-small-en-v1.5` | 384 | 512 | 50MB | 62.3 | Better quality, same storage |
| `nomic-ai/nomic-embed-text-v1.5` | 384 | 2,048 | 45MB | ~61-62 | Long documents without chunking |

**Settings UI:**
```
Embedding Model: [Dropdown]
- bge-micro-v2 (Fastest, recommended)
- bge-small-en-v1.5 (Better quality)
- nomic-embed-text-v1.5 (Longer context)
```

**Implementation note:** Changing models requires full reindex since dimensions/quality differ

## Feature Decisions

### Storage Format

**Decision:** Own format in `.witness/` folder

```
.witness/
├── embeddings/
│   ├── index.json          # Metadata index
│   └── vectors/
│       ├── note1.json      # Per-file embeddings
│       ├── note2.json
│       └── ...
└── config.json             # Feature settings
```

**Embedding file structure (Hierarchical):**
```json
{
  "path": "order/knowledge/productivity.md",
  "mtime": 1706889600000,
  "hash": "abc123",
  "metadata": {
    "title": "Productivity Systems",
    "tags": ["productivity", "systems"],
    "type": "knowledge",
    "wordCount": 1250
  },
  "document": {
    "embedding": [0.123, -0.456, ...],  // 384 floats - full doc
    "tokens": 1850
  },
  "sections": [
    {
      "heading": "## Getting Things Done",
      "line": 15,
      "embedding": [0.234, -0.567, ...],
      "tokens": 420
    },
    {
      "heading": "## Time Blocking",
      "line": 45,
      "embedding": [0.345, -0.678, ...],
      "tokens": 380
    }
  ]
}
```

**Why hierarchical:**
- Document embedding: Find relevant files
- Section embeddings: Pinpoint exact location
- Search results can link to specific sections
- Best recall for both broad and specific queries

**Why own format:**
- Clean separation from other plugins
- Can optimize for our needs
- No external dependencies
- Can evolve independently

### Chunking Strategy

**Decision:** Hierarchical (Document + Sections)

**How it works:**
```
Document: "# Productivity\n\nIntro...\n\n## GTD\n\nContent...\n\n## Time Blocking\n\nMore..."
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ Document Embedding                                          │
│ - Embed: front matter + title + first ~500 tokens          │
│ - Captures overall document theme                           │
│ - Used for: "find documents about X"                        │
└─────────────────────────────────────────────────────────────┘
                    +
┌─────────────────────────────────────────────────────────────┐
│ Section Embeddings                                          │
│ - Split on H2 headers (## )                                 │
│ - Each section: heading + content up to next H2            │
│ - Include parent H1 context in each chunk                   │
│ - Used for: "find the part that discusses Y"                │
└─────────────────────────────────────────────────────────────┘
```

**Section detection rules:**
1. Split on `## ` (H2 headers) as primary boundaries
2. H3+ headers stay within their parent H2 section
3. Content before first H2 becomes "intro" section
4. Each section includes: `# Title` + `## Section Header` + content
5. Max section size: model context (512/2048 tokens)
6. If section exceeds limit: split at paragraph boundaries

**Search behavior:**
- Query matches document embedding → return file path
- Query matches section embedding → return file path + line number + heading
- Results ranked by best match (doc or section)

**Storage impact:**
- Average note with 5 sections: 6 embeddings (1 doc + 5 sections)
- 1000 notes × 6 embeddings × 1.5KB = ~9MB storage
- Acceptable for local storage

### Embedding Timing

**Decision:** Hybrid approach (background + incremental)

**Workflow:**
1. Plugin loads → Check if embeddings exist
2. If not → Background index all markdown files (show progress in status bar)
3. If yes → Load cached embeddings
4. On file modify → Debounce (3 seconds) → Re-embed single file
5. On file delete → Remove embedding
6. On file create → Queue for embedding

**User experience:**
- Non-blocking: User can keep working during initial indexing
- Progress indicator in status bar: "Indexing: 45/120 files..."
- Notifications for completion: "Semantic search ready"

### Front Matter Handling

**Decision:** Both (included in embedding + extracted as metadata)

**Embedding content:**
```markdown
---
title: My Note
tags: [productivity, gtd]
type: knowledge
---

# My Note

Content here...
```

The full document including YAML front matter is embedded, so semantic meaning of metadata is captured.

**Extracted metadata:**
Front matter fields are also parsed and stored separately for filtering:
```json
{
  "metadata": {
    "title": "My Note",
    "tags": ["productivity", "gtd"],
    "type": "knowledge"
  }
}
```

This allows queries like "find notes about productivity where type=knowledge".

## MCP Tool Interface

### `semantic_search` Tool

**Parameters:**
```typescript
{
  query: string;         // Natural language search query
  limit?: number;        // Max results (default: 10)
  filters?: {
    // Front matter filters
    tags?: string[];     // Must have ALL these tags
    type?: string;       // Front matter type field
    [key: string]: any;  // Any other front matter field

    // Path filters
    includePaths?: string[];  // Only search in these folders
    excludePaths?: string[];  // Skip these folders
  };
  threshold?: number;    // Minimum similarity (0-1, default: 0.5)
  includeContent?: boolean;  // Include full section content in results (for RAG)
}
```

**Returns:**
```typescript
{
  results: Array<{
    path: string;
    title: string;
    similarity: number;    // 0-1, higher = more similar
    matchType: 'document' | 'section';
    section?: {
      heading: string;     // "## Section Title"
      line: number;        // Line number in file
    };
    excerpt: string;       // First ~200 chars of matched content
    content?: string;      // Full section content (if includeContent=true)
    metadata: object;      // Front matter fields
  }>;
  indexedCount: number;    // Total documents in index
  searchTime: number;      // Query time in ms
}
```

**Example usage:**
```
User: "Find notes about productivity systems"

semantic_search({
  query: "productivity systems",
  limit: 5,
  filters: { type: "knowledge" }
})

Returns:
1. order/knowledge/gtd.md (89.2%)
2. order/knowledge/time-blocking.md (84.1%)
3. chaos/inbox/productivity-article.md (78.5%)
```

## Obsidian UI (Leaf View)

### Overview

A dedicated sidebar panel for semantic search within Obsidian. Secondary to the MCP tool (primary use case is RAG), but provides a native search experience for users.

### UI Design

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Semantic Search                                    [⚙️]  │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ productivity systems                                    │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ Filters:                                                    │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Tags: [productivity] [×]  [+ Add tag]                   │ │
│ │ Type: [knowledge ▾]                                     │ │
│ │ Folder: [order/knowledge ▾]                             │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ─────────────────────────────────────────────────────────── │
│                                                             │
│ 5 results (23ms)                                            │
│                                                             │
│ ▶ 📄 Getting Things Done (89.2%)                           │
│   order/knowledge/gtd.md                                    │
│                                                             │
│ ▼ 📄 Time Blocking Techniques (84.1%)                      │
│   order/knowledge/time-blocking.md                          │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Time blocking is a productivity method where you     │   │
│   │ divide your day into blocks of time, each dedicated  │   │
│   │ to accomplishing a specific task or group of tasks.  │   │
│   │ Unlike a to-do list, time blocking tells you...      │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│ ▶ 📄 Weekly Review Process (78.5%)                         │
│   order/heartbeat/weekly-review.md                          │
│                                                             │
│ ▶ 📄 Productivity Article (72.3%)                          │
│   chaos/inbox/productivity-article.md                       │
│   └─ § "The Eisenhower Matrix" (line 45)                   │
│                                                             │
│ ▶ 📄 Meeting Notes: Team Standup (68.1%)                   │
│   order/knowledge/meetings/2024-01-15.md                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Interaction Patterns

**Collapsible Results:**
- Results shown collapsed by default with just title, path, similarity score
- Click chevron (▶/▼) to expand and show content snippet
- Snippet shows first ~200 characters of matched content
- Section matches show the section heading and line number

**Click Actions:**
- Click file name → Open file in editor
- Click section indicator → Open file and scroll to that line
- Shift+click → Open in new pane

**Filter Controls:**
- **Tags dropdown:** Multi-select from tags used in vault
- **Type dropdown:** Single-select from front matter `type` values
- **Folder dropdown:** Hierarchical folder picker with include/exclude
- Filters persist across searches
- Clear all filters button

### Implementation

**Leaf View Registration:**
```typescript
const VIEW_TYPE_SEMANTIC_SEARCH = 'witness-semantic-search';

class SemanticSearchView extends ItemView {
  getViewType(): string {
    return VIEW_TYPE_SEMANTIC_SEARCH;
  }

  getDisplayText(): string {
    return 'Semantic Search';
  }

  getIcon(): string {
    return 'search';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    // Build search UI
    this.buildSearchInterface(container);
  }
}

// Registration in plugin onload()
this.registerView(
  VIEW_TYPE_SEMANTIC_SEARCH,
  (leaf) => new SemanticSearchView(leaf)
);

// Add ribbon icon to open
this.addRibbonIcon('search', 'Semantic Search', () => {
  this.activateView();
});
```

**Search Result Component:**
```typescript
interface SearchResult {
  path: string;
  title: string;
  similarity: number;
  matchType: 'document' | 'section';
  section?: { heading: string; line: number };
  excerpt: string;
}

function renderResult(result: SearchResult, container: HTMLElement) {
  const item = container.createDiv({ cls: 'search-result-item' });

  // Collapse toggle
  const toggle = item.createSpan({ cls: 'collapse-toggle' });
  toggle.textContent = '▶';

  // Title and score
  const header = item.createDiv({ cls: 'result-header' });
  header.createSpan({ cls: 'result-title', text: result.title });
  header.createSpan({ cls: 'result-score', text: `${(result.similarity * 100).toFixed(1)}%` });

  // Path (and section if applicable)
  const meta = item.createDiv({ cls: 'result-meta' });
  meta.createSpan({ cls: 'result-path', text: result.path });
  if (result.matchType === 'section' && result.section) {
    meta.createSpan({
      cls: 'result-section',
      text: `§ "${result.section.heading}" (line ${result.section.line})`
    });
  }

  // Collapsible content snippet
  const content = item.createDiv({ cls: 'result-content collapsed' });
  content.createEl('blockquote', { text: result.excerpt });

  // Toggle behavior
  toggle.addEventListener('click', () => {
    content.classList.toggle('collapsed');
    toggle.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
  });

  // Click to open file
  header.addEventListener('click', () => {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file) {
      const leaf = this.app.workspace.getLeaf();
      leaf.openFile(file as TFile).then(() => {
        if (result.section?.line) {
          // Scroll to line
          const view = leaf.view as MarkdownView;
          view.editor?.setCursor({ line: result.section.line - 1, ch: 0 });
        }
      });
    }
  });
}
```

### CSS Styling

```css
.witness-semantic-search {
  padding: 10px;
}

.search-result-item {
  border-bottom: 1px solid var(--background-modifier-border);
  padding: 8px 0;
}

.collapse-toggle {
  cursor: pointer;
  user-select: none;
  margin-right: 8px;
  opacity: 0.6;
}

.collapse-toggle:hover {
  opacity: 1;
}

.result-header {
  display: flex;
  justify-content: space-between;
  cursor: pointer;
}

.result-header:hover .result-title {
  color: var(--text-accent);
}

.result-title {
  font-weight: 500;
}

.result-score {
  color: var(--text-muted);
  font-size: 0.85em;
}

.result-meta {
  font-size: 0.85em;
  color: var(--text-muted);
  margin-top: 2px;
}

.result-section {
  margin-left: 8px;
  font-style: italic;
}

.result-content {
  margin-top: 8px;
  padding: 8px;
  background: var(--background-secondary);
  border-radius: 4px;
  font-size: 0.9em;
}

.result-content.collapsed {
  display: none;
}

.result-content blockquote {
  margin: 0;
  border-left: 2px solid var(--text-accent);
  padding-left: 8px;
}
```

### Command Palette Integration

```typescript
this.addCommand({
  id: 'open-semantic-search',
  name: 'Open semantic search',
  callback: () => this.activateView()
});

this.addCommand({
  id: 'semantic-search-current-note',
  name: 'Find related notes (semantic)',
  editorCallback: async (editor, view) => {
    // Use current note content as query
    const content = editor.getValue();
    const title = view.file?.basename || '';
    await this.activateView();
    // Pre-fill search with note title
    this.searchView.setQuery(title);
    this.searchView.doSearch();
  }
});
```

## Technical Implementation

### Web Worker Setup

**embedding-worker.js:**
```javascript
import { pipeline } from '@xenova/transformers';

let embedder = null;

async function initEmbedder() {
  if (embedder) return embedder;
  embedder = await pipeline('feature-extraction', 'TaylorAI/bge-micro-v2', {
    progress_callback: (progress) => {
      self.postMessage({ type: 'progress', progress });
    }
  });
  return embedder;
}

self.onmessage = async (event) => {
  const { type, payload, id } = event.data;

  if (type === 'embed') {
    try {
      const model = await initEmbedder();
      const output = await model(payload.text, {
        pooling: 'mean',
        normalize: true
      });
      self.postMessage({
        type: 'result',
        id,
        embedding: Array.from(output.data)
      });
    } catch (error) {
      self.postMessage({ type: 'error', id, error: error.message });
    }
  }
};
```

**Main thread interface:**
```typescript
class EmbeddingService {
  private worker: Worker;
  private pending: Map<string, { resolve, reject }>;

  async embed(text: string): Promise<number[]> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'embed', id, payload: { text } });
    });
  }
}
```

### Search Algorithm

**Cosine similarity** for ranking:
```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Search workflow:**
1. Generate embedding for query text
2. Load all document embeddings from cache
3. Calculate cosine similarity for each
4. Apply filters (tags, type, path)
5. Sort by similarity
6. Return top N results

### Incremental Updates

**File change detection:**
```typescript
this.registerEvent(
  this.app.vault.on('modify', async (file) => {
    if (file.extension === 'md') {
      this.queueForReembedding(file.path);
    }
  })
);

this.registerEvent(
  this.app.vault.on('delete', async (file) => {
    if (file.extension === 'md') {
      await this.removeEmbedding(file.path);
    }
  })
);

this.registerEvent(
  this.app.vault.on('create', async (file) => {
    if (file.extension === 'md') {
      this.queueForReembedding(file.path);
    }
  })
);
```

**Debouncing:**
```typescript
private reembedQueue: Map<string, NodeJS.Timeout> = new Map();

queueForReembedding(path: string) {
  // Cancel existing timer for this file
  if (this.reembedQueue.has(path)) {
    clearTimeout(this.reembedQueue.get(path));
  }
  // Set new timer (3 second debounce)
  this.reembedQueue.set(path, setTimeout(() => {
    this.reembedQueue.delete(path);
    this.embedFile(path);
  }, 3000));
}
```

## Settings UI

```
┌─────────────────────────────────────────────────────────────┐
│ Semantic Search                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ☑ Enable Semantic Search                                    │
│                                                             │
│ Index Status:                                               │
│ ● Ready (1,234 documents indexed)                           │
│   Last updated: 2 minutes ago                               │
│                                                             │
│ [Reindex All]  [Clear Index]                                │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Indexing Options                                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Exclude paths:                                              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ .obsidian, templates, _archive                          │ │
│ └─────────────────────────────────────────────────────────┘ │
│ Comma-separated paths to skip                               │
│                                                             │
│ ☑ Index on file save                                        │
│ ☐ Show indexing progress in status bar                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase A: Web Worker Foundation
- Create embedding-worker.js with transformers.js
- Build Web Worker communication layer
- Test embedding generation works in Obsidian

### Phase B: Storage & Indexing
- Implement `.witness/` storage format
- Build initial indexing logic (background batch)
- Add incremental update handlers (file events)
- Progress reporting in status bar

### Phase C: Search & MCP Tool
- Implement cosine similarity search
- Add filtering by front matter metadata
- Create `semantic_search` MCP tool
- Test end-to-end with Claude

### Phase D: Settings & Polish
- Settings UI for enabling/configuring
- Exclude paths configuration
- Index status display
- Manual reindex/clear buttons

### Phase E: Obsidian UI

- Build SemanticSearchView leaf
- Implement collapsible result rendering
- Add filter controls (tags, type, folder)
- CSS styling matching Obsidian theme
- Command palette integration
- Keyboard navigation (up/down arrows, Enter to open)

## Performance Expectations

| Operation | Expected Time | Notes |
|-----------|--------------|-------|
| Initial indexing | 1-5 minutes | Depends on vault size, ~25K tokens/sec |
| Single file embed | <1 second | Most files are small |
| Query embedding | <500ms | Single text chunk |
| Search (brute force) | <100ms | Even for 10K documents |
| Model load (first use) | 3-5 seconds | Downloads and initializes model |

## Risks & Mitigations

### Risk: Web Worker approach fails like main thread
**Mitigation:** Test early in Phase A. If fails, fall back to external process approach (documented in research).

### Risk: Model download fails/slow
**Mitigation:**
- Cache model in user's `.cache/` directory
- Show clear progress during download
- Allow continuing with search disabled

### Risk: Large vault causes memory issues
**Mitigation:**
- Lazy load embeddings (only load when searching)
- Consider chunking for very large vaults (>10K files)
- Add exclude paths to skip unneeded files

### Risk: Embeddings get out of sync
**Mitigation:**
- Store file mtime/hash with embedding
- Verify freshness on load
- Provide manual "Reindex All" button

## Research References

### Models Evaluated
- TaylorAI/bge-micro-v2: 384 dims, fast, good quality (chosen)
- BGE-small-en-v1.5: 384 dims, slightly better quality
- Jina-v2-small-2k: 512 dims, longer context

### Previous Attempt (feature/semantic-search branch)
- Tried transformers.js in main thread
- Failed: ONNX WASM init in Electron
- Salvageable code: cosine similarity, caching logic

## Future Considerations

### Block-Level Embeddings
After document-level works, could add:
- Embed each heading section separately
- More granular search results
- Link to specific section, not just file

### Hybrid Search
Combine semantic + keyword:
- Run both searches in parallel
- Merge results with weighted scoring
- Best of both worlds

### Custom Models
Allow users to configure:
- Different embedding models
- API-based embeddings (OpenAI, Ollama)
- Model selection in settings

---

*This spec was developed through conversation exploring Web Worker approaches for running transformers.js in Obsidian's Electron environment.*
