/**
 * SmartConnectionsReader - Reads embeddings from Smart Connections plugin
 *
 * Smart Connections stores embeddings in .smart-env/multi/*.ajson files.
 * This reader loads those embeddings with incremental caching for efficient
 * semantic search.
 */

import { App, normalizePath } from 'obsidian';

// Expected model for compatibility
const EXPECTED_MODEL = 'TaylorAI/bge-micro-v2';
const MODEL_DIMENSIONS = 384;

// Smart Connections paths
const SC_ENV_DIR = '.smart-env';
const SC_CONFIG_FILE = '.smart-env/smart_env.json';
const SC_MULTI_DIR = '.smart-env/multi';

interface CachedEmbedding {
	path: string;
	vector: number[];
}

interface SCConfig {
	smart_sources?: {
		embed_model?: {
			adapter?: string;
			transformers?: {
				model_key?: string;
			};
		};
	};
}

export interface SCValidationResult {
	valid: boolean;
	error?: string;
	model?: string;
	documentCount?: number;
}

export interface SearchResult {
	path: string;
	score: number;
}

export class SmartConnectionsReader {
	private app: App;
	private cache: Map<string, CachedEmbedding> = new Map();
	private scFileMtimes: Map<string, number> = new Map(); // Track mtimes by SC file path
	private scFileToVaultPath: Map<string, string> = new Map(); // Map SC file -> vault path
	private lastLoadTime: number = 0;
	private initialized: boolean = false;

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Validate Smart Connections configuration
	 */
	async validate(): Promise<SCValidationResult> {
		const adapter = this.app.vault.adapter;

		// Check if SC directory exists
		if (!await adapter.exists(SC_ENV_DIR)) {
			return {
				valid: false,
				error: 'Smart Connections plugin not configured. Please install Smart Connections and enable embeddings.',
			};
		}

		// Check config file
		if (!await adapter.exists(SC_CONFIG_FILE)) {
			return {
				valid: false,
				error: 'Smart Connections configuration not found. Please configure Smart Connections embeddings.',
			};
		}

		// Read and parse config
		try {
			const configContent = await adapter.read(SC_CONFIG_FILE);
			const config: SCConfig = JSON.parse(configContent);

			// Check model
			const modelKey = config.smart_sources?.embed_model?.transformers?.model_key;
			if (!modelKey) {
				return {
					valid: false,
					error: 'Smart Connections embedding model not configured. Please enable embeddings in Smart Connections settings.',
				};
			}

			if (modelKey !== EXPECTED_MODEL) {
				return {
					valid: false,
					error: `Smart Connections is using a different embedding model (${modelKey}). Please configure it to use ${EXPECTED_MODEL} for compatibility with Witness.`,
					model: modelKey,
				};
			}

			// Check multi directory
			if (!await adapter.exists(SC_MULTI_DIR)) {
				return {
					valid: false,
					error: 'No embeddings found. Please run Smart Connections indexing first.',
				};
			}

			// Count files
			const files = await adapter.list(SC_MULTI_DIR);
			const ajsonFiles = files.files.filter(f => f.endsWith('.ajson'));

			if (ajsonFiles.length === 0) {
				return {
					valid: false,
					error: 'No embeddings found. Please run Smart Connections indexing first.',
				};
			}

			return {
				valid: true,
				model: modelKey,
				documentCount: ajsonFiles.length,
			};
		} catch (error) {
			return {
				valid: false,
				error: `Failed to read Smart Connections configuration: ${error}`,
			};
		}
	}

