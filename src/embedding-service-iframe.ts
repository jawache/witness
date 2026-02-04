/**
 * EmbeddingService - Iframe-based execution
 *
 * Runs transformers.js inside a hidden iframe to avoid Electron's hybrid
 * Node.js/browser environment issues. The iframe provides a clean browser
 * context where WASM can initialize properly.
 *
 * Based on Smart Connections' approach.
 */

// Embedding model configuration
const MODEL_NAME = 'TaylorAI/bge-micro-v2';
const MODEL_DIMENSIONS = 384;
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0';

// Throttling configuration
const DEFAULT_THROTTLE_MS = 50;  // Delay between embed calls
const GPU_ERROR_THRESHOLD = 5;   // Switch to WASM after this many GPU errors

interface ModelInfo {
  model: string;
  dimensions: number;
  backend: 'webgpu' | 'wasm';
}

interface ProgressInfo {
  status: string;
  progress?: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export interface EmbeddingServiceOptions {
  /** GPU mode: 'auto' tries GPU first with fallback, 'always' forces GPU, 'never' uses WASM only */
  gpuMode?: 'auto' | 'always' | 'never';
  /** Delay in ms between embed calls to reduce memory pressure (0 = no throttling) */
  throttleMs?: number;
}

/**
 * Connector script that runs inside the iframe.
 * This is a pure browser context without Node.js APIs.
 */
const IFRAME_CONNECTOR = `
let pipeline = null;
let tokenizer = null;
let modelLoaded = false;

async function loadModel(modelKey, useGpu) {
  const transformers = await import('${TRANSFORMERS_CDN}');

  transformers.env.allowLocalModels = false;
  if (typeof transformers.env.useBrowserCache !== 'undefined') {
    transformers.env.useBrowserCache = true;
  }

  // Try WebGPU first, then fall back to WASM
  // NOTE: q8 quantized has a bug with repeated calls, so we skip it and use non-quantized WASM
  const configs = [
    { device: 'webgpu', dtype: 'fp16', quantized: false },
    { device: 'webgpu', dtype: 'fp32', quantized: false },
    // { dtype: 'q8', quantized: true },  // DISABLED: WASM error on repeated calls
    { quantized: false },  // WASM auto fallback
  ];

  let lastError = null;

  for (const config of configs) {
    if (config.device === 'webgpu' && !useGpu) continue;
    if (config.device === 'webgpu') {
      // Check WebGPU availability
      if (!('gpu' in navigator)) continue;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) continue;
    }

    try {
      console.log('[Iframe Embed] Trying config:', config);
      window.parent.postMessage({ type: 'progress', status: 'Trying ' + JSON.stringify(config) }, '*');
      pipeline = await transformers.pipeline('feature-extraction', modelKey, config);
      console.log('[Iframe Embed] Pipeline loaded with config:', config);
      break;
    } catch (err) {
      console.warn('[Iframe Embed] Config failed:', config, err);
      lastError = err;
    }
  }

  if (!pipeline) {
    throw lastError || new Error('Failed to load pipeline');
  }

  tokenizer = await transformers.AutoTokenizer.from_pretrained(modelKey);
  modelLoaded = true;

  return { loaded: true };
}

async function embed(text) {
  if (!pipeline) throw new Error('Model not loaded');

  const output = await pipeline(text, { pooling: 'mean', normalize: true });
  return Array.from(output[0].data).map(v => Math.round(v * 1e8) / 1e8);
}

async function countTokens(text) {
  if (!tokenizer) throw new Error('Model not loaded');
  const { input_ids } = await tokenizer(text);
  return input_ids.data.length;
}

// Message handler
window.addEventListener('message', async (event) => {
  const { id, method, params } = event.data;
  if (!id || !method) return;

  try {
    let result;

    switch (method) {
      case 'load':
        window.parent.postMessage({ type: 'progress', status: 'Loading transformers.js...' }, '*');
        result = await loadModel(params.modelKey, params.useGpu);
        break;

      case 'embed':
        result = await embed(params.text);
        break;

      case 'count_tokens':
        result = await countTokens(params.text);
        break;

      case 'ping':
        result = { pong: true, modelLoaded };
        break;

      default:
        throw new Error('Unknown method: ' + method);
    }

    window.parent.postMessage({ id, result }, '*');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    window.parent.postMessage({ type: 'progress', status: 'IFRAME ERROR: ' + errorMsg }, '*');
    window.parent.postMessage({ id, error: errorMsg || 'Unknown error' }, '*');
  }
});

// Signal ready
window.parent.postMessage({ type: 'ready' }, '*');
`;

export class EmbeddingServiceIframe {
  private iframe: HTMLIFrameElement | null = null;
  private modelInfo: ModelInfo | null = null;
  private progressCallback: ((info: ProgressInfo) => void) | null = null;
  private initializing: Promise<void> | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  // Configuration options
  private gpuMode: 'auto' | 'always' | 'never';
  private throttleMs: number;

