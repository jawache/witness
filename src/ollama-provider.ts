/**
 * Ollama embedding provider.
 * Calls Ollama's /api/embed endpoint for generating embeddings.
 */

export interface OllamaProviderConfig {
	baseUrl?: string;
	model?: string;
	log?: (level: string, message: string, data?: any) => void;
}

export interface EmbeddingModelInfo {
	name: string;
	parameterSize: string;
	family: string;
	dimensions: number | null;
}

interface OllamaEmbedResponse {
	model: string;
	embeddings: number[][];
	total_duration: number;
	load_duration: number;
	prompt_eval_count: number;
}

interface OllamaTagsResponse {
	models: Array<{
		name: string;
		model: string;
		size: number;
	}>;
}

interface OllamaShowResponse {
	details: {
		family: string;
		parameter_size: string;
		quantization_level: string;
	};
	model_info: Record<string, unknown>;
	capabilities: string[];
}

const MODEL_DIMENSIONS: Record<string, number> = {
	'nomic-embed-text': 768,
	'all-minilm': 384,
	'mxbai-embed-large': 1024,
	'bge-m3': 1024,
	'bge-large': 1024,
	'snowflake-arctic-embed': 384,
};

// Context length in tokens per model. Used for client-side pre-truncation
// as a safety net — Ollama's truncate:true is unreliable on some versions.
// NOTE: Use the actual model architecture context_length from /api/show → model_info,
// NOT the num_ctx Modelfile parameter (which may be larger but doesn't extend embedding context).
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
	'nomic-embed-text': 2048,   // nomic-bert.context_length = 2048 (num_ctx 8192 is misleading)
	'all-minilm': 256,
	'mxbai-embed-large': 512,
	'bge-m3': 8192,
	'bge-large': 512,
	'snowflake-arctic-embed': 512,
};

// Task prefixes required by some embedding models for optimal retrieval.
// Without these, embeddings are in a generic space and similarity is meaningless.
const MODEL_TASK_PREFIXES: Record<string, { document: string; query: string }> = {
	'nomic-embed-text': { document: 'search_document: ', query: 'search_query: ' },
	'nomic-embed-text-v2-moe': { document: 'search_document: ', query: 'search_query: ' },
	'mxbai-embed-large': { document: '', query: 'Represent this sentence for searching relevant passages: ' },
};

// Conservative chars-per-token estimate. English averages ~4, but JSON, URLs,
// special syntax, and non-ASCII can be as low as ~1.5. Use 2 for safety.
const CHARS_PER_TOKEN = 2;
const DEFAULT_CONTEXT_TOKENS = 2048;

export class OllamaProvider {
	private baseUrl: string;
	private model: string;
	private log: (level: string, message: string, data?: any) => void;
	private resolvedDimensions: number | null = null;
	private resolvedContextTokens: number | null = null;

	constructor(config?: OllamaProviderConfig) {
		this.baseUrl = config?.baseUrl || 'http://localhost:11434';
		this.model = config?.model || 'nomic-embed-text';
		this.log = config?.log || (() => {});
	}

