/**
 * OramaSearchEngine — SearchEngine implementation backed by Orama.
 * Stores chunk embeddings and supports hybrid (QPS + vector),
 * vector-only, and fulltext-only search modes.
 * Documents are split into chunks by markdown headings for better retrieval.
 * Persists to .witness/index.orama as a single JSON file.
 *
 * Schema v5: sourcePath, title, headingPath, content, chunkIndex, mtime,
 * tags (enum[]), folder (enum), embedding (optional vector).
 * Uses QPS (Quantum Proximity Scoring) instead of BM25 for better phrase matching.
 */

import { create, insert, remove, search, searchVector, save, load, count, getByID } from '@orama/orama';
import { pluginQPS } from '@orama/plugin-qps';
import type { AnyOrama, RawData } from '@orama/orama';
import type { App, TFile } from 'obsidian';
import { OllamaProvider } from './ollama-provider';
import { chunkMarkdown } from './chunker';
import type { SearchEngine, SearchOptions, SearchResult, IndexFileOptions } from './search-engine';

const STORE_PATH = '.witness/index.orama';

// Bump this when the schema changes to force re-indexing on upgrade.
// v1 = vector-only, v2 = hybrid (content), v3 = chunked, v4 = skipped, v5 = QPS + tags + folder + optional embeddings
const SCHEMA_VERSION = 5;

interface ChunkDocument {
	sourcePath: string;
	title: string;
	headingPath: string;
	content: string;
	chunkIndex: number;
	mtime: number;
	tags: string[];
	folder: string;
	embedding: number[];
}

// Re-export SearchResult for backwards compatibility
export type { SearchResult } from './search-engine';

export class OramaSearchEngine implements SearchEngine {
	private db: AnyOrama | null = null;
	private app: App;
	private ollama: OllamaProvider;
	private dimensions: number;
	private indexedFiles = new Set<string>();

	constructor(app: App, ollama: OllamaProvider) {
		this.app = app;
		this.ollama = ollama;
		this.dimensions = ollama.getDimensions();
	}

	private getSchema() {
		return {
			sourcePath: 'string' as const,
			title: 'string' as const,
			headingPath: 'string' as const,
			content: 'string' as const,
			chunkIndex: 'number' as const,
			mtime: 'number' as const,
			tags: 'enum[]' as const,
			folder: 'enum' as const,
			embedding: `vector[${this.dimensions}]` as const,
		};
	}

	private createDb() {
		return create({
			schema: this.getSchema(),
			id: 'witness-vectors',
			plugins: [pluginQPS()],
		});
	}

	/**
	 * Initialise the database. Loads from disk if a saved index exists,
	 * otherwise creates a fresh empty database.
	 */
	async initialize(): Promise<void> {
		this.db = this.createDb();

		// Try to load existing index
		if (await this.app.vault.adapter.exists(STORE_PATH)) {
			try {
				const raw = await this.app.vault.adapter.read(STORE_PATH);
				const envelope = JSON.parse(raw);

				// Check schema version — discard old indexes to force re-index
				const version = envelope.schemaVersion ?? 1;
				if (version < SCHEMA_VERSION) {
					console.warn(`OramaSearchEngine: Schema v${version} → v${SCHEMA_VERSION}, discarding old index`);
					this.db = this.createDb();
					return;
				}

				const data = (envelope.data ?? envelope) as RawData;
				load(this.db, data);

				// Restore tracked file set
				if (Array.isArray(envelope.indexedFiles)) {
					this.indexedFiles = new Set(envelope.indexedFiles);
				}
			} catch (e) {
				// Corrupted or incompatible index — start fresh
				console.warn('OramaSearchEngine: Failed to load saved index, starting fresh:', e);
				this.db = this.createDb();
			}
		}
	}

