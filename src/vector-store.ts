/**
 * Vector store backed by Orama.
 * Stores document embeddings and supports vector similarity search.
 * Persists to .witness/index.orama as a single JSON file.
 */

import { create, insert, remove, searchVector, save, load, count, getByID } from '@orama/orama';
import type { AnyOrama, RawData } from '@orama/orama';
import type { App, TFile } from 'obsidian';
import { OllamaProvider } from './ollama-provider';

const STORE_PATH = '.witness/index.orama';

interface VaultDocument {
	path: string;
	title: string;
	mtime: number;
	embedding: number[];
}

export interface SearchResult {
	path: string;
	title: string;
	score: number;
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

	/**
	 * Initialise the database. Loads from disk if a saved index exists,
	 * otherwise creates a fresh empty database.
	 */
	async initialize(): Promise<void> {
		const schema = {
			path: 'string' as const,
			title: 'string' as const,
			mtime: 'number' as const,
			embedding: `vector[${this.dimensions}]` as const,
		};

		this.db = create({ schema, id: 'witness-vectors' });

		// Try to load existing index
		if (await this.app.vault.adapter.exists(STORE_PATH)) {
			try {
				const raw = await this.app.vault.adapter.read(STORE_PATH);
				const data = JSON.parse(raw) as RawData;
				load(this.db, data);
			} catch (e) {
				// Corrupted index — start fresh
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
		await this.app.vault.adapter.write(STORE_PATH, JSON.stringify(data));
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

		// Insert new entry
		await insert(this.db, {
			path: file.path,
			title: file.basename,
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
		batchSize = 20
	): Promise<number> {
		if (!this.db) throw new Error('VectorStore not initialized');

		let indexed = 0;
		const total = files.length;

		for (let i = 0; i < files.length; i += batchSize) {
			const batch = files.slice(i, i + batchSize);
			const texts = await Promise.all(
				batch.map((f) => this.app.vault.cachedRead(f))
			);

			const embeddings = await this.ollama.embed(texts);

			for (let j = 0; j < batch.length; j++) {
				await this.removeByPath(batch[j].path);
				await insert(this.db, {
					path: batch[j].path,
					title: batch[j].basename,
					mtime: batch[j].stat.mtime,
					embedding: embeddings[j],
				});
			}

			indexed += batch.length;
			onProgress?.(indexed, total);
		}

		return indexed;
	}

	/**
	 * Remove a document by its vault path.
	 */
	async removeByPath(filePath: string): Promise<void> {
		if (!this.db) return;

		// Search for the document by path to get its internal ID
		const results = await searchVector(this.db, {
			mode: 'vector',
			vector: { value: new Array(this.dimensions).fill(0), property: 'embedding' },
			similarity: 0,
			where: { path: { eq: filePath } },
			limit: 1,
		});

		if (results.hits.length > 0) {
			await remove(this.db, results.hits[0].id);
		}
	}

	/**
	 * Search for documents similar to a query string.
	 */
	async search(
		query: string,
		options?: { limit?: number; minScore?: number; paths?: string[] }
	): Promise<SearchResult[]> {
		if (!this.db) throw new Error('VectorStore not initialized');

		const limit = options?.limit ?? 10;
		const minScore = options?.minScore ?? 0.3;

		// Generate query embedding
		const queryEmbedding = await this.ollama.embedOne(query);

		const results = await searchVector(this.db, {
			mode: 'vector',
			vector: { value: queryEmbedding, property: 'embedding' },
			similarity: minScore,
			limit,
		});

		let hits = results.hits.map((hit) => ({
			path: (hit.document as unknown as VaultDocument).path,
			title: (hit.document as unknown as VaultDocument).title,
			score: hit.score,
		}));

		// Filter by paths if specified
		if (options?.paths?.length) {
			hits = hits.filter((h) =>
				options.paths!.some((p) => h.path.startsWith(p))
			);
		}

		return hits;
	}

	/**
	 * Get files that need re-indexing (mtime changed or not indexed).
	 */
	async getStaleFiles(files: TFile[]): Promise<TFile[]> {
		if (!this.db) return files;

		const stale: TFile[] = [];

		for (const file of files) {
			// Search for existing entry
			const results = await searchVector(this.db, {
				mode: 'vector',
				vector: { value: new Array(this.dimensions).fill(0), property: 'embedding' },
				similarity: 0,
				where: { path: { eq: file.path } },
				limit: 1,
			});

			if (results.hits.length === 0) {
				stale.push(file);
			} else {
				const doc = results.hits[0].document as unknown as VaultDocument;
				if (doc.mtime !== file.stat.mtime) {
					stale.push(file);
				}
			}
		}

		return stale;
	}

	/**
	 * Clear the entire index and delete the stored file.
	 */
	async clear(): Promise<void> {
		const schema = {
			path: 'string' as const,
			title: 'string' as const,
			mtime: 'number' as const,
			embedding: `vector[${this.dimensions}]` as const,
		};
		this.db = create({ schema, id: 'witness-vectors' });

		if (await this.app.vault.adapter.exists(STORE_PATH)) {
			await this.app.vault.adapter.remove(STORE_PATH);
		}
	}

	destroy(): void {
		this.db = null;
	}
}