	/**
	 * Load or refresh embeddings cache
	 * Uses incremental loading - only reloads files modified since last load
	 */
	async loadEmbeddings(): Promise<number> {
		const adapter = this.app.vault.adapter;

		// Get list of .ajson files
		const files = await adapter.list(SC_MULTI_DIR);
		const ajsonFiles = files.files.filter(f => f.endsWith('.ajson'));

		let loadedCount = 0;
		let skippedCount = 0;
		const currentVaultPaths = new Set<string>();

		for (const scFilePath of ajsonFiles) {
			try {
				// Check file mtime
				const stat = await adapter.stat(scFilePath);
				if (!stat) continue;

				// Check if we've already processed this SC file with same mtime
				const cachedMtime = this.scFileMtimes.get(scFilePath);
				if (cachedMtime !== undefined && stat.mtime <= cachedMtime) {
					// File hasn't changed - track its vault path and skip
					const vaultPath = this.scFileToVaultPath.get(scFilePath);
					if (vaultPath) {
						currentVaultPaths.add(vaultPath);
						skippedCount++;
						continue;
					}
				}

				// Read and parse the file
				const content = await adapter.read(scFilePath);
				const embedding = this.parseAjsonFile(content);

				if (embedding) {
					this.cache.set(embedding.path, {
						path: embedding.path,
						vector: embedding.vector,
					});
					// Track the SC file -> vault path mapping and mtime
					this.scFileMtimes.set(scFilePath, stat.mtime);
					this.scFileToVaultPath.set(scFilePath, embedding.path);
					currentVaultPaths.add(embedding.path);
					loadedCount++;
				}
			} catch (error) {
				// Skip files that fail to parse
				console.warn(`[SmartConnectionsReader] Failed to parse ${scFilePath}:`, error);
			}
		}

		// Remove cached entries for deleted files
		for (const cachedPath of this.cache.keys()) {
			if (!currentVaultPaths.has(cachedPath)) {
				this.cache.delete(cachedPath);
			}
		}

		// Clean up mtime tracking for deleted SC files
		const currentScFiles = new Set(ajsonFiles);
		for (const scPath of this.scFileMtimes.keys()) {
			if (!currentScFiles.has(scPath)) {
				this.scFileMtimes.delete(scPath);
				this.scFileToVaultPath.delete(scPath);
			}
		}

		this.lastLoadTime = Date.now();
		this.initialized = true;

		return loadedCount;
	}

	/**
	 * Parse Smart Connections AJSON file format
	 * Format: "smart_sources:path": { "path": "...", "embeddings": { "model": { "vec": [...] } } }
	 */
	private parseAjsonFile(content: string): { path: string; vector: number[] } | null {
		try {
			// AJSON has one JSON object per line, find the smart_sources entry
			const lines = content.trim().split('\n');

			for (const line of lines) {
				if (!line.trim()) continue;

				// Parse the line - it's like: "key": { ... },
				// We need to wrap it to make valid JSON and remove trailing comma
				let cleanLine = line.trim();
				if (cleanLine.endsWith(',')) {
					cleanLine = cleanLine.slice(0, -1);
				}
				const jsonStr = `{${cleanLine}}`;
				const parsed = JSON.parse(jsonStr);

				// Find the smart_sources entry
				for (const [key, value] of Object.entries(parsed)) {
					if (key.startsWith('smart_sources:')) {
						const entry = value as any;
						const path = entry.path;
						const embeddings = entry.embeddings?.[EXPECTED_MODEL];

						if (path && embeddings?.vec) {
							const vector = embeddings.vec;
							if (Array.isArray(vector) && vector.length === MODEL_DIMENSIONS) {
								return { path, vector };
							}
						}
					}
				}
			}

			return null;
		} catch (error) {
			return null;
		}
	}

	/**
	 * Get all cached embeddings
	 */
	getEmbeddings(): Map<string, CachedEmbedding> {
		return this.cache;
	}

	/**
	 * Get embedding count
	 */
	getCount(): number {
		return this.cache.size;
	}

	/**
	 * Check if cache is initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
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
		if (magnitude === 0) return 0;

		return dotProduct / magnitude;
	}

	/**
	 * Search for similar documents
	 */
	search(
		queryVector: number[],
		options: {
			limit?: number;
			minScore?: number;
			paths?: string[];
		} = {}
	): SearchResult[] {
		const { limit = 10, minScore = 0.3, paths } = options;

		const results: SearchResult[] = [];

		for (const [docPath, entry] of this.cache.entries()) {
			// Filter by paths if specified
			if (paths && paths.length > 0) {
				const matchesPath = paths.some(p => docPath.startsWith(p));
				if (!matchesPath) continue;
			}

			const score = this.cosineSimilarity(queryVector, entry.vector);

			if (score >= minScore) {
				results.push({ path: docPath, score });
			}
		}

		// Sort by score descending and limit
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}

	/**
	 * Clear the cache
	 */
	clearCache(): void {
		this.cache.clear();
		this.scFileMtimes.clear();
		this.scFileToVaultPath.clear();
		this.lastLoadTime = 0;
		this.initialized = false;
	}
}