	/**
	 * Persist the database to disk.
	 */
	async save(): Promise<void> {
		if (!this.db) return;

		// Ensure .witness directory exists
		if (!(await this.app.vault.adapter.exists('.witness'))) {
			await this.app.vault.adapter.mkdir('.witness');
		}

		const data = save(this.db);
		const envelope = {
			schemaVersion: SCHEMA_VERSION,
			data,
			indexedFiles: Array.from(this.indexedFiles),
		};
		await this.app.vault.adapter.write(STORE_PATH, JSON.stringify(envelope));
	}

	/**
	 * Get the number of indexed chunks (not files).
	 */
	getCount(): number {
		if (!this.db) return 0;
		return count(this.db) as number;
	}

	/**
	 * Get the number of unique files in the index.
	 */
	getFileCount(): number {
		return this.indexedFiles.size;
	}

	/**
	 * Index a single file's content into the search engine.
	 * Content is chunked by headings. Tags and folder are stored as metadata.
	 * Embeddings are optional — files without embeddings are still fulltext-searchable.
	 */
	async indexFile(file: TFile, content: string, options?: IndexFileOptions): Promise<void> {
		if (!this.db) throw new Error('OramaSearchEngine not initialized');

		const chunks = chunkMarkdown(content);

		// Remove all existing chunks for this file
		await this.removeFile(file.path);

		const tags = options?.tags ?? [];
		const folder = options?.folder ?? '';

		// Generate embeddings if we have an Ollama provider and no pre-computed embeddings
		let embeddings: number[][] | null = null;
		if (options?.embedding) {
			// Single pre-computed embedding — only valid for single-chunk docs
			embeddings = [options.embedding];
		}

		// Insert each chunk
		for (let i = 0; i < chunks.length; i++) {
			const doc: Record<string, unknown> = {
				id: `${file.path}#${i}`,
				sourcePath: file.path,
				title: file.basename,
				headingPath: chunks[i].headingPath,
				content: chunks[i].content,
				chunkIndex: i,
				mtime: file.stat.mtime,
				tags,
				folder,
			};

			// Only add embedding if we have one for this chunk
			if (embeddings && embeddings[i]) {
				doc.embedding = embeddings[i];
			}

			await insert(this.db, doc);
		}

		this.indexedFiles.add(file.path);
	}

