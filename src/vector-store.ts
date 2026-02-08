/**
 * Vector store backed by Orama.
 * Stores document embeddings and supports hybrid (BM25 + vector),
 * vector-only, and fulltext-only search modes.
 * Persists to .witness/index.orama as a single JSON file.
 */

import { create, insert, remove, search, searchVector, save, load, count, getByID } from '@orama/orama';
import type { AnyOrama, RawData } from '@orama/orama';
import type { App, TFile } from 'obsidian';
import { OllamaProvider } from './ollama-provider';

const STORE_PATH = '.witness/index.orama';

// Bump this when the schema changes to force re-indexing on upgrade.
const SCHEMA_VERSION = 2; // v1 = vector-only, v2 = hybrid (added content field)

interface VaultDocument {
	path: string;
	title: string;
	content: string;
	mtime: number;
	embedding: number[];
}

export interface SearchResult {
	path: string;
	title: string;
	score: number;
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
			path: 'string' as const,
			title: 'string' as const,
			content: 'string' as const,
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
	 * Get the number of indexed documents.
	 */
	getCount(): number {
		if (!this.db) return 0;
		return count(this.db) as number;
	}

	/**
	 * Index a single file: read content, generate embedding via Ollama, store in Orama.
	 */
	async indexFile(file: TFile): Promise<void> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const content = await this.app.vault.cachedRead(file);
		const [embedding] = await this.ollama.embed([content]);

		// Remove existing entry for this path if present
		await this.removeByPath(file.path);

		// Insert new entry — use file path as document ID for reliable lookups
		await insert(this.db, {
			id: file.path,
			path: file.path,
			title: file.basename,
			content,
			mtime: file.stat.mtime,
			embedding,
		});
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
				const [embedding] = await this.ollama.embed([content]);
				await this.removeByPath(file.path);
				await insert(this.db, {
					id: file.path,
					path: file.path,
					title: file.basename,
					content,
					mtime: file.stat.mtime,
					embedding,
				});
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
	 * Remove a document by its vault path.
	 * Uses path as document ID for direct lookup (no search needed).
	 */
	async removeByPath(filePath: string): Promise<void> {
		if (!this.db) return;

		try {
			const existing = getByID(this.db, filePath);
			if (existing) {
				await remove(this.db, filePath);
			}
		} catch {
			// Document doesn't exist — nothing to remove
		}
	}

	/**
	 * Hybrid search: BM25 keyword matching + vector cosine similarity,
	 * merged via Reciprocal Rank Fusion (RRF).
	 */
	async searchHybrid(
		query: string,
		options?: { limit?: number; minScore?: number; paths?: string[] }
	): Promise<SearchResult[]> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const limit = options?.limit ?? 10;
		const minScore = options?.minScore ?? 0.3;

		const queryEmbedding = await this.ollama.embedOne(query);

		const results = await search(this.db, {
			mode: 'hybrid',
			term: query,
			vector: { value: queryEmbedding, property: 'embedding' },
			properties: ['title', 'content'],
			similarity: minScore,
			limit,
			hybridWeights: { text: 0.3, vector: 0.7 },
		} as any);

		return this.mapAndFilterHits(results.hits, options?.paths);
	}

	/**
	 * Vector-only search: cosine similarity on embeddings.
	 */
	async searchVector(
		query: string,
		options?: { limit?: number; minScore?: number; paths?: string[] }
	): Promise<SearchResult[]> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const limit = options?.limit ?? 10;
		const minScore = options?.minScore ?? 0.3;

		const queryEmbedding = await this.ollama.embedOne(query);

		const results = await searchVector(this.db, {
			mode: 'vector',
			vector: { value: queryEmbedding, property: 'embedding' },
			similarity: minScore,
			limit,
		});

		return this.mapAndFilterHits(results.hits, options?.paths);
	}

	/**
	 * Fulltext-only search: BM25 keyword matching, no embeddings needed.
	 */
	async searchFulltext(
		query: string,
		options?: { limit?: number; paths?: string[] }
	): Promise<SearchResult[]> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const results = await search(this.db, {
			term: query,
			properties: ['title', 'content'],
			limit: options?.limit ?? 10,
		});

		// Normalize BM25 scores to 0-1 range (relative to top result)
		const mapped = this.mapAndFilterHits(results.hits, options?.paths);
		const maxScore = mapped.length > 0 ? mapped[0].score : 1;
		if (maxScore > 1) {
			return mapped.map((r) => ({ ...r, score: r.score / maxScore }));
		}
		return mapped;
	}

	/**
	 * Map Orama hits to SearchResult[] and optionally filter by paths.
	 */
	private mapAndFilterHits(
		hits: Array<{ document: unknown; score: number }>,
		paths?: string[]
	): SearchResult[] {
		let results = hits.map((hit) => {
			const doc = hit.document as unknown as VaultDocument;
			const snippet = doc.content ? doc.content.slice(0, 200) : undefined;
			return {
				path: doc.path,
				title: doc.title,
				score: hit.score,
				snippet,
			};
		});

		if (paths?.length) {
			results = results.filter((h) =>
				paths.some((p) => h.path.startsWith(p))
			);
		}

		return results;
	}

	/**
	 * Get files that need re-indexing (mtime changed or not indexed).
	 * Uses path as document ID for direct lookup.
	 */
	async getStaleFiles(files: TFile[]): Promise<TFile[]> {
		if (!this.db) return files;

		const stale: TFile[] = [];

		for (const file of files) {
			try {
				const doc = getByID(this.db, file.path) as unknown as VaultDocument | null;
				if (!doc) {
					stale.push(file);
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
