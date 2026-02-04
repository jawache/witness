/**
 * DocumentIndexer - Processes markdown files and generates embeddings
 *
 * Implements hierarchical chunking:
 * - Document embedding: title + front matter + first ~500 tokens
 * - Section embeddings: split on H2 headers
 */

import { App, TFile, CachedMetadata } from 'obsidian';
import { EmbeddingIndex, DocumentEmbedding, SectionEmbedding } from './embedding-index';
import { EmbeddingServiceIframe } from './embedding-service-iframe';

/**
 * Progress callback for indexing operations
 */
export interface IndexingProgress {
  phase: 'scanning' | 'indexing' | 'complete';
  current: number;
  total: number;
  currentFile?: string;
  error?: string;
}

/**
 * Parsed section from a markdown document
 */
interface ParsedSection {
  heading: string;
  line: number;
  content: string;
}

/**
 * Processes documents and manages the embedding index
 */
export class DocumentIndexer {
  private app: App;
  private index: EmbeddingIndex;
  private embeddingService: EmbeddingServiceIframe;
  private progressCallback: ((progress: IndexingProgress) => void) | null = null;
  private isIndexing = false;
  private shouldCancel = false;

  constructor(
    app: App,
    index: EmbeddingIndex,
    embeddingService: EmbeddingServiceIframe
  ) {
    this.app = app;
    this.index = index;
    this.embeddingService = embeddingService;
  }

  /**
   * Set progress callback
   */
  onProgress(callback: (progress: IndexingProgress) => void): void {
    this.progressCallback = callback;
  }

  private reportProgress(progress: IndexingProgress): void {
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
    console.log(`[Indexer] ${progress.phase}: ${progress.current}/${progress.total} ${progress.currentFile || ''}`);
  }

  /**
   * Get all markdown files that should be indexed
   */
  private getFilesToIndex(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter(file => {
      return !this.index.shouldExclude(file.path);
    });
  }

  /**
   * Extract front matter from file content
   */
  private extractFrontMatter(content: string): { tags: string[]; title?: string } {
    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontMatterMatch) {
      return { tags: [] };
    }

    const frontMatter = frontMatterMatch[1];
    const tags: string[] = [];
    let title: string | undefined;