	/**
	 * Index multiple files with two-phase approach:
	 * Phase 1: Content + metadata (always succeeds)
	 * Phase 2: Embeddings (may fail — files remain fulltext-searchable)
	 */
	async indexFiles(
		files: TFile[],
		options?: {
			generateEmbeddings?: boolean;
			minContentLength?: number;
			getFileTags?: (file: TFile) => string[];
			onProgress?: (done: number, total: number) => void;
			onLog?: (level: string, message: string, data?: any) => void;
			isUserActive?: () => boolean;
		},
	): Promise<{ indexed: number; embedded: number; failed: string[] }> {
		if (!this.db) throw new Error('OramaSearchEngine not initialized');

		let indexed = 0;
		let embedded = 0;
		const failed: string[] = [];
		const total = files.length;
		const generateEmbeddings = options?.generateEmbeddings ?? true;
		const minContentLength = options?.minContentLength ?? 0;

		for (const file of files) {
			// Pause while the user is actively typing to avoid UI stutter
			while (options?.isUserActive?.()) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			try {
				const content = await this.app.vault.cachedRead(file);
				const chunks = chunkMarkdown(content);

				await this.removeFile(file.path);

				// Extract metadata
				const tags = options?.getFileTags?.(file) ?? [];
				const folder = this.extractFolder(file.path);

				// Phase 1: Insert content + metadata (no embeddings yet)
				for (let i = 0; i < chunks.length; i++) {
					const doc: Record<string, unknown> = {
						id: `${file.path}#${i}`,
						sourcePath: file.path,
						title: file.basename,
						headingPath: chunks[i].headingPath,
						content: chunks[i].content,
						chunkIndex: i,
						mtime: file.stat.mtime,
						tags,
						folder,
					};
					await insert(this.db, doc);
					// Yield after each insert so the UI thread can process events
					await new Promise(resolve => setTimeout(resolve, 0));
				}

				indexed++;
				this.indexedFiles.add(file.path);

				// Phase 2: Generate embeddings if enabled and file is large enough
				if (generateEmbeddings && file.stat.size >= minContentLength) {
					try {
						const textsToEmbed = chunks.map(c =>
							c.headingPath ? `${c.headingPath}\n${c.content}` : c.content
						);
						const embeddings = await this.ollama.embedDocuments(textsToEmbed);

						// Remove and re-insert with embeddings
						for (let i = 0; i < chunks.length; i++) {
							await remove(this.db, `${file.path}#${i}`);
							await insert(this.db, {
								id: `${file.path}#${i}`,
								sourcePath: file.path,
								title: file.basename,
								headingPath: chunks[i].headingPath,
								content: chunks[i].content,
								chunkIndex: i,
								mtime: file.stat.mtime,
								tags,
								folder,
								embedding: embeddings[i],
							});
							// Yield after each remove+insert so the UI thread can process events
							await new Promise(resolve => setTimeout(resolve, 0));
						}
						embedded++;
					} catch (e) {
						// Embedding failed — file is still indexed for fulltext search
						options?.onLog?.('warn', `Embedding failed for ${file.path}: ${(e as Error).message}`);
					}
				}
			} catch (e) {
				failed.push(file.path);
				options?.onLog?.('error', `Failed to index ${file.path}: ${(e as Error).message}`);
			}

			options?.onProgress?.(indexed + failed.length, total);

			// Yield to the renderer so the UI can repaint and process input events
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		return { indexed, embedded, failed };
	}

	/**
	 * Extract top-level folder from path (e.g., "chaos/inbox/note.md" → "chaos").
	 */
	private extractFolder(path: string): string {
		const firstSlash = path.indexOf('/');
		return firstSlash > 0 ? path.slice(0, firstSlash) : '';
	}

	/**
	 * Remove all chunks for a given source file path.
	 * Chunks have IDs like "filepath#0", "filepath#1", etc.
	 */
	async removeFile(filePath: string): Promise<void> {
		if (!this.db) return;

		// Try removing chunks by sequential ID pattern
		for (let i = 0; i < 1000; i++) {
			const id = `${filePath}#${i}`;
			try {
				const existing = getByID(this.db, id);
				if (existing) {
					await remove(this.db, id);
					// Yield after each remove so the UI thread can process events
					await new Promise(resolve => setTimeout(resolve, 0));
				} else {
					break; // No more chunks for this file
				}
			} catch {
				break;
			}
		}

		// Also try the bare path (legacy single-chunk entries from older schemas)
		try {
			const existing = getByID(this.db, filePath);
			if (existing) {
				await remove(this.db, filePath);
			}
		} catch {
			// Not found — fine
		}

		this.indexedFiles.delete(filePath);
	}

	/**
	 * Move/rename a file in the index without re-generating embeddings.
	 * Updates sourcePath, title, folder, and chunk IDs.
	 * Returns the number of chunks moved (0 if file not found in index).
	 */
	async moveFile(oldPath: string, newPath: string, newFile: TFile): Promise<number> {
		if (!this.db) return 0;

		let moved = 0;
		const newTitle = newFile.basename;
		const newFolder = this.extractFolder(newPath);

		for (let i = 0; i < 1000; i++) {
			const id = `${oldPath}#${i}`;
			try {
				const existing = getByID(this.db, id) as unknown as ChunkDocument | null;
				if (!existing) break;

				await remove(this.db, id);

				const doc: Record<string, unknown> = {
					id: `${newPath}#${i}`,
					sourcePath: newPath,
					title: newTitle,
					headingPath: existing.headingPath,
					content: existing.content,
					chunkIndex: existing.chunkIndex,
					mtime: existing.mtime,
					tags: existing.tags,
					folder: newFolder,
				};

				// Preserve embedding if it exists
				if (existing.embedding?.length > 0) {
					doc.embedding = existing.embedding;
				}

				await insert(this.db, doc);
				moved++;
			} catch {
				break;
			}
		}

		if (moved > 0) {
			this.indexedFiles.delete(oldPath);
			this.indexedFiles.add(newPath);
		}

		return moved;
	}

	/**
	 * Find indexed file paths that no longer exist in the vault.
	 * Compares the tracked indexedFiles set against the provided vault paths.
	 */
	getOrphanedPaths(vaultPaths: Set<string>): string[] {
		const orphaned: string[] = [];
		for (const path of this.indexedFiles) {
			if (!vaultPaths.has(path)) {
				orphaned.push(path);
			}
		}
		return orphaned;
	}

	/**
	 * Unified search: dispatches to hybrid, vector, or fulltext based on mode.
	 * Supports path and tag filtering via Orama where clauses.
	 */
	async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
		if (!this.db) throw new Error('OramaSearchEngine not initialized');
		if (this.getCount() === 0) return [];

		switch (options.mode) {
			case 'hybrid':
				return this.searchHybrid(query, options);
			case 'vector':
				return this.searchVector(query, options);
			case 'fulltext':
				return this.searchFulltext(query, options);
			default:
				return this.searchHybrid(query, options);
		}
	}

