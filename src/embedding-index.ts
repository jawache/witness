/**
 * EmbeddingIndex - Storage and retrieval of document embeddings
 *
 * Stores embeddings in .witness/embeddings/ folder with:
 * - index.json: metadata about the index
 * - vectors/: per-file embedding files
 */

import { App, TFile, normalizePath } from 'obsidian';

// Storage paths
const WITNESS_DIR = '.witness';
const EMBEDDINGS_DIR = `${WITNESS_DIR}/embeddings`;
const INDEX_FILE = `${EMBEDDINGS_DIR}/index.json`;
const VECTORS_DIR = `${EMBEDDINGS_DIR}/vectors`;

/**
 * Metadata about a section within a document
 */
export interface SectionEmbedding {
  heading: string;
  line: number;
  embedding: number[];
  tokens: number;
}

/**
 * Full embedding data for a document
 */
export interface DocumentEmbedding {
  path: string;
  mtime: number;
  hash: string;
  metadata: {
    title: string;
    tags: string[];
    type: string;
    wordCount: number;
  };
  document: {
    embedding: number[];
    tokens: number;
  };
  sections: SectionEmbedding[];
}

/**
 * Index metadata stored in index.json
 */
export interface IndexMetadata {
  version: number;
  provider: string;
  model: string;
  dimensions: number;
  documentCount: number;
  lastUpdated: string;
  excludePaths: string[];
}

/**
 * Search result with similarity score
 */
export interface SearchResult {
  path: string;
  title: string;
  score: number;
  type: 'document' | 'section';
  section?: {
    heading: string;
    line: number;
  };
  tags: string[];
}

/**
 * Manages embedding storage and retrieval
 */
export class EmbeddingIndex {
  private app: App;
  private metadata: IndexMetadata | null = null;
  private cache: Map<string, DocumentEmbedding> = new Map();

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Initialize the index, creating directories if needed
   */
  async initialize(): Promise<IndexMetadata> {
    const adapter = this.app.vault.adapter;

    // Create directories if they don't exist
    if (!await adapter.exists(WITNESS_DIR)) {
      await adapter.mkdir(WITNESS_DIR);
    }
    if (!await adapter.exists(EMBEDDINGS_DIR)) {
      await adapter.mkdir(EMBEDDINGS_DIR);
    }
    if (!await adapter.exists(VECTORS_DIR)) {
      await adapter.mkdir(VECTORS_DIR);
    }

    // Load or create index metadata
    if (await adapter.exists(INDEX_FILE)) {
      const content = await adapter.read(INDEX_FILE);
      this.metadata = JSON.parse(content);
    } else {
      this.metadata = {
        version: 1,
        provider: 'iframe',
        model: 'TaylorAI/bge-micro-v2',
        dimensions: 384,
        documentCount: 0,
        lastUpdated: new Date().toISOString(),
        excludePaths: ['.witness/', '.obsidian/', 'node_modules/'],
      };
      await this.saveMetadata();
    }

    return this.metadata!;
  }

  /**
   * Save index metadata
   */
  private async saveMetadata(): Promise<void> {
    if (!this.metadata) return;
    this.metadata.lastUpdated = new Date().toISOString();
    await this.app.vault.adapter.write(
      INDEX_FILE,
      JSON.stringify(this.metadata, null, 2)
    );
  }

