/**
 * EmbeddingService - Communicates with the embedding Web Worker
 *
 * This service manages the lifecycle of the embedding worker and provides
 * a simple async interface for generating embeddings.
 */

import { App, normalizePath } from 'obsidian';

// Types matching the worker's message protocol
interface WorkerMessage {
  type: string;
  id?: string;
  [key: string]: unknown;
}

interface EmbedResult {
  embedding: number[];
}

interface ModelInfo {
  model: string;
  dimensions: number;
}

interface ProgressInfo {
  status: string;
  progress?: number;
}

export class EmbeddingService {
  private worker: Worker | null = null;
  private pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();
  private progressCallback: ((info: ProgressInfo) => void) | null = null;
  private modelInfo: ModelInfo | null = null;
  private pluginDir: string;
  private app: App;

  constructor(app: App, pluginDir: string) {
    this.app = app;
    this.pluginDir = pluginDir;
  }

  /**
   * Set a callback for progress updates during model loading
   */
  onProgress(callback: (info: ProgressInfo) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Initialize the worker and load the model
   */
  async initialize(): Promise<ModelInfo> {
    if (this.worker) {
      if (this.modelInfo) return this.modelInfo;
      // Worker exists but not ready - wait for init
    }

    // Create the worker
    await this.createWorker();

    // Initialize the model
    const result = await this.sendMessage({ type: 'init' }) as ModelInfo;
    this.modelInfo = result;
    return result;
  }

  /**
   * Create the Web Worker
   */
  private async createWorker(): Promise<void> {
    // Construct path to worker file in plugin folder
    // In Obsidian, the plugin folder is at .obsidian/plugins/<plugin-id>/
    const workerPath = normalizePath(`${this.pluginDir}/embedding-worker.js`);

    // Get the vault's base path
    const adapter = this.app.vault.adapter;
    let fullWorkerPath: string;

    if ('basePath' in adapter) {
      // Desktop: FileSystemAdapter has basePath
      fullWorkerPath = `${(adapter as { basePath: string }).basePath}/${workerPath}`;
    } else {
      // Fallback for mobile or other adapters
      throw new Error('Embedding service requires desktop Obsidian');
    }

    // Create worker from file URL
    const workerUrl = `file://${fullWorkerPath}`;

    try {
      this.worker = new Worker(workerUrl);
      this.setupWorkerHandlers();
    } catch (error) {
      // Fallback: try loading worker code as blob
      console.warn('Direct worker load failed, trying blob approach:', error);
      await this.createWorkerFromBlob(fullWorkerPath);
    }
  }

  /**
   * Fallback: Load worker code and create from Blob URL
   */
  private async createWorkerFromBlob(workerPath: string): Promise<void> {
    const fs = require('fs').promises;
    const workerCode = await fs.readFile(workerPath, 'utf-8');
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    this.worker = new Worker(blobUrl);
    this.setupWorkerHandlers();
  }

  /**
   * Set up message handlers for the worker
   */
  private setupWorkerHandlers(): void {
    if (!this.worker) return;

    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { type, id } = event.data;

      // Handle progress updates (no id)
      if (type === 'progress') {
        if (this.progressCallback) {
          this.progressCallback(event.data as unknown as ProgressInfo);
        }
        return;
      }

      // Handle responses with id
      if (id && this.pending.has(id)) {
        const { resolve, reject } = this.pending.get(id)!;
        this.pending.delete(id);

        if (type === 'error') {
          reject(new Error(event.data.error as string));
        } else {
          resolve(event.data);
        }
      }
    };

    this.worker.onerror = (error: ErrorEvent) => {
      console.error('Embedding worker error:', error);
      // Reject all pending promises
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Worker error: ${error.message}`));
        this.pending.delete(id);
      }
    };
  }

  /**
   * Send a message to the worker and wait for response
   */
  private sendMessage(message: Omit<WorkerMessage, 'id'>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = crypto.randomUUID();
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  /**
   * Check if the worker is alive
   */
  async ping(): Promise<boolean> {
    if (!this.worker) return false;
    try {
      await this.sendMessage({ type: 'ping' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate embedding for a text
   */
  async embed(text: string): Promise<number[]> {
    if (!this.worker) {
      await this.initialize();
    }

    const result = await this.sendMessage({ type: 'embed', text }) as EmbedResult;
    return result.embedding;
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
    return this.worker !== null && this.modelInfo !== null;
  }

  /**
   * Terminate the worker and clean up
   */
  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.modelInfo = null;
    this.pending.clear();
    this.progressCallback = null;
  }
}
