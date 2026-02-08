/**
 * SearchEngine interface — abstraction over the search index.
 * Currently backed by Orama (OramaSearchEngine in vector-store.ts).
 * Swap the implementation without changing consumers.
 */

import type { TFile } from 'obsidian';

export interface SearchOptions {
	mode: 'hybrid' | 'vector' | 'fulltext';
	limit?: number;
	minScore?: number;
	paths?: string[];
	tags?: string[];
}

export interface SearchResult {
	path: string;
	title: string;
	score: number;
	headingPath?: string;
	snippet?: string;
	/** Full chunk content for phrase matching. Not sent to MCP clients. */
	content?: string;
}

export interface IndexFileOptions {
	embedding?: number[];
	tags?: string[];
	folder?: string;
}

export interface SearchEngine {
	initialize(): Promise<void>;

	/**
	 * Index a single file's content and metadata into the search engine.
	 * Embeddings are optional — files without embeddings are still fulltext-searchable.
	 */
	indexFile(file: TFile, content: string, options?: IndexFileOptions): Promise<void>;

	/**
	 * Remove all indexed data for a given file path.
	 */
	removeFile(path: string): Promise<void>;

	/**
	 * Search the index. Supports hybrid, vector, and fulltext modes.
	 */
	search(query: string, options: SearchOptions): Promise<SearchResult[]>;

	/**
	 * Get files that need re-indexing (mtime changed or not indexed).
	 */
	getStaleFiles(files: TFile[]): Promise<TFile[]>;

	/** Number of indexed chunks. */
	getCount(): number;

	/** Persist the index to disk. */
	save(): Promise<void>;

	/** Clear the entire index. */
	clear(): Promise<void>;

	/** Release resources. */
	destroy(): void;
}