  /**
   * Hash a string for filename generation
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Get the vector file path for a document
   */
  private getVectorPath(docPath: string): string {
    // Convert path to safe filename: replace / with _ and add .json
    let safeName = docPath.replace(/\//g, '_').replace(/\.md$/, '');

    // Max filename length on most filesystems is 255 bytes
    // Leave room for .json extension (5 chars) and some buffer
    const MAX_FILENAME_LENGTH = 200;

    if (safeName.length > MAX_FILENAME_LENGTH) {
      // Hash the full path for uniqueness, keep a readable prefix
      const hash = this.hashString(docPath);
      const prefix = safeName.slice(0, 150);  // Keep first 150 chars for readability
      safeName = `${prefix}_${hash}`;
    }

    return normalizePath(`${VECTORS_DIR}/${safeName}.json`);
  }

  /**
   * Check if a document needs reindexing
   */
  async needsReindex(file: TFile): Promise<boolean> {
    const vectorPath = this.getVectorPath(file.path);
    const adapter = this.app.vault.adapter;

    if (!await adapter.exists(vectorPath)) {
      return true;
    }

    // Check if file was modified since last index
    const cached = await this.getDocumentEmbedding(file.path);
    if (!cached) return true;

    return file.stat.mtime > cached.mtime;
  }

  /**
   * Save embedding for a document
   */
  async saveDocumentEmbedding(embedding: DocumentEmbedding): Promise<void> {
    const vectorPath = this.getVectorPath(embedding.path);
    await this.app.vault.adapter.write(
      vectorPath,
      JSON.stringify(embedding, null, 2)
    );

    // Update cache
    this.cache.set(embedding.path, embedding);

    // Update metadata count
    if (this.metadata) {
      // Count total documents
      const files = await this.app.vault.adapter.list(VECTORS_DIR);
      this.metadata.documentCount = files.files.length;
      await this.saveMetadata();
    }
  }

  /**
   * Get embedding for a document
   */
  async getDocumentEmbedding(path: string): Promise<DocumentEmbedding | null> {
    // Check cache first
    if (this.cache.has(path)) {
      return this.cache.get(path)!;
    }

    const vectorPath = this.getVectorPath(path);
    const adapter = this.app.vault.adapter;

    if (!await adapter.exists(vectorPath)) {
      return null;
    }

    try {
      const content = await adapter.read(vectorPath);
      const embedding = JSON.parse(content) as DocumentEmbedding;
      this.cache.set(path, embedding);
      return embedding;
    } catch {
      return null;
    }
  }

  /**
   * Delete embedding for a document
   */
  async deleteDocumentEmbedding(path: string): Promise<void> {
    const vectorPath = this.getVectorPath(path);
    const adapter = this.app.vault.adapter;

    if (await adapter.exists(vectorPath)) {
      await adapter.remove(vectorPath);
    }

    this.cache.delete(path);

    // Update metadata count
    if (this.metadata) {
      const files = await adapter.list(VECTORS_DIR);
      this.metadata.documentCount = files.files.length;
      await this.saveMetadata();
    }
  }

  /**
   * Get all indexed vector files
   */
  async getVectorFiles(): Promise<string[]> {
    const adapter = this.app.vault.adapter;

    if (!await adapter.exists(VECTORS_DIR)) {
      return [];
    }

    const files = await adapter.list(VECTORS_DIR);
    return files.files.filter(f => f.endsWith('.json'));
  }

  /**
   * Load all embeddings into cache for searching
   * Reads directly from vector files to handle hashed filenames
   */
  async loadAllEmbeddings(): Promise<DocumentEmbedding[]> {
    const vectorFiles = await this.getVectorFiles();
    const embeddings: DocumentEmbedding[] = [];
    const adapter = this.app.vault.adapter;

    for (const vectorFile of vectorFiles) {
      try {
        const content = await adapter.read(vectorFile);
        const embedding = JSON.parse(content) as DocumentEmbedding;

        // Cache it using the path stored in the embedding
        this.cache.set(embedding.path, embedding);
        embeddings.push(embedding);
      } catch {
        // Skip invalid files
      }
    }

    return embeddings;
  }

  /**
   * Get all indexed document paths
   * Note: For hashed filenames, we must read from stored embeddings
   */
  async getIndexedPaths(): Promise<string[]> {
    const embeddings = await this.loadAllEmbeddings();
    return embeddings.map(e => e.path);
  }

  /**
   * Compute cosine similarity between two vectors
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Search for similar documents
   */
  async search(
    queryEmbedding: number[],
    options: {
      limit?: number;
      minScore?: number;
      tags?: string[];
      paths?: string[];
    } = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, minScore = 0.3, tags, paths } = options;
    const allEmbeddings = await this.loadAllEmbeddings();
    const results: SearchResult[] = [];

    for (const doc of allEmbeddings) {
      // Filter by paths if specified
      if (paths && paths.length > 0) {
        if (!paths.some(p => doc.path.startsWith(p))) {
          continue;
        }
      }

      // Filter by tags if specified
      if (tags && tags.length > 0) {
        if (!tags.some(t => doc.metadata.tags.includes(t))) {
          continue;
        }
      }

      // Score document embedding
      const docScore = this.cosineSimilarity(queryEmbedding, doc.document.embedding);
      if (docScore >= minScore) {
        results.push({
          path: doc.path,
          title: doc.metadata.title,
          score: docScore,
          type: 'document',
          tags: doc.metadata.tags,
        });
      }

      // Score section embeddings
      for (const section of doc.sections) {
        const sectionScore = this.cosineSimilarity(queryEmbedding, section.embedding);
        if (sectionScore >= minScore) {
          results.push({
            path: doc.path,
            title: doc.metadata.title,
            score: sectionScore,
            type: 'section',
            section: {
              heading: section.heading,
              line: section.line,
            },
            tags: doc.metadata.tags,
          });
        }
      }
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Get index statistics
   */
  getStats(): { documentCount: number; model: string; lastUpdated: string } | null {
    if (!this.metadata) return null;
    return {
      documentCount: this.metadata.documentCount,
      model: this.metadata.model,
      lastUpdated: this.metadata.lastUpdated,
    };
  }

  /**
   * Check if a path should be excluded from indexing
   */
  shouldExclude(path: string): boolean {
    if (!this.metadata) return false;
    return this.metadata.excludePaths.some(exclude => path.startsWith(exclude));
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