	/**
	 * Check if Ollama is running and reachable.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/api/tags`);
			return res.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Check if the configured model is pulled.
	 */
	async hasModel(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/api/tags`);
			if (!res.ok) return false;
			const data = (await res.json()) as OllamaTagsResponse;
			return data.models.some((m) => m.name.startsWith(this.model));
		} catch {
			return false;
		}
	}

	/**
	 * List all locally available models that have the "embedding" capability.
	 * Calls GET /api/tags then POST /api/show per model.
	 */
	async listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
		const res = await fetch(`${this.baseUrl}/api/tags`);
		if (!res.ok) throw new Error(`Ollama tags failed (${res.status})`);
		const data = (await res.json()) as OllamaTagsResponse;

		const embeddingModels: EmbeddingModelInfo[] = [];

		for (const model of data.models) {
			try {
				const showRes = await fetch(`${this.baseUrl}/api/show`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: model.name }),
				});
				if (!showRes.ok) continue;
				const showData = (await showRes.json()) as OllamaShowResponse;

				if (showData.capabilities?.includes('embedding')) {
					const baseName = model.name.split(':')[0];
					let dimensions: number | null = MODEL_DIMENSIONS[baseName] ?? null;

					if (!dimensions && showData.model_info) {
						const embLen = Object.entries(showData.model_info)
							.find(([k]) => k.includes('embedding_length'));
						if (embLen) dimensions = embLen[1] as number;
					}

					embeddingModels.push({
						name: model.name,
						parameterSize: showData.details?.parameter_size ?? 'unknown',
						family: showData.details?.family ?? 'unknown',
						dimensions,
					});
				}
			} catch {
				continue;
			}
		}

		return embeddingModels;
	}

	/**
	 * Pull a model from the Ollama registry. Streams progress via callback.
	 */
	async pullModel(
		model: string,
		onProgress?: (status: string, percent: number | null) => void,
	): Promise<void> {
		const res = await fetch(`${this.baseUrl}/api/pull`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model }),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Ollama pull failed (${res.status}): ${body}`);
		}

		const reader = res.body?.getReader();
		if (!reader) return;

		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const data = JSON.parse(line);
					let percent: number | null = null;
					if (data.total > 0 && data.completed != null) {
						percent = Math.round((data.completed / data.total) * 100);
					}
					onProgress?.(data.status || '', percent);
				} catch { /* skip malformed lines */ }
			}
		}
	}

	/**
	 * Embed one or more texts. Returns one embedding vector per input.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		// Pre-truncate as safety net — Ollama's truncate:true is unreliable on some versions
		const maxChars = this.getMaxChars();
		const truncated = texts.map(t => t.length > maxChars ? t.slice(0, maxChars) : t);

		this.log('info', `Ollama embed: model=${this.model}, texts=${texts.length}, sizes=[${truncated.map(t => t.length).join(',')}], maxChars=${maxChars}`);

		const res = await fetch(`${this.baseUrl}/api/embed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: this.model, input: truncated, truncate: true }),
		});

		if (!res.ok) {
			const body = await res.text();
			this.log('error', `Ollama embed failed: status=${res.status}, body=${body}, model=${this.model}, textCount=${truncated.length}, textSizes=[${truncated.map(t => t.length).join(',')}]`);
			throw new Error(`Ollama embed failed (${res.status}): ${body}`);
		}

		const data = (await res.json()) as OllamaEmbedResponse;
		return data.embeddings;
	}

	/**
	 * Embed a single text. Convenience wrapper.
	 */
	async embedOne(text: string): Promise<number[]> {
		const [embedding] = await this.embed([text]);
		return embedding;
	}

	/**
	 * Embed documents for storage. Adds model-specific task prefix if required.
	 */
	async embedDocuments(texts: string[]): Promise<number[][]> {
		const prefix = this.getTaskPrefix();
		if (prefix) {
			return this.embed(texts.map(t => prefix.document + t));
		}
		return this.embed(texts);
	}

	/**
	 * Embed a query for search. Adds model-specific task prefix if required.
	 */
	async embedQuery(text: string): Promise<number[]> {
		const prefix = this.getTaskPrefix();
		const input = prefix ? prefix.query + text : text;
		const [embedding] = await this.embed([input]);
		return embedding;
	}

	private getTaskPrefix(): { document: string; query: string } | null {
		const baseName = this.model.split(':')[0];
		return MODEL_TASK_PREFIXES[baseName] ?? null;
	}

	getModel(): string {
		return this.model;
	}

	getDimensions(): number {
		if (this.resolvedDimensions) return this.resolvedDimensions;
		return MODEL_DIMENSIONS[this.model.split(':')[0]] || 768;
	}

	getMaxChars(): number {
		const tokens = this.resolvedContextTokens
			?? MODEL_CONTEXT_TOKENS[this.model.split(':')[0]]
			?? DEFAULT_CONTEXT_TOKENS;
		return tokens * CHARS_PER_TOKEN;
	}

	/**
	 * Query /api/show to resolve the model's actual dimensions and context length.
	 * Caches results so getDimensions() and getMaxChars() return accurate values.
	 * Falls back to hardcoded maps if Ollama is unreachable.
	 */
	async resolveModelInfo(): Promise<void> {
		try {
			const res = await fetch(`${this.baseUrl}/api/show`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: this.model }),
			});
			if (!res.ok) return;

			const data = (await res.json()) as OllamaShowResponse;
			const info = data.model_info || {};

			for (const [key, value] of Object.entries(info)) {
				if (key.includes('embedding_length') && typeof value === 'number') {
					this.resolvedDimensions = value;
				}
				if (key.includes('context_length') && typeof value === 'number') {
					this.resolvedContextTokens = value;
				}
			}

			this.log('info', `Resolved model info for ${this.model}: dimensions=${this.resolvedDimensions ?? 'fallback'}, contextTokens=${this.resolvedContextTokens ?? 'fallback'}, maxChars=${this.getMaxChars()}`);
		} catch {
			this.log('info', `Could not resolve model info for ${this.model}, using fallback values`);
		}
	}

	/**
	 * Call Ollama's /api/generate endpoint (non-streaming).
	 */
	async generate(model: string, prompt: string, options?: { temperature?: number; format?: string }): Promise<string> {
		const body: Record<string, unknown> = {
			model,
			prompt,
			stream: false,
			options: { temperature: options?.temperature ?? 0 },
		};
		if (options?.format) {
			body.format = options.format;
		}

		const res = await fetch(`${this.baseUrl}/api/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Ollama generate failed (${res.status}): ${text}`);
		}

		const data = await res.json();
		return data.response;
	}

	/**
	 * List all locally available models that have the "completion" capability
	 * (i.e. chat/generate models, not embedding-only).
	 */
	async listChatModels(): Promise<Array<{ name: string; parameterSize: string; family: string }>> {
		const res = await fetch(`${this.baseUrl}/api/tags`);
		if (!res.ok) throw new Error(`Ollama tags failed (${res.status})`);
		const data = (await res.json()) as OllamaTagsResponse;

		const chatModels: Array<{ name: string; parameterSize: string; family: string }> = [];

		for (const model of data.models) {
			try {
				const showRes = await fetch(`${this.baseUrl}/api/show`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: model.name }),
				});
				if (!showRes.ok) continue;
				const showData = (await showRes.json()) as OllamaShowResponse;

				if (showData.capabilities?.includes('completion')) {
					chatModels.push({
						name: model.name,
						parameterSize: showData.details?.parameter_size ?? 'unknown',
						family: showData.details?.family ?? 'unknown',
					});
				}
			} catch {
				continue;
			}
		}

		return chatModels;
	}

	/**
	 * Re-rank search candidates using an LLM as a relevance judge.
	 * Sends all candidates in a single prompt for batch scoring.
	 * Returns candidates sorted by relevance score (descending), limited to topK.
	 * Falls back to original ordering if parsing fails.
	 */
	async rerank(
		model: string,
		query: string,
		candidates: Array<{ index: number; content: string }>,
		topK: number,
	): Promise<Array<{ index: number; score: number }>> {
		if (candidates.length === 0) return [];

		const CONTENT_LIMIT = 500;
		const candidateList = candidates.map(c =>
			`[${c.index}] ${c.content.length > CONTENT_LIMIT ? c.content.slice(0, CONTENT_LIMIT) + '...' : c.content}`
		).join('\n\n');

		const prompt = `You are a search relevance judge. Given a query and numbered document excerpts, rate each document's relevance to the query on a scale of 0-10 (10 = perfectly relevant, 0 = completely irrelevant).

Query: "${query}"

Documents:
${candidateList}

Return a JSON object with a "scores" array. Each element should be [index, score]. Example: {"scores": [[0, 8], [1, 3], [2, 9]]}
Include every document index. Output only the JSON object, nothing else.`;

		try {
			const response = await this.generate(model, prompt, { temperature: 0, format: 'json' });
			const parsed = this.parseRerankResponse(response, candidates.length);

			if (parsed.length === 0) {
				this.log('warn', `Rerank: failed to parse any scores, returning original order`);
				return candidates.map((c, i) => ({ index: c.index, score: candidates.length - i }));
			}

			// Sort by score descending, limit to topK
			parsed.sort((a, b) => b.score - a.score);
			return parsed.slice(0, topK);
		} catch (err) {
			this.log('error', `Rerank failed: ${(err as Error).message}`);
			// Graceful degradation: return original order
			return candidates.map((c, i) => ({ index: c.index, score: candidates.length - i }));
		}
	}

	/**
	 * Parse the LLM's re-ranking response. Tries JSON first, then regex fallback.
	 */
	private parseRerankResponse(response: string, expectedCount: number): Array<{ index: number; score: number }> {
		// Try JSON parsing first
		try {
			const data = JSON.parse(response);
			const scores: Array<{ index: number; score: number }> = [];

			// Handle {"scores": [[0, 8], [1, 3], ...]}
			const arr = data.scores ?? data.results ?? data;
			if (Array.isArray(arr)) {
				for (const item of arr) {
					if (Array.isArray(item) && item.length >= 2) {
						const idx = Number(item[0]);
						const score = Number(item[1]);
						if (!isNaN(idx) && !isNaN(score)) {
							scores.push({ index: idx, score });
						}
					} else if (item && typeof item === 'object' && 'index' in item && 'score' in item) {
						scores.push({ index: Number(item.index), score: Number(item.score) });
					}
				}
			}

			if (scores.length > 0) return scores;
		} catch {
			// JSON parsing failed, try regex
		}

		// Regex fallback: match patterns like "0: 8" or "0:8" or "[0] 8"
		const scores: Array<{ index: number; score: number }> = [];
		const regex = /\[?(\d+)\]?\s*[:\-=]\s*(\d+(?:\.\d+)?)/g;
		let match;
		while ((match = regex.exec(response)) !== null) {
			scores.push({ index: Number(match[1]), score: Number(match[2]) });
		}

		return scores;
	}

}