    // Extract tags
    const tagsMatch = frontMatter.match(/tags:\s*\[(.*?)\]/);
    if (tagsMatch) {
      tags.push(...tagsMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')));
    }
    const tagsListMatch = frontMatter.match(/tags:\n((?:\s+-\s+.+\n?)+)/);
    if (tagsListMatch) {
      const tagLines = tagsListMatch[1].match(/-\s+(.+)/g);
      if (tagLines) {
        tags.push(...tagLines.map(t => t.replace(/^-\s+/, '').trim()));
      }
    }

    // Extract title
    const titleMatch = frontMatter.match(/title:\s*["']?(.+?)["']?\s*$/m);
    if (titleMatch) {
      title = titleMatch[1];
    }

    return { tags, title };
  }

  /**
   * Extract title from content (uses H1 or filename)
   */
  private extractTitle(file: TFile, content: string): string {
    const frontMatter = this.extractFrontMatter(content);
    if (frontMatter.title) return frontMatter.title;

    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1];

    return file.basename;
  }

  /**
   * Parse sections from markdown content
   */
  private parseSections(content: string): ParsedSection[] {
    const sections: ParsedSection[] = [];
    const lines = content.split('\n');

    let currentSection: ParsedSection | null = null;
    let currentContent: string[] = [];
    let inFrontMatter = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Handle front matter
      if (line === '---' && i === 0) {
        inFrontMatter = true;
        continue;
      }
      if (inFrontMatter) {
        if (line === '---') {
          inFrontMatter = false;
        }
        continue;
      }

      // Check for H2 header
      const h2Match = line.match(/^##\s+(.+)$/);
      if (h2Match) {
        // Save previous section
        if (currentSection) {
          currentSection.content = currentContent.join('\n').trim();
          if (currentSection.content.length > 0) {
            sections.push(currentSection);
          }
        }

        // Start new section
        currentSection = {
          heading: h2Match[1],
          line: lineNum,
          content: '',
        };
        currentContent = [];
      } else if (currentSection) {
        currentContent.push(line);
      }
    }

    // Save last section
    if (currentSection) {
      currentSection.content = currentContent.join('\n').trim();
      if (currentSection.content.length > 0) {
        sections.push(currentSection);
      }
    }

    return sections;
  }

  /**
   * Create document embedding text (title + front matter + intro)
   */
  private createDocumentText(file: TFile, content: string): string {
    const title = this.extractTitle(file, content);
    const frontMatter = this.extractFrontMatter(content);

    // Remove front matter from content
    const bodyContent = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

    // Get first ~1500 characters (roughly 500 tokens)
    const intro = bodyContent.slice(0, 1500);

    // Combine
    let docText = title;
    if (frontMatter.tags.length > 0) {
      docText += '\nTags: ' + frontMatter.tags.join(', ');
    }
    docText += '\n\n' + intro;

    return docText;
  }

  /**
   * Create section embedding text
   */
  private createSectionText(file: TFile, section: ParsedSection): string {
    const title = this.extractTitle(file, '');
    // Include document title for context
    return `${title}\n\n## ${section.heading}\n\n${section.content.slice(0, 1500)}`;
  }

  /**
   * Simple hash of content for change detection
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Index a single file
   */
  async indexFile(file: TFile): Promise<DocumentEmbedding | null> {
    try {
      const content = await this.app.vault.read(file);
      const title = this.extractTitle(file, content);
      const frontMatter = this.extractFrontMatter(content);
      const sections = this.parseSections(content);

      // Create document embedding
      const docText = this.createDocumentText(file, content);
      const docEmbedding = await this.embeddingService.embed(docText);

      // Create section embeddings
      const sectionEmbeddings: SectionEmbedding[] = [];
      for (const section of sections) {
        const sectionText = this.createSectionText(file, section);
        const embedding = await this.embeddingService.embed(sectionText);
        sectionEmbeddings.push({
          heading: section.heading,
          line: section.line,
          embedding,
          tokens: Math.ceil(sectionText.length / 4), // Rough estimate
        });
      }

      // Determine document type from path
      let docType = 'note';
      if (file.path.includes('chaos/')) docType = 'chaos';
      else if (file.path.includes('order/knowledge/')) docType = 'knowledge';
      else if (file.path.includes('order/projects/')) docType = 'project';
      else if (file.path.includes('order/heartbeat/')) docType = 'heartbeat';

      const embedding: DocumentEmbedding = {
        path: file.path,
        mtime: file.stat.mtime,
        hash: this.hashContent(content),
        metadata: {
          title,
          tags: frontMatter.tags,
          type: docType,
          wordCount: content.split(/\s+/).length,
        },
        document: {
          embedding: docEmbedding,
          tokens: Math.ceil(docText.length / 4),
        },
        sections: sectionEmbeddings,
      };

      await this.index.saveDocumentEmbedding(embedding);
      return embedding;
    } catch (error) {
      console.error(`[Indexer] Failed to index ${file.path}:`, error);
      return null;
    }
  }

  /**
   * Index all documents that need updating
   */
  async indexAll(force = false): Promise<{ indexed: number; skipped: number; errors: number }> {
    if (this.isIndexing) {
      throw new Error('Indexing already in progress');
    }

    this.isIndexing = true;
    this.shouldCancel = false;

    const files = this.getFilesToIndex();
    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    this.reportProgress({
      phase: 'scanning',
      current: 0,
      total: files.length,
    });

    // Ensure embedding service is initialized
    await this.embeddingService.initialize();

    for (let i = 0; i < files.length; i++) {
      if (this.shouldCancel) {
        break;
      }

      const file = files[i];

      this.reportProgress({
        phase: 'indexing',
        current: i + 1,
        total: files.length,
        currentFile: file.path,
      });

      // Check if reindex needed
      if (!force && !await this.index.needsReindex(file)) {
        skipped++;
        continue;
      }

      const result = await this.indexFile(file);
      if (result) {
        indexed++;
      } else {
        errors++;
      }
    }

    this.reportProgress({
      phase: 'complete',
      current: files.length,
      total: files.length,
    });

    this.isIndexing = false;
    return { indexed, skipped, errors };
  }

  /**
   * Cancel ongoing indexing
   */
  cancel(): void {
    this.shouldCancel = true;
  }

  /**
   * Check if indexing is in progress
   */
  isRunning(): boolean {
    return this.isIndexing;
  }

  /**
   * Handle file changes for incremental updates
   */
  async onFileChange(file: TFile): Promise<void> {
    if (this.index.shouldExclude(file.path)) return;
    if (file.extension !== 'md') return;

    console.log(`[Indexer] File changed: ${file.path}`);
    await this.indexFile(file);
  }

  /**
   * Handle file deletion
   */
  async onFileDelete(path: string): Promise<void> {
    console.log(`[Indexer] File deleted: ${path}`);
    await this.index.deleteDocumentEmbedding(path);
  }

  /**
   * Handle file rename
   */
  async onFileRename(file: TFile, oldPath: string): Promise<void> {
    console.log(`[Indexer] File renamed: ${oldPath} -> ${file.path}`);
    await this.index.deleteDocumentEmbedding(oldPath);
    if (file.extension === 'md' && !this.index.shouldExclude(file.path)) {
      await this.indexFile(file);
    }
  }
}