	/**
	 * Hybrid search: QPS keyword matching + vector cosine similarity,
	 * merged via Reciprocal Rank Fusion (RRF).
	 */
	private async searchHybrid(
		query: string,
		options: SearchOptions,
	): Promise<SearchResult[]> {
		const limit = options.limit ?? 10;
		const minScore = options.minScore ?? 0.3;
		const fetchLimit = limit * 5;

		const queryEmbedding = await this.ollama.embedQuery(query);

		const searchParams: Record<string, unknown> = {
			mode: 'hybrid',
			term: query,
			vector: { value: queryEmbedding, property: 'embedding' },
			properties: ['title', 'content'],
			similarity: minScore,
			limit: fetchLimit,
			hybridWeights: { text: 0.3, vector: 0.7 },
		};

		const where = this.buildWhereClause(options);
		if (where) searchParams.where = where;

		const results = await search(this.db!, searchParams as any);
		return this.deduplicateAndFilter(results.hits, options.paths, limit);
	}

	/**
	 * Vector-only search: cosine similarity on embeddings.
	 */
	private async searchVector(
		query: string,
		options: SearchOptions,
	): Promise<SearchResult[]> {
		const limit = options.limit ?? 10;
		const minScore = options.minScore ?? 0.3;
		const fetchLimit = limit * 5;

		const queryEmbedding = await this.ollama.embedQuery(query);

		const searchParams: Record<string, unknown> = {
			mode: 'vector',
			vector: { value: queryEmbedding, property: 'embedding' },
			similarity: minScore,
			limit: fetchLimit,
		};

		const where = this.buildWhereClause(options);
		if (where) searchParams.where = where;

		const results = await searchVector(this.db!, searchParams as any);
		return this.deduplicateAndFilter(results.hits, options.paths, limit);
	}

	/**
	 * Fulltext-only search: QPS keyword matching, no embeddings needed.
	 */
	private async searchFulltext(
		query: string,
		options: SearchOptions,
	): Promise<SearchResult[]> {
		const limit = options.limit ?? 10;
		const fetchLimit = limit * 5;

		const searchParams: Record<string, unknown> = {
			term: query,
			properties: ['title', 'content'],
			limit: fetchLimit,
		};

		const where = this.buildWhereClause(options);
		if (where) searchParams.where = where;

		const results = await search(this.db!, searchParams as any);

		// Normalize scores to 0-1 range (relative to top result)
		const deduped = this.deduplicateAndFilter(results.hits, options.paths, limit);
		const maxScore = deduped.length > 0 ? deduped[0].score : 1;
		if (maxScore > 1) {
			return deduped.map((r) => ({ ...r, score: r.score / maxScore }));
		}
		return deduped;
	}