  // GPU error tracking for auto-fallback
  private gpuErrors = 0;
  private gpuDisabled = false;
  private lastEmbedTime = 0;

  constructor(options: EmbeddingServiceOptions = {}) {
    this.gpuMode = options.gpuMode ?? 'auto';
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;

    // Set up ready promise
    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve;
    });
  }

  /**
   * Set a callback for progress updates during model loading
   */
  onProgress(callback: (info: ProgressInfo) => void): void {
    this.progressCallback = callback;
  }

  private reportProgress(status: string, progress?: number): void {
    if (this.progressCallback) {
      this.progressCallback({ status, progress });
    }
    console.log(`[EmbeddingService] ${status}${progress !== undefined ? ` (${progress}%)` : ''}`);
  }

  /**
   * Create the iframe with the connector script
   */
  private createIframe(): void {
    // Remove existing iframe if any
    const existing = document.getElementById('witness-embed-iframe');
    if (existing) {
      existing.remove();
    }

    this.iframe = document.createElement('iframe');
    this.iframe.id = 'witness-embed-iframe';
    this.iframe.style.display = 'none';

    // Set up message listener before creating iframe content
    window.addEventListener('message', this.handleMessage.bind(this));

    // Create iframe content with connector script
    this.iframe.srcdoc = `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body>
          <script type="module">
            ${IFRAME_CONNECTOR}
          </script>
        </body>
      </html>
    `;

    document.body.appendChild(this.iframe);
  }

  /**
   * Handle messages from the iframe
   */
  private handleMessage = (event: MessageEvent): void => {
    const data = event.data;
    if (!data) return;

    // Handle progress messages
    if (data.type === 'progress') {
      this.reportProgress(data.status, data.progress);
      return;
    }

    // Handle ready signal
    if (data.type === 'ready') {
      this.ready = true;
      if (this.readyResolve) {
        this.readyResolve();
      }
      return;
    }

    // Handle response messages
    if (data.id && this.pending.has(data.id)) {
      const { resolve, reject } = this.pending.get(data.id)!;
      this.pending.delete(data.id);

      console.log('[EmbeddingService] Received response for id:', data.id, 'error:', data.error, 'result type:', typeof data.result, 'isArray:', Array.isArray(data.result), 'length:', data.result?.length);

      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result);
      }
    }
  };

  /**
   * Send a message to the iframe and wait for response
   */
  private async sendMessage(method: string, params: any = {}): Promise<any> {
    console.log('[EmbeddingService] sendMessage called:', method, 'iframe exists:', !!this.iframe, 'contentWindow exists:', !!this.iframe?.contentWindow);
    if (!this.iframe?.contentWindow) {
      throw new Error('Iframe not initialized');
    }

    // Wait for iframe to be ready
    console.log('[EmbeddingService] Waiting for ready promise, ready state:', this.ready);
    await this.readyPromise;
    console.log('[EmbeddingService] Ready promise resolved');

    const id = crypto.randomUUID();
    console.log('[EmbeddingService] Posting message with id:', id, 'method:', method);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.iframe!.contentWindow!.postMessage({ id, method, params }, '*');

      // Timeout after 120 seconds (model download can be slow)
      setTimeout(() => {
        if (this.pending.has(id)) {
          console.log('[EmbeddingService] Request timed out for id:', id);
          this.pending.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 120000);
    });
  }

  /**
   * Initialize the embedding model
   */
  async initialize(): Promise<ModelInfo> {
    if (this.modelInfo) {
      return this.modelInfo;
    }

    // Prevent multiple simultaneous initializations
    if (this.initializing) {
      await this.initializing;
      return this.modelInfo!;
    }

    this.initializing = this.doInitialize();
    await this.initializing;
    this.initializing = null;

    return this.modelInfo!;
  }

  /**
   * Determine if GPU should be used based on mode and error history
   */
  private shouldUseGpu(): boolean {
    if (this.gpuMode === 'never') return false;
    if (this.gpuMode === 'always') return true;
    // Auto mode: use GPU unless we've hit too many errors
    return !this.gpuDisabled;
  }

  private async doInitialize(): Promise<void> {
    this.reportProgress('Creating iframe environment...');

    // Create iframe
    this.createIframe();

    // Wait for iframe to be ready
    await this.readyPromise;

    const useGpu = this.shouldUseGpu();
    const backend = useGpu ? 'webgpu' : 'wasm';
    this.reportProgress(`Iframe ready, loading model (${backend} mode)...`);

    try {
      await this.sendMessage('load', {
        modelKey: MODEL_NAME,
        useGpu,
      });

      this.modelInfo = {
        model: MODEL_NAME,
        dimensions: MODEL_DIMENSIONS,
        backend: useGpu ? 'webgpu' : 'wasm',
      };

      this.reportProgress(`Model ready (${this.modelInfo.backend})`);
    } catch (error) {
      this.reportProgress(`Model loading failed: ${error}`);
      throw new Error(`Failed to initialize embedding model: ${error}`);
    }
  }

  private embedCallCount = 0;
  private consecutiveErrors = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 2;

  /**
   * Reset the iframe completely (for WASM error recovery)
   */
  private async resetIframe(): Promise<void> {
    this.reportProgress('Resetting iframe due to WASM errors...');

    // Clean up old iframe
    window.removeEventListener('message', this.handleMessage);
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }

    // Reset state
    this.modelInfo = null;
    this.pending.clear();
    this.ready = false;
    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve;
    });
    this.initializing = null;

    // Reinitialize
    await this.initialize();
    this.reportProgress('Iframe reset complete');
  }

  /**
   * Apply throttling delay between calls
   */
  private async throttle(): Promise<void> {
    if (this.throttleMs <= 0) return;

    const now = Date.now();
    const elapsed = now - this.lastEmbedTime;
    if (elapsed < this.throttleMs) {
      await new Promise(resolve => setTimeout(resolve, this.throttleMs - elapsed));
    }
    this.lastEmbedTime = Date.now();
  }

  /**
   * Handle GPU error and potentially switch to WASM
   */
  private async handleGpuError(): Promise<boolean> {
    if (this.gpuMode !== 'auto' || this.gpuDisabled) return false;

    this.gpuErrors++;
    if (this.gpuErrors >= GPU_ERROR_THRESHOLD) {
      this.reportProgress(`GPU hit ${this.gpuErrors} errors, switching to WASM fallback...`);
      this.gpuDisabled = true;
      await this.resetIframe();  // Reinitialize with WASM
      return true;  // Caller should retry
    }
    return false;
  }

  /**
   * Generate embedding for text
   */
  async embed(text: string): Promise<number[]> {
    this.embedCallCount++;

    // Apply throttling to reduce memory pressure
    await this.throttle();

    const backend = this.modelInfo?.backend ?? 'unknown';
    this.reportProgress(`embed() #${this.embedCallCount} (${backend}), text length: ${text.length}`);

    if (!this.modelInfo) {
      this.reportProgress('Model not initialized, calling initialize()...');
      const info = await this.initialize();
      this.reportProgress(`After initialize(), backend: ${info.backend}`);
    }

    try {
      const result = await this.sendMessage('embed', { text });

      // Check if result is valid
      if (!result || !Array.isArray(result) || result.length !== MODEL_DIMENSIONS) {
        throw new Error(`Invalid embedding result: expected array of ${MODEL_DIMENSIONS}, got ${typeof result}`);
      }

      this.consecutiveErrors = 0;  // Reset error count on success
      return result;
    } catch (error) {
      this.consecutiveErrors++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.reportProgress(`embed() #${this.embedCallCount} failed (consecutive: ${this.consecutiveErrors}): ${errorMsg}`);

      // Check if we should switch to WASM fallback (GPU auto mode)
      if (this.modelInfo?.backend === 'webgpu') {
        const switched = await this.handleGpuError();
        if (switched) {
          // Retry with WASM backend
          return this.embed(text);
        }
      }

      // If we hit consecutive errors, reset the iframe and retry once
      if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        this.reportProgress('Multiple consecutive errors detected, resetting iframe...');
        await this.resetIframe();
        this.consecutiveErrors = 0;

        // Retry once after reset
        try {
          const result = await this.sendMessage('embed', { text });
          if (result && Array.isArray(result) && result.length === MODEL_DIMENSIONS) {
            this.reportProgress(`embed() retry after reset success`);
            return result;
          }
        } catch (retryError) {
          this.reportProgress(`embed() retry after reset also failed: ${retryError}`);
        }
      }

      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /**
   * Count tokens in text
   */
  async countTokens(text: string): Promise<number> {
    if (!this.modelInfo) {
      await this.initialize();
    }
    return await this.sendMessage('count_tokens', { text });
  }

  /**
   * Get information about the loaded model
   */
  getModelInfo(): ModelInfo | null {
    return this.modelInfo;
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.modelInfo !== null;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    window.removeEventListener('message', this.handleMessage);
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
    this.modelInfo = null;
    this.pending.clear();
    this.progressCallback = null;
    this.initializing = null;
    this.ready = false;
  }
}
