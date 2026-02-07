/**
 * Ollama embedding provider.
 * Calls Ollama's /api/embed endpoint for generating embeddings.
 */

export interface OllamaProviderConfig {
	baseUrl?: string;
	model?: string;
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

export class OllamaProvider {
	private baseUrl: string;
	private model: string;

	constructor(config?: OllamaProviderConfig) {
		this.baseUrl = config?.baseUrl || 'http://localhost:11434';
		this.model = config?.model || 'nomic-embed-text';
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
					if (data.total && data.completed) {
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
		const res = await fetch(`${this.baseUrl}/api/embed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: this.model, input: texts }),
		});

		if (!res.ok) {
			const body = await res.text();
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

	getModel(): string {
		return this.model;
	}

	getDimensions(): number {
		return MODEL_DIMENSIONS[this.model.split(':')[0]] || 768;
	}

	/**
	 * Get dimensions by querying /api/show if not in the hardcoded map.
	 * Falls back to the static map, then to 768.
	 */
	async getDimensionsAsync(): Promise<number> {
		const baseName = this.model.split(':')[0];
		if (MODEL_DIMENSIONS[baseName]) return MODEL_DIMENSIONS[baseName];

		try {
			const res = await fetch(`${this.baseUrl}/api/show`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: this.model }),
			});
			if (res.ok) {
				const data = (await res.json()) as OllamaShowResponse;
				const embLen = Object.entries(data.model_info || {})
					.find(([k]) => k.includes('embedding_length'));
				if (embLen) return embLen[1] as number;
			}
		} catch { /* fall through */ }

		return 768;
	}
}
