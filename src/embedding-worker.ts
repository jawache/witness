/**
 * Web Worker for generating embeddings using transformers.js
 *
 * Uses importScripts to load transformers.js from CDN at runtime.
 */

// Embedding model configuration
const MODEL_NAME = 'TaylorAI/bge-micro-v2';
const MODEL_DIMENSIONS = 384;

// CDN URL for transformers.js
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Declare global types for the loaded library
declare const Transformers: any;
declare function importScripts(...urls: string[]): void;

// Pipeline instance (lazy loaded)
let embedder: any = null;
let transformersLoaded = false;

function postProgress(status: string, progress?: number) {
  self.postMessage({ type: 'progress', status, progress });
}

/**
 * Load transformers.js from CDN using importScripts
 */
async function loadTransformers(): Promise<void> {
  if (transformersLoaded) return;

  postProgress('Loading transformers.js from CDN...');

  try {
    // Use importScripts for classic workers
    importScripts(`${TRANSFORMERS_URL}/dist/transformers.min.js`);
    transformersLoaded = true;
    postProgress('transformers.js loaded successfully');
  } catch (e) {
    postProgress(`Failed to load transformers.js: ${e}`);
    throw new Error(`Failed to load transformers.js: ${e}`);
  }
}

/**
 * Initialize the embedding model
 */
async function initEmbedder(): Promise<any> {
  if (embedder) return embedder;

  await loadTransformers();

  // Access the global Transformers object that importScripts creates
  const transformers = (self as any).Transformers || (self as any).transformers;
  if (!transformers) {
    throw new Error('Transformers library not found after loading');
  }

  // Configure environment
  if (transformers.env) {
    transformers.env.allowLocalModels = false;
  }

  postProgress('Loading embedding model...');

  embedder = await transformers.pipeline('feature-extraction', MODEL_NAME, {
    progress_callback: (progress: { status: string; progress?: number }) => {
      postProgress(progress.status, progress.progress);
    },
  });

  postProgress('Model ready');
  return embedder;
}

/**
 * Generate embedding for text
 */
async function embed(text: string): Promise<number[]> {
  const model = await initEmbedder();

  const output = await model(text, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(output.data as Float32Array);
}

// Message handler
interface WorkerMessage {
  type: string;
  id: string;
  text?: string;
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type, id } = event.data;

  try {
    switch (type) {
      case 'ping':
        self.postMessage({ type: 'pong', id });
        break;

      case 'init':
        await initEmbedder();
        self.postMessage({
          type: 'ready',
          id,
          model: MODEL_NAME,
          dimensions: MODEL_DIMENSIONS,
        });
        break;

      case 'embed':
        const { text } = event.data;
        if (!text) {
          throw new Error('No text provided for embedding');
        }
        const embedding = await embed(text);
        self.postMessage({
          type: 'result',
          id,
          embedding,
        });
        break;

      default:
        self.postMessage({
          type: 'error',
          id,
          error: `Unknown message type: ${type}`,
        });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Signal that worker is loaded
postProgress(`Worker script loaded, WebAssembly: ${typeof WebAssembly !== 'undefined' ? 'available' : 'unavailable'}`);
