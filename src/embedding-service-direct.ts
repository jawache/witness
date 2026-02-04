/**
 * EmbeddingService - Direct execution (no Web Worker)
 *
 * Uses dynamic import to load transformers.js from CDN.
 * Explicitly loads onnxruntime-web first to ensure WASM backend is available.
 */

// Embedding model configuration
const MODEL_NAME = 'TaylorAI/bge-micro-v2';
const MODEL_DIMENSIONS = 384;

// CDN URLs
const ONNX_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort.min.js';
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

interface ModelInfo {
  model: string;
  dimensions: number;
}

interface ProgressInfo {
  status: string;
  progress?: number;
}

// Extend window for dynamically loaded globals
declare global {
  interface Window {
    ort?: any;
  }
}

export class EmbeddingServiceDirect {
  private embedder: any = null;
  private modelInfo: ModelInfo | null = null;
  private progressCallback: ((info: ProgressInfo) => void) | null = null;
  private initializing: Promise<void> | null = null;
  private transformers: any = null;
  private onnxLoaded = false;

  constructor() {
    // No initialization needed - will load dynamically
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
   * Load onnxruntime-web via script tag (sets window.ort)
   */
  private async loadOnnxRuntime(): Promise<void> {
    if (this.onnxLoaded || window.ort) {
      this.onnxLoaded = true;
      return;
    }

    this.reportProgress('Loading ONNX runtime...');

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ONNX_CDN;
      script.async = true;

      script.onload = () => {
        if (window.ort) {
          this.onnxLoaded = true;
          this.reportProgress('ONNX runtime loaded');

          // Set WASM paths
          try {
            window.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/';
          } catch (e) {
            console.warn('Could not set WASM paths:', e);
          }

          resolve();
        } else {
          reject(new Error('ort global not found after loading'));
        }
      };

      script.onerror = (error) => {
        reject(new Error(`Failed to load onnxruntime-web: ${error}`));
      };

      document.head.appendChild(script);
    });
  }

  /**
   * Load transformers.js using dynamic import
   */
  private async loadTransformers(): Promise<any> {
    if (this.transformers) {
      return this.transformers;
    }

    // Load ONNX runtime first
    await this.loadOnnxRuntime();

    this.reportProgress('Loading transformers.js from CDN...');

    try {
      // Use dynamic import with the CDN URL
      this.transformers = await import(/* webpackIgnore: true */ `${TRANSFORMERS_CDN}`);
      this.reportProgress('transformers.js loaded successfully');
      return this.transformers;
    } catch (error) {
      this.reportProgress(`Failed to load transformers.js: ${error}`);
      throw new Error(`Failed to load transformers.js: ${error}`);
    }
  }

  /**
   * Initialize the embedding model
   */
  async initialize(): Promise<ModelInfo> {
    if (this.modelInfo && this.embedder) {
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

  private async doInitialize(): Promise<void> {
    try {
      // Load transformers.js dynamically (includes loading ONNX first)
      const transformers = await this.loadTransformers();

      // Configure environment for Electron/browser
      if (transformers.env) {
        transformers.env.allowLocalModels = false;
        transformers.env.useBrowserCache = true;
      }

      this.reportProgress('Loading embedding model...');

      this.embedder = await transformers.pipeline('feature-extraction', MODEL_NAME, {
        progress_callback: (progress: { status: string; progress?: number }) => {
          this.reportProgress(progress.status, progress.progress);
        },
      });

      this.modelInfo = {
        model: MODEL_NAME,
        dimensions: MODEL_DIMENSIONS,
      };

      this.reportProgress('Model ready');
    } catch (error) {
      this.reportProgress(`Model loading failed: ${error}`);
      throw new Error(`Failed to initialize embedding model: ${error}`);
    }
  }

  /**
   * Generate embedding for text
   */
  async embed(text: string): Promise<number[]> {
    if (!this.embedder) {
      await this.initialize();
    }

    const output = await this.embedder!(text, {
      pooling: 'mean',
      normalize: true,
    });

    return Array.from(output.data as Float32Array);
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
   * Get information about the loaded model
   */
  getModelInfo(): ModelInfo | null {
    return this.modelInfo;
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.embedder !== null && this.modelInfo !== null;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.embedder = null;
    this.modelInfo = null;
    this.progressCallback = null;
    this.initializing = null;
  }
}
