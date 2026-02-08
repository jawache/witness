/**
 * Vector store backed by Orama.
 * Stores chunk embeddings and supports hybrid (BM25 + vector),
 * vector-only, and fulltext-only search modes.
 * Documents are split into chunks by markdown headings for better retrieval.
 * Persists to .witness/index.orama as a single JSON file.
 */

import { create, insert, remove, search, searchVector, save, load, count, getByID } from '@orama/orama';
import type { AnyOrama, RawData } from '@orama/orama';
import type { App, TFile } from 'obsidian';
import { OllamaProvider } from './ollama-provider';
import { chunkMarkdown } from './chunker';

const STORE_PATH = '.witness/index.orama';

// Bump this when the schema changes to force re-indexing on upgrade.
const SCHEMA_VERSION = 3; // v1 = vector-only, v2 = hybrid (content), v3 = chunked (sourcePath, headingPath, chunkIndex)

interface ChunkDocument {
	sourcePath: string;
	title: string;
	headingPath: string;
	content: string;
	chunkIndex: number;
	mtime: number;
	embedding: number[];
}

export interface SearchResult {
	path: string;
	title: string;
	score: number;
	headingPath?: string;
	snippet?: string;
}

export class VectorStore {
	private db: AnyOrama | null = null;
	private app: App;
	private ollama: OllamaProvider;
	private dimensions: number;

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
			embedding: `vector[${this.dimensions}]` as const,
		};
	}

	/**
	 * Initialise the database. Loads from disk if a saved index exists,
	 * otherwise creates a fresh empty database.
	 */
	async initialize(): Promise<void> {
		const schema = this.getSchema();
		this.db = create({ schema, id: 'witness-vectors' });

		// Try to load existing index
		if (await this.app.vault.adapter.exists(STORE_PATH)) {
			try {
				const raw = await this.app.vault.adapter.read(STORE_PATH);
				const envelope = JSON.parse(raw);

				// Check schema version — discard old indexes to force re-index
				const version = envelope.schemaVersion ?? 1;
				if (version < SCHEMA_VERSION) {
					console.warn(`VectorStore: Schema v${version} → v${SCHEMA_VERSION}, discarding old index`);
					this.db = create({ schema, id: 'witness-vectors' });
					return;
				}

				const data = (envelope.data ?? envelope) as RawData;
				load(this.db, data);
			} catch (e) {
				// Corrupted or incompatible index — start fresh
				console.warn('VectorStore: Failed to load saved index, starting fresh:', e);
				this.db = create({ schema, id: 'witness-vectors' });
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
		const envelope = { schemaVersion: SCHEMA_VERSION, data };
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
	 * Index a single file: read content, chunk by headings, generate embeddings, store in Orama.
	 */
	async indexFile(file: TFile): Promise<void> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const content = await this.app.vault.cachedRead(file);
		const chunks = chunkMarkdown(content);

		// Remove all existing chunks for this file
		await this.removeBySourcePath(file.path);

		// Embed all chunks — prepend heading path for context
		const textsToEmbed = chunks.map(c =>
			c.headingPath ? `${c.headingPath}\n${c.content}` : c.content
		);
		const embeddings = await this.ollama.embedDocuments(textsToEmbed);

		// Insert each chunk
		for (let i = 0; i < chunks.length; i++) {
			await insert(this.db, {
				id: `${file.path}#${i}`,
				sourcePath: file.path,
				title: file.basename,
				headingPath: chunks[i].headingPath,
				content: chunks[i].content,
				chunkIndex: i,
				mtime: file.stat.mtime,
				embedding: embeddings[i],
			});
		}
	}

	/**
	 * Index multiple files in batches for efficiency.
	 */
	async indexFiles(
		files: TFile[],
		onProgress?: (done: number, total: number) => void,
		onLog?: (level: string, message: string, data?: any) => void,
	): Promise<{ indexed: number; failed: string[] }> {
		if (!this.db) throw new Error('VectorStore not initialized');

		let indexed = 0;
		const failed: string[] = [];
		const total = files.length;

		for (const file of files) {
			try {
				const content = await this.app.vault.cachedRead(file);
				const chunks = chunkMarkdown(content);

				await this.removeBySourcePath(file.path);

				// Embed all chunks for this file — prepend heading path for context
				const textsToEmbed = chunks.map(c =>
					c.headingPath ? `${c.headingPath}\n${c.content}` : c.content
				);
				const embeddings = await this.ollama.embedDocuments(textsToEmbed);

				for (let i = 0; i < chunks.length; i++) {
					await insert(this.db, {
						id: `${file.path}#${i}`,
						sourcePath: file.path,
						title: file.basename,
						headingPath: chunks[i].headingPath,
						content: chunks[i].content,
						chunkIndex: i,
						mtime: file.stat.mtime,
						embedding: embeddings[i],
					});
				}

				indexed++;
			} catch (e) {
				failed.push(file.path);
				onLog?.('error', `Failed to index ${file.path}: ${(e as Error).message}`);
			}

			onProgress?.(indexed + failed.length, total);
		}

		return { indexed, failed };
	}

	/**
	 * Remove all chunks for a given source file path.
	 * Chunks have IDs like "filepath#0", "filepath#1", etc.
	 */
	async removeBySourcePath(filePath: string): Promise<void> {
		if (!this.db) return;

		// Try removing chunks by sequential ID pattern
		for (let i = 0; i < 1000; i++) {
			const id = `${filePath}#${i}`;
			try {
				const existing = getByID(this.db, id);
				if (existing) {
					await remove(this.db, id);
				} else {
					break; // No more chunks for this file
				}
			} catch {
				break;
			}
		}

		// Also try the bare path (legacy single-chunk entries from schema v2)
		try {
			const existing = getByID(this.db, filePath);
			if (existing) {
				await remove(this.db, filePath);
			}
		} catch {
			// Not found — fine
		}
	}

	/**
	 * Hybrid search: BM25 keyword matching + vector cosine similarity,
	 * merged via Reciprocal Rank Fusion (RRF).
	 * Deduplicates by sourcePath, keeping the highest-scoring chunk per file.
	 */
	async searchHybrid(
		query: string,
		options?: { limit?: number; minScore?: number; paths?: string[] }
	): Promise<SearchResult[]> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const limit = options?.limit ?? 10;
		const minScore = options?.minScore ?? 0.3;

		const queryEmbedding = await this.ollama.embedQuery(query);

		// Fetch more results than needed to account for deduplication
		const fetchLimit = limit * 5;

		const results = await search(this.db, {
			mode: 'hybrid',
			term: query,
			vector: { value: queryEmbedding, property: 'embedding' },
			properties: ['title', 'content'],
			similarity: minScore,
			limit: fetchLimit,
			hybridWeights: { text: 0.3, vector: 0.7 },
		} as any);

		return this.deduplicateAndFilter(results.hits, options?.paths, limit);
	}

	/**
	 * Vector-only search: cosine similarity on embeddings.
	 * Deduplicates by sourcePath, keeping the highest-scoring chunk per file.
	 */
	async searchVector(
		query: string,
		options?: { limit?: number; minScore?: number; paths?: string[] }
	): Promise<SearchResult[]> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const limit = options?.limit ?? 10;
		const minScore = options?.minScore ?? 0.3;

		const queryEmbedding = await this.ollama.embedQuery(query);

		const fetchLimit = limit * 5;

		const results = await searchVector(this.db, {
			mode: 'vector',
			vector: { value: queryEmbedding, property: 'embedding' },
			similarity: minScore,
			limit: fetchLimit,
		});

		return this.deduplicateAndFilter(results.hits, options?.paths, limit);
	}

	/**
	 * Fulltext-only search: BM25 keyword matching, no embeddings needed.
	 * Deduplicates by sourcePath, keeping the highest-scoring chunk per file.
	 */
	async searchFulltext(
		query: string,
		options?: { limit?: number; paths?: string[] }
	): Promise<SearchResult[]> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const limit = options?.limit ?? 10;
		const fetchLimit = limit * 5;

		const results = await search(this.db, {
			term: query,
			properties: ['title', 'content'],
			limit: fetchLimit,
		});

		// Normalize BM25 scores to 0-1 range (relative to top result)
		const deduped = this.deduplicateAndFilter(results.hits, options?.paths, limit);
		const maxScore = deduped.length > 0 ? deduped[0].score : 1;
		if (maxScore > 1) {
			return deduped.map((r) => ({ ...r, score: r.score / maxScore }));
		}
		return deduped;
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
					}
				} else if (doc.mtime !== file.stat.mtime) {
					stale.push(file);
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
		const schema = this.getSchema();
		this.db = create({ schema, id: 'witness-vectors' });

		if (await this.app.vault.adapter.exists(STORE_PATH)) {
			await this.app.vault.adapter.remove(STORE_PATH);
		}
	}

	destroy(): void {
		this.db = null;
	}
}
