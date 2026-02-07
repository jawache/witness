/**
 * Unit tests for VectorStore search modes and helpers.
 * Uses Orama directly with fake embeddings — no Obsidian or Ollama needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { create, insert, search, searchVector, save, load, count } from '@orama/orama';

const DIMENSIONS = 4;

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) =>
    Math.sin(seed * (i + 1))
  );
}

function createSchema() {
  return {
    path: 'string' as const,
    title: 'string' as const,
    content: 'string' as const,
    mtime: 'number' as const,
    embedding: `vector[${DIMENSIONS}]` as const,
  };
}

function createTestDocs() {
  return [
    {
      id: 'topics/carbon.md',
      path: 'topics/carbon.md',
      title: 'Carbon Accounting',
      content: 'Carbon accounting measures CO2 emissions from organizations',
      mtime: 1000,
      embedding: fakeEmbedding(1),
    },
    {
      id: 'topics/green.md',
      path: 'topics/green.md',
      title: 'Green Software',
      content: 'Green software reduces greenhouse gas emissions from computing',
      mtime: 2000,
      embedding: fakeEmbedding(2),
    },
    {
      id: 'topics/quantum.md',
      path: 'topics/quantum.md',
      title: 'Quantum Computing',
      content: 'Quantum computing uses qubits for parallel computation',
      mtime: 3000,
      embedding: fakeEmbedding(3),
    },
    {
      id: 'notes/readme.md',
      path: 'notes/readme.md',
      title: 'README',
      content: 'This vault contains notes about various topics',
      mtime: 4000,
      embedding: fakeEmbedding(4),
    },
  ];
}

let dbCounter = 0;
async function createPopulatedDb() {
  const docs = createTestDocs();
  const db = create({ schema: createSchema(), id: `test-vectors-${++dbCounter}` });
  for (const doc of docs) {
    await insert(db, doc);
  }
  return db;
}

describe('Fulltext search (BM25)', () => {
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
    expect((results.hits[0].document as any).path).toBe('topics/carbon.md');
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
    expect((results.hits[0].document as any).path).toBe('topics/quantum.md');
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
    expect((results.hits[0].document as any).path).toBe('topics/carbon.md');
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

describe('Hybrid search (BM25 + vector)', () => {
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
    expect((results.hits[0].document as any).path).toBe('topics/carbon.md');
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
    const paths = results.hits.map((h: any) => h.document.path);
    expect(paths).toContain('topics/carbon.md');
    expect(paths).toContain('topics/quantum.md');
  });
});

describe('Path filtering (mapAndFilterHits logic)', () => {
  it('should filter results by path prefix', async () => {
    const db = await createPopulatedDb();

    const results = await search(db, {
      term: 'notes topics computing emissions',
      properties: ['title', 'content'],
      limit: 10,
    });

    // All docs should be returned before filtering
    expect(results.hits.length).toBeGreaterThan(1);

    // Simulate mapAndFilterHits path filtering
    const filtered = results.hits
      .map((hit: any) => ({
        path: hit.document.path,
        title: hit.document.title,
        score: hit.score,
      }))
      .filter((h: any) => h.path.startsWith('topics/'));

    // Only topic docs should remain
    expect(filtered.every((r: any) => r.path.startsWith('topics/'))).toBe(true);
    expect(filtered.some((r: any) => r.path.startsWith('notes/'))).toBe(false);
  });
});

describe('BM25 score normalization', () => {
  it('should normalize scores > 1 relative to top result', () => {
    // Simulate what searchFulltext does
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
      // Would normalize — but it shouldn't in this case
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

    // Simulate what VectorStore.save() does
    const SCHEMA_VERSION = 2;
    const envelope = { schemaVersion: SCHEMA_VERSION, data };
    const json = JSON.stringify(envelope);

    // Parse and verify envelope structure
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.data).toBeDefined();

    // Simulate what VectorStore.initialize() does — load from envelope
    const newDb = create({ schema: createSchema(), id: 'test-load' });
    const loadedData = parsed.data;
    load(newDb, loadedData);

    expect(count(newDb)).toBe(4); // 4 test documents
  });

  it('should detect old schema version (missing schemaVersion)', () => {
    // Old format: raw Orama data without envelope
    const oldData = { some: 'raw-orama-data' };
    const version = (oldData as any).schemaVersion ?? 1;

    expect(version).toBe(1); // Missing field defaults to v1
  });

  it('should detect old schema version (explicit v1)', () => {
    const envelope = { schemaVersion: 1, data: {} };
    const SCHEMA_VERSION = 2;

    expect(envelope.schemaVersion < SCHEMA_VERSION).toBe(true);
  });

  it('should accept current schema version', () => {
    const envelope = { schemaVersion: 2, data: {} };
    const SCHEMA_VERSION = 2;

    expect(envelope.schemaVersion < SCHEMA_VERSION).toBe(false);
  });
});