	/**
	 * Build Orama where clause from search options.
	 * Supports tag filtering (enum[] containsAll) and folder filtering.
	 */
	private buildWhereClause(options: SearchOptions): Record<string, unknown> | null {
		const conditions: Record<string, unknown>[] = [];

		if (options.tags?.length) {
			conditions.push({ tags: { containsAll: options.tags } });
		}

		// Path filtering can be done both via where (folder enum) and post-filter (paths prefix)
		// Use folder enum for top-level folder filtering if a single path matches a folder
		// Post-filtering via deduplicateAndFilter handles arbitrary path prefixes

		if (conditions.length === 0) return null;
		if (conditions.length === 1) return conditions[0];
		return { and: conditions };
	}

	/**
	 * Deduplicate hits by sourcePath (best chunk per file), filter by paths, and limit.
	 */
	private deduplicateAndFilter(
		hits: Array<{ document: unknown; score: number }>,
		paths?: string[],
		limit?: number
	): SearchResult[] {
		const bestPerFile = new Map<string, SearchResult>();

		for (const hit of hits) {
			const doc = hit.document as unknown as ChunkDocument;
			const sourcePath = doc.sourcePath;

			// Path filtering
			if (paths?.length && !paths.some(p => sourcePath.startsWith(p))) {
				continue;
			}

			const existing = bestPerFile.get(sourcePath);
			if (!existing || hit.score > existing.score) {
				const snippet = doc.content ? this.extractSnippet(doc.content) : undefined;
				bestPerFile.set(sourcePath, {
					path: sourcePath,
					title: doc.title,
					score: hit.score,
					headingPath: doc.headingPath || undefined,
					snippet,
					content: doc.content || undefined,
				});
			}
		}

		const results = Array.from(bestPerFile.values())
			.sort((a, b) => b.score - a.score);

		return limit ? results.slice(0, limit) : results;
	}

	/**
	 * Extract a snippet from content, stripping YAML frontmatter if present.
	 */
	private extractSnippet(content: string): string {
		let text = content;
		if (text.startsWith('---')) {
			const endIdx = text.indexOf('---', 3);
			if (endIdx !== -1) {
				text = text.slice(endIdx + 3).trimStart();
			}
		}
		return text.slice(0, 200);
	}

	/**
	 * Get files that need re-indexing (mtime changed or not indexed).
	 * Checks the first chunk (index 0) for each file.
	 */
	async getStaleFiles(files: TFile[]): Promise<TFile[]> {
		if (!this.db) return files;

		const stale: TFile[] = [];

		for (const file of files) {
			try {
				// Check for chunk 0 of this file
				const doc = getByID(this.db, `${file.path}#0`) as unknown as ChunkDocument | null;
				if (!doc) {
					// Also check legacy bare path entries
					const legacyDoc = getByID(this.db, file.path) as unknown as ChunkDocument | null;
					if (!legacyDoc) {
						stale.push(file);
					} else if (legacyDoc.mtime !== file.stat.mtime) {
						stale.push(file);
					} else {
						this.indexedFiles.add(file.path);
					}
				} else if (doc.mtime !== file.stat.mtime) {
					stale.push(file);
				} else {
					this.indexedFiles.add(file.path);
				}
			} catch {
				// Document not found — needs indexing
				stale.push(file);
			}
		}

		return stale;
	}

	/**
	 * Clear the entire index and delete the stored file.
	 */
	async clear(): Promise<void> {
		this.db = this.createDb();
		this.indexedFiles.clear();

		if (await this.app.vault.adapter.exists(STORE_PATH)) {
			await this.app.vault.adapter.remove(STORE_PATH);
		}
	}

	destroy(): void {
		this.db = null;
	}
}

// Backwards compatibility alias
export const VectorStore = OramaSearchEngine;
