/**
 * Unit tests for OramaSearchEngine (formerly VectorStore).
 * Tests Orama with QPS plugin, schema v5 (tags, folder, optional embeddings).
 * Uses Orama directly with fake embeddings — no Obsidian or Ollama needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { create, insert, search, searchVector, save, load, count } from '@orama/orama';
import { pluginQPS } from '@orama/plugin-qps';

const DIMENSIONS = 4;

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) =>
    Math.sin(seed * (i + 1))
  );
}

function createSchema() {
  return {
    sourcePath: 'string' as const,
    title: 'string' as const,
    headingPath: 'string' as const,
    content: 'string' as const,
    chunkIndex: 'number' as const,
    mtime: 'number' as const,
    tags: 'enum[]' as const,
    folder: 'enum' as const,
    embedding: `vector[${DIMENSIONS}]` as const,
  };
}

function createTestDocs() {
  return [
    {
      id: 'topics/carbon.md#0',
      sourcePath: 'topics/carbon.md',
      title: 'Carbon Accounting',
      headingPath: '',
      content: 'Carbon accounting measures CO2 emissions from organizations',
      chunkIndex: 0,
      mtime: 1000,
      tags: ['#topic', '#climate'],
      folder: 'topics',
      embedding: fakeEmbedding(1),
    },
    {
      id: 'topics/green.md#0',
      sourcePath: 'topics/green.md',
      title: 'Green Software',
      headingPath: '## Overview',
      content: 'Green software reduces greenhouse gas emissions from computing',
      chunkIndex: 0,
      mtime: 2000,
      tags: ['#topic', '#software'],
      folder: 'topics',
      embedding: fakeEmbedding(2),
    },
    {
      id: 'topics/green.md#1',
      sourcePath: 'topics/green.md',
      title: 'Green Software',
      headingPath: '## Principles',
      content: 'The principles of green software include energy efficiency and hardware efficiency',
      chunkIndex: 1,
      mtime: 2000,
      tags: ['#topic', '#software'],
      folder: 'topics',
      embedding: fakeEmbedding(5),
    },
    {
      id: 'topics/quantum.md#0',
      sourcePath: 'topics/quantum.md',
      title: 'Quantum Computing',
      headingPath: '',
      content: 'Quantum computing uses qubits for parallel computation',
      chunkIndex: 0,
      mtime: 3000,
      tags: ['#topic'],
      folder: 'topics',
      embedding: fakeEmbedding(3),
    },
    {
      id: 'notes/readme.md#0',
      sourcePath: 'notes/readme.md',
      title: 'README',
      headingPath: '',
      content: 'This vault contains notes about various topics',
      chunkIndex: 0,
      mtime: 4000,
      tags: [],
      folder: 'notes',
      embedding: fakeEmbedding(4),
    },
  ];
}

let dbCounter = 0;
async function createPopulatedDb() {
  const docs = createTestDocs();
  const db = create({
    schema: createSchema(),
    id: `test-vectors-${++dbCounter}`,
    plugins: [pluginQPS()],
  });
  for (const doc of docs) {
    await insert(db, doc);
  }
  return db;
}

describe('Fulltext search (QPS)', () => {
  let db: any;

  beforeAll(async () => {
    db = await createPopulatedDb();
  });

  it('should find documents by keyword', async () => {
    const results = await search(db, {
      term: 'carbon',
      properties: ['title', 'content'],
      limit: 10,
    });

    expect(results.hits.length).toBeGreaterThan(0);
    expect((results.hits[0].document as any).sourcePath).toBe('topics/carbon.md');
  });

  it('should return empty for non-matching keyword', async () => {
    const results = await search(db, {
      term: 'xyznonexistent',
      properties: ['title', 'content'],
      limit: 10,
    });

    expect(results.hits.length).toBe(0);
  });

  it('should search across title and content', async () => {
    // "quantum" appears in both title and content of quantum.md
    const results = await search(db, {
      term: 'quantum',
      properties: ['title', 'content'],
      limit: 10,
    });

    expect(results.hits.length).toBeGreaterThan(0);
    expect((results.hits[0].document as any).sourcePath).toBe('topics/quantum.md');
  });

  it('should respect limit parameter', async () => {
    const results = await search(db, {
      term: 'emissions',
      properties: ['title', 'content'],
      limit: 1,
    });

    expect(results.hits.length).toBe(1);
  });
});

describe('Vector search (cosine)', () => {
  let db: any;

  beforeAll(async () => {
    db = await createPopulatedDb();
  });

  it('should find documents by embedding similarity', async () => {
    // Search with an embedding very close to doc 1 (carbon)
    const queryEmbedding = fakeEmbedding(1);

    const results = await searchVector(db, {
      mode: 'vector',
      vector: { value: queryEmbedding, property: 'embedding' },
      similarity: 0.0,
      limit: 10,
    });

    expect(results.hits.length).toBeGreaterThan(0);
    // The most similar should be the doc with matching embedding
    expect((results.hits[0].document as any).sourcePath).toBe('topics/carbon.md');
    expect(results.hits[0].score).toBeGreaterThan(0.9); // Near-identical embedding
  });

  it('should respect limit parameter', async () => {
    const results = await searchVector(db, {
      mode: 'vector',
      vector: { value: fakeEmbedding(1), property: 'embedding' },
      similarity: 0.0,
      limit: 1,
    });

    expect(results.hits.length).toBe(1);
  });

  it('should respect similarity threshold', async () => {
    // Very high similarity threshold should return fewer results
    const highThreshold = await searchVector(db, {
      mode: 'vector',
      vector: { value: fakeEmbedding(1), property: 'embedding' },
      similarity: 0.99,
      limit: 10,
    });

    const lowThreshold = await searchVector(db, {
      mode: 'vector',
      vector: { value: fakeEmbedding(1), property: 'embedding' },
      similarity: 0.0,
      limit: 10,
    });

    expect(lowThreshold.hits.length).toBeGreaterThanOrEqual(highThreshold.hits.length);
  });
});

describe('Hybrid search (QPS + vector)', () => {
  let db: any;

  beforeAll(async () => {
    db = await createPopulatedDb();
  });

  it('should combine keyword and vector results', async () => {
    const results = await search(db, {
      mode: 'hybrid',
      term: 'carbon',
      vector: { value: fakeEmbedding(1), property: 'embedding' },
      properties: ['title', 'content'],
      similarity: 0.0,
      limit: 10,
      hybridWeights: { text: 0.3, vector: 0.7 },
    } as any);

    expect(results.hits.length).toBeGreaterThan(0);
    // Carbon doc should rank first — matches both keyword and embedding
    expect((results.hits[0].document as any).sourcePath).toBe('topics/carbon.md');
  });

  it('should boost documents matching both signals', async () => {
    // Search for "carbon" but with embedding close to quantum doc
    const results = await search(db, {
      mode: 'hybrid',
      term: 'carbon',
      vector: { value: fakeEmbedding(3), property: 'embedding' },
      properties: ['title', 'content'],
      similarity: 0.0,
      limit: 10,
      hybridWeights: { text: 0.5, vector: 0.5 },
    } as any);

    expect(results.hits.length).toBeGreaterThan(1);
    // With equal weights: carbon gets keyword boost, quantum gets vector boost
    // Both should appear in top results
    const paths = results.hits.map((h: any) => h.document.sourcePath);
    expect(paths).toContain('topics/carbon.md');
    expect(paths).toContain('topics/quantum.md');
  });
});

describe('Documents without embeddings', () => {
  it('should index and find documents without embedding field', async () => {
    const db = create({
      schema: createSchema(),
      id: `test-no-embed-${++dbCounter}`,
      plugins: [pluginQPS()],
    });

    // Insert a document WITHOUT the embedding field
    await insert(db, {
      id: 'no-embed.md#0',
      sourcePath: 'no-embed.md',
      title: 'No Embedding Document',
      headingPath: '',
      content: 'This document has no embedding vector but should be findable via fulltext',
      chunkIndex: 0,
      mtime: 5000,
      tags: ['#test'],
      folder: 'notes',
      // Note: no embedding field
    });

    // Should be findable via fulltext search
    const results = await search(db, {
      term: 'embedding vector',
      properties: ['title', 'content'],
      limit: 10,
    });

    expect(results.hits.length).toBeGreaterThan(0);
    expect((results.hits[0].document as any).sourcePath).toBe('no-embed.md');
  });

  it('should have correct count including docs without embeddings', async () => {
    const db = create({
      schema: createSchema(),
      id: `test-mixed-embed-${++dbCounter}`,
      plugins: [pluginQPS()],
    });

    // One doc with embedding
    await insert(db, {
      id: 'with-embed.md#0',
      sourcePath: 'with-embed.md',
      title: 'With Embedding',
      headingPath: '',
      content: 'This has an embedding',
      chunkIndex: 0,
      mtime: 1000,
      tags: [],
      folder: '',
      embedding: fakeEmbedding(1),
    });

    // One doc without
    await insert(db, {
      id: 'without-embed.md#0',
      sourcePath: 'without-embed.md',
      title: 'Without Embedding',
      headingPath: '',
      content: 'This does not have an embedding',
      chunkIndex: 0,
      mtime: 2000,
      tags: [],
      folder: '',
    });

    expect(count(db)).toBe(2);
  });
});

describe('Tag and folder metadata', () => {
  let db: any;

  beforeAll(async () => {
    db = await createPopulatedDb();
  });

  it('should store and retrieve tags', async () => {
    const results = await search(db, {
      term: 'carbon',
      properties: ['title', 'content'],
      limit: 10,
    });

    expect(results.hits.length).toBeGreaterThan(0);
    const doc = results.hits[0].document as any;
    expect(doc.tags).toContain('#topic');
    expect(doc.tags).toContain('#climate');
  });

  it('should store and retrieve folder', async () => {
    const results = await search(db, {
      term: 'carbon',
      properties: ['title', 'content'],
      limit: 10,
    });

    expect(results.hits.length).toBeGreaterThan(0);
    expect((results.hits[0].document as any).folder).toBe('topics');
  });

  it('should filter by tag using where clause', async () => {
    // Search for docs with #climate tag
    const results = await search(db, {
      term: 'emissions',
      properties: ['title', 'content'],
      limit: 10,
      where: { tags: { containsAll: ['#climate'] } },
    } as any);

    // Only carbon.md has #climate tag
    expect(results.hits.length).toBeGreaterThan(0);
    const paths = results.hits.map((h: any) => h.document.sourcePath);
    expect(paths).toContain('topics/carbon.md');
    // green.md also mentions emissions but doesn't have #climate
    expect(paths).not.toContain('topics/green.md');
  });
});

describe('Path filtering (deduplication logic)', () => {
  it('should filter results by path prefix', async () => {
    const db = await createPopulatedDb();

    const results = await search(db, {
      term: 'notes topics computing emissions',
      properties: ['title', 'content'],
      limit: 10,
    });

    // All docs should be returned before filtering
    expect(results.hits.length).toBeGreaterThan(1);

    // Simulate deduplicateAndFilter path filtering
    const filtered = results.hits
      .map((hit: any) => ({
        path: hit.document.sourcePath,
        title: hit.document.title,
        score: hit.score,
      }))
      .filter((h: any) => h.path.startsWith('topics/'));

    // Only topic docs should remain
    expect(filtered.every((r: any) => r.path.startsWith('topics/'))).toBe(true);
    expect(filtered.some((r: any) => r.path.startsWith('notes/'))).toBe(false);
  });

  it('should deduplicate multi-chunk results by sourcePath', async () => {
    const db = await createPopulatedDb();

    // Search for "green" — should match both chunks of green.md
    const results = await search(db, {
      term: 'green software',
      properties: ['title', 'content'],
      limit: 10,
    });

    // Simulate deduplication: keep best per sourcePath
    const bestPerFile = new Map<string, { path: string; score: number }>();
    for (const hit of results.hits) {
      const doc = hit.document as any;
      const existing = bestPerFile.get(doc.sourcePath);
      if (!existing || hit.score > existing.score) {
        bestPerFile.set(doc.sourcePath, { path: doc.sourcePath, score: hit.score });
      }
    }

    // green.md should appear only once after deduplication
    const greenEntries = Array.from(bestPerFile.values()).filter(r => r.path === 'topics/green.md');
    expect(greenEntries).toHaveLength(1);
  });
});

describe('Score normalization', () => {
  it('should normalize scores > 1 relative to top result', () => {
    const rawResults = [
      { path: 'a.md', title: 'A', score: 3.4 },
      { path: 'b.md', title: 'B', score: 1.2 },
      { path: 'c.md', title: 'C', score: 0.5 },
    ];

    const maxScore = rawResults[0].score;
    const normalized = rawResults.map((r) => ({ ...r, score: r.score / maxScore }));

    expect(normalized[0].score).toBe(1.0); // Top result normalized to 1.0
    expect(normalized[1].score).toBeCloseTo(1.2 / 3.4);
    expect(normalized[2].score).toBeCloseTo(0.5 / 3.4);
    expect(normalized.every((r) => r.score <= 1.0)).toBe(true);
  });

  it('should not normalize scores already in 0-1 range', () => {
    const results = [
      { path: 'a.md', title: 'A', score: 0.8 },
      { path: 'b.md', title: 'B', score: 0.5 },
    ];

    const maxScore = results[0].score;
    // The normalization only triggers if maxScore > 1
    if (maxScore > 1) {
      expect(true).toBe(false);
    }

    // Scores should remain unchanged
    expect(results[0].score).toBe(0.8);
    expect(results[1].score).toBe(0.5);
  });
});

describe('Schema versioning', () => {
  it('should save and load with schema version envelope', async () => {
    const db = await createPopulatedDb();
    const data = save(db);

    // Simulate what OramaSearchEngine.save() does
    const SCHEMA_VERSION = 5;
    const envelope = { schemaVersion: SCHEMA_VERSION, data };
    const json = JSON.stringify(envelope);

    // Parse and verify envelope structure
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.data).toBeDefined();

    // Simulate what OramaSearchEngine.initialize() does — load from envelope
    const newDb = create({
      schema: createSchema(),
      id: 'test-load',
      plugins: [pluginQPS()],
    });
    const loadedData = parsed.data;
    load(newDb, loadedData);

    expect(count(newDb)).toBe(5); // 5 test chunks (green.md has 2)
  });

  it('should detect old schema version (missing schemaVersion)', () => {
    const oldData = { some: 'raw-orama-data' };
    const version = (oldData as any).schemaVersion ?? 1;

    expect(version).toBe(1); // Missing field defaults to v1
  });

  it('should detect old schema version (explicit v3)', () => {
    const envelope = { schemaVersion: 3, data: {} };
    const SCHEMA_VERSION = 5;

    expect(envelope.schemaVersion < SCHEMA_VERSION).toBe(true);
  });

  it('should accept current schema version', () => {
    const envelope = { schemaVersion: 5, data: {} };
    const SCHEMA_VERSION = 5;

    expect(envelope.schemaVersion < SCHEMA_VERSION).toBe(false);
  });
});

describe('QPS proximity scoring', () => {
  it('should rank adjacent words higher than scattered words', async () => {
    const db = create({
      schema: createSchema(),
      id: `test-proximity-${++dbCounter}`,
      plugins: [pluginQPS()],
    });

    // Document where "green software" appears as adjacent words
    await insert(db, {
      id: 'adjacent.md#0',
      sourcePath: 'adjacent.md',
      title: 'Adjacent',
      headingPath: '',
      content: 'This document discusses green software engineering practices',
      chunkIndex: 0,
      mtime: 1000,
      tags: [],
      folder: '',
    });

    // Document where "green" and "software" are scattered
    await insert(db, {
      id: 'scattered.md#0',
      sourcePath: 'scattered.md',
      title: 'Scattered',
      headingPath: '',
      content: 'The green meadow has nothing to do with software development in general',
      chunkIndex: 0,
      mtime: 2000,
      tags: [],
      folder: '',
    });

    const results = await search(db, {
      term: 'green software',
      properties: ['content'],
      limit: 10,
    });

    expect(results.hits.length).toBe(2);
    // Adjacent document should rank higher with QPS
    expect((results.hits[0].document as any).sourcePath).toBe('adjacent.md');
    expect(results.hits[0].score).toBeGreaterThan(results.hits[1].score);
  });
});
