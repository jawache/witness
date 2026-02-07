/**
 * Ollama embedding provider.
 * Calls Ollama's /api/embed endpoint for generating embeddings.
 */

export interface OllamaProviderConfig {
	baseUrl?: string;
	model?: string;
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
		return MODEL_DIMENSIONS[this.model] || 768;
	}
}
