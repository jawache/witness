import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPClient, isServerRunning, getTextContent } from './mcp-client';
import * as fs from 'fs';
import * as path from 'path';

describe('MCP Server Integration Tests', () => {
  let client: MCPClient;

  beforeAll(async () => {
    // Check server is running
    const running = await isServerRunning();
    if (!running) {
      throw new Error(
        'MCP server is not running. Start Obsidian with the test vault first:\n' +
          '  npm run test:start-obsidian\n' +
          'Then run tests again.'
      );
    }

    // Initialize MCP session
    client = new MCPClient();
    await client.initialize();
  });

  describe('Server Connection', () => {
    it('should establish a session', () => {
      expect(client.getSessionId()).toBeTruthy();
    });

    it('should list available tools', async () => {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      // Check for core tools
      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('list_files');
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('find');
      expect(toolNames).toContain('move_file');
      expect(toolNames).toContain('execute_command');
      expect(toolNames).toContain('get_orientation');
      expect(toolNames).toContain('get_next_chaos');
      expect(toolNames).toContain('mark_triage');
    });
  });

  describe('read_file', () => {
    it('should read a file with known content', async () => {
      const result = await client.callTool('read_file', { path: 'test-read.md' });
      const content = getTextContent(result);

      expect(content).toContain('# Test Read File');
      expect(content).toContain('Line 1: Hello World');
      expect(content).toContain('Line 2: Testing 123');
      expect(content).toContain('Line 3: End of file');
    });

    it('should return error for non-existent file', async () => {
      const result = await client.callTool('read_file', { path: 'does-not-exist.md' });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('not found');
    });
  });

  describe('list_files', () => {
    it('should list files in root directory', async () => {
      const result = await client.callTool('list_files', {});
      const content = getTextContent(result);

      expect(content).toContain('README.md');
      expect(content).toContain('test-read.md');
      expect(content).toContain('subfolder');
    });

    it('should list files in subdirectory', async () => {
      const result = await client.callTool('list_files', { path: 'subfolder' });
      const content = getTextContent(result);

      expect(content).toContain('nested.md');
    });
  });

  describe('write_file', () => {
    const testFileName = 'test-write-new-temp.md';
    const testContent = '# Temporary Test File\n\nCreated by integration test.';

    afterAll(async () => {
      // Cleanup: delete the temp file
      try {
        await client.callTool('delete', { path: testFileName });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should create a new file', async () => {
      // Ensure file doesn't exist
      await client.callTool('delete', { path: testFileName }).catch(() => {});

      const result = await client.callTool('write_file', {
        path: testFileName,
        content: testContent,
      });

      expect(result.isError).not.toBe(true);
      expect(getTextContent(result)).toContain('Successfully created');

      // Verify by reading it back
      const readResult = await client.callTool('read_file', { path: testFileName });
      const content = getTextContent(readResult);
      expect(content).toBe(testContent);
    });

    it('should error when file already exists', async () => {
      // File was created in previous test — writing again should fail
      const result = await client.callTool('write_file', {
        path: testFileName,
        content: '# Should fail',
      });

      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('already exists');
      expect(getTextContent(result)).toContain('edit_file');
    });
  });

  describe('edit_file', () => {
    const editTestFile = 'test-edit-temp.md';

    beforeAll(async () => {
      // Reset the edit test file content (delete + create)
      await client.callTool('delete', { path: editTestFile }).catch(() => {});
      await client.callTool('write_file', {
        path: editTestFile,
        content: 'Line one\nLine two\nLine three',
      });
    });

    it('should find and replace text', async () => {
      const result = await client.callTool('edit_file', {
        path: editTestFile,
        find: 'Line two',
        replace: 'Line TWO (edited)',
      });

      expect(result.isError).not.toBe(true);

      // Verify
      const readResult = await client.callTool('read_file', { path: editTestFile });
      const content = getTextContent(readResult);
      expect(content).toContain('Line TWO (edited)');
      expect(content).not.toContain('Line two');
    });

    it('should return error if text not found', async () => {
      const result = await client.callTool('edit_file', {
        path: editTestFile,
        find: 'nonexistent text',
        replace: 'replacement',
      });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('not found');
    });
  });

  describe('search', () => {
    it('should find text across files (fulltext mode)', async () => {
      const result = await client.callTool('search', { query: 'Hello World', mode: 'fulltext' });
      const content = getTextContent(result);

      expect(content).toContain('test-read.md');
    });

    it('should return empty for non-matching query', async () => {
      const result = await client.callTool('search', { query: 'xyznonexistentxyz', mode: 'fulltext' });
      const content = getTextContent(result);

      // Should either be empty or indicate no matches
      expect(content).not.toContain('test-read.md');
    });
  });

  describe('find', () => {
    it('should find files by name pattern', async () => {
      const result = await client.callTool('find', { pattern: 'test' });
      const content = getTextContent(result);

      expect(content).toContain('test-read.md');
    });

    it('should find nested files', async () => {
      const result = await client.callTool('find', { pattern: 'nested' });
      const content = getTextContent(result);

      expect(content).toContain('nested.md');
    });
  });

  describe('move_file', () => {
    const moveTestFile = 'test-move-source.md';
    const moveDestFile = 'test-move-dest.md';
    const moveDestInFolder = 'subfolder/moved-file.md';

    beforeAll(async () => {
      // Clean up any leftover files from previous runs, then create fresh
      await client.callTool('delete', { path: moveTestFile }).catch(() => {});
      await client.callTool('delete', { path: moveDestFile }).catch(() => {});
      await client.callTool('delete', { path: moveDestInFolder }).catch(() => {});
      await client.callTool('write_file', {
        path: moveTestFile,
        content: '# File to move\n\nThis will be moved.',
      });
    });

    it('should move/rename a file', async () => {
      const result = await client.callTool('move_file', {
        from: moveTestFile,
        to: moveDestFile,
      });

      expect(result.isError).not.toBe(true);
      expect(getTextContent(result)).toContain('Successfully moved');

      // Verify: old path should not exist (read should fail)
      const oldResult = await client.callTool('read_file', { path: moveTestFile });
      expect(oldResult.isError).toBe(true);

      // Verify: new path should exist with correct content
      const newResult = await client.callTool('read_file', { path: moveDestFile });
      expect(newResult.isError).not.toBe(true);
      expect(getTextContent(newResult)).toContain('File to move');
    });

    it('should move file to subfolder', async () => {
      // First move back to original location for this test
      await client.callTool('move_file', {
        from: moveDestFile,
        to: moveDestInFolder,
      });

      // Verify file is in subfolder
      const result = await client.callTool('read_file', { path: moveDestInFolder });
      expect(result.isError).not.toBe(true);
      expect(getTextContent(result)).toContain('File to move');
    });

    it('should return error for non-existent source', async () => {
      const result = await client.callTool('move_file', {
        from: 'does-not-exist-for-move.md',
        to: 'some-destination.md',
      });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('not found');
    });

    it('should return error if destination exists', async () => {
      // Ensure both files exist (delete + create fresh)
      await client.callTool('delete', { path: 'move-conflict-source.md' }).catch(() => {});
      await client.callTool('delete', { path: 'move-conflict-dest.md' }).catch(() => {});
      await client.callTool('write_file', {
        path: 'move-conflict-source.md',
        content: 'Source',
      });
      await client.callTool('write_file', {
        path: 'move-conflict-dest.md',
        content: 'Destination exists',
      });

      const result = await client.callTool('move_file', {
        from: 'move-conflict-source.md',
        to: 'move-conflict-dest.md',
      });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('already exists');
    });
  });

  describe('get_orientation', () => {
    it('should return the orientation document', async () => {
      const result = await client.callTool('get_orientation', {});
      const content = getTextContent(result);

      expect(content).toContain('# Test Vault');
      expect(content).toContain('integration testing');
    });
  });

  describe('execute_command', () => {
    it('should execute a valid command', async () => {
      // This is tricky - we need a command that works in headless-ish mode
      // Let's try a safe one
      const result = await client.callTool('execute_command', {
        commandId: 'app:open-help',
      });

      // Should succeed (though the help may not visibly open in test)
      expect(result.isError).not.toBe(true);
    });

    it('should return error for invalid command', async () => {
      const result = await client.callTool('execute_command', {
        commandId: 'nonexistent:command',
      });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('not found');
    });
  });

  describe('dataview_query', () => {
    it('should be listed as an available tool', async () => {
      const tools = await client.listTools();
      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('dataview_query');
    });

    it('should execute a TABLE query and return markdown', async () => {
      const result = await client.callTool('dataview_query', {
        query: 'TABLE description FROM "topics" SORT file.name',
      });
      const content = getTextContent(result);

      expect(result.isError).not.toBe(true);
      // Should contain markdown table with our test topics
      expect(content).toContain('carbon-accounting');
      expect(content).toContain('green-software');
      expect(content).toContain('quantum-computing');
    });

    it('should execute a LIST query', async () => {
      const result = await client.callTool('dataview_query', {
        query: 'LIST FROM "topics" WHERE contains(tags, "sustainability")',
      });
      const content = getTextContent(result);

      expect(result.isError).not.toBe(true);
      expect(content).toContain('green-software');
      expect(content).toContain('carbon-accounting');
      expect(content).not.toContain('quantum-computing');
    });

    it('should return JSON format when requested', async () => {
      const result = await client.callTool('dataview_query', {
        query: 'TABLE description FROM "topics" SORT file.name',
        format: 'json',
      });
      const content = getTextContent(result);

      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(content);
      expect(parsed.headers).toBeDefined();
      expect(parsed.values).toBeDefined();
      expect(parsed.values.length).toBe(3);
    });

    it('should return error for invalid query', async () => {
      const result = await client.callTool('dataview_query', {
        query: 'INVALID QUERY SYNTAX HERE',
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('read_file with render', () => {
    it('should return raw content when render is false', async () => {
      const result = await client.callTool('read_file', {
        path: 'dataview-test.md',
        render: false,
      });
      const content = getTextContent(result);

      // Should contain raw dataview codeblock
      expect(content).toContain('```dataview');
      expect(content).toContain('TABLE description, tags FROM "topics"');
    });

    it('should resolve Dataview blocks when render is true', async () => {
      const result = await client.callTool('read_file', {
        path: 'dataview-test.md',
        render: true,
      });
      const content = getTextContent(result);

      // Should NOT contain raw dataview codeblock
      expect(content).not.toContain('```dataview');

      // Should contain resolved data
      expect(content).toContain('carbon-accounting');
      expect(content).toContain('green-software');
      expect(content).toContain('quantum-computing');

      // Static content should remain
      expect(content).toContain('This text should remain unchanged after rendering');
    });
  });

  describe('get_orientation with Dataview', () => {
    it('should auto-resolve Dataview blocks in orientation', async () => {
      const result = await client.callTool('get_orientation', {});
      const content = getTextContent(result);

      // The orientation file (README.md) has a Dataview TABLE query
      // It should be resolved automatically
      expect(content).toContain('# Test Vault');
      expect(content).not.toContain('```dataview');

      // Should contain the resolved topic data
      expect(content).toContain('carbon-accounting');
      expect(content).toContain('green-software');
      expect(content).toContain('quantum-computing');
    });
  });

  describe('search (semantic modes)', () => {
    // Check if Ollama is available — skip tests gracefully if not
    let ollamaAvailable = false;

    beforeAll(async () => {
      try {
        const resp = await fetch('http://localhost:11434/api/tags');
        ollamaAvailable = resp.ok;
      } catch {
        ollamaAvailable = false;
      }
    });

    it('should return results for hybrid search (default mode)', async () => {
      if (!ollamaAvailable) return;

      const result = await client.callTool('search', {
        query: 'carbon emissions',
      });

      expect(result.isError).not.toBe(true);
      const content = getTextContent(result);
      expect(content).toContain('carbon-accounting');
    }, 60000); // First call triggers indexing — may be slow

    it('should return results for vector search', async () => {
      if (!ollamaAvailable) return;

      const result = await client.callTool('search', {
        query: 'carbon emissions',
        mode: 'vector',
      });

      expect(result.isError).not.toBe(true);
      const content = getTextContent(result);
      expect(content).toContain('carbon-accounting');
    });

    it('should return structured JSON results', async () => {
      if (!ollamaAvailable) return;

      const result = await client.callTool('search', {
        query: 'carbon',
        mode: 'fulltext',
      });

      expect(result.isError).not.toBe(true);
      const content = getTextContent(result);
      // Results are now structured JSON
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty('path');
      expect(parsed[0]).toHaveProperty('title');
      expect(parsed[0]).toHaveProperty('score');
    });

    it('should filter results by path', async () => {
      if (!ollamaAvailable) return;

      const result = await client.callTool('search', {
        query: 'carbon',
        mode: 'fulltext',
        path: 'topics/',
      });

      expect(result.isError).not.toBe(true);
      const content = getTextContent(result);
      expect(content).toContain('topics/');
    });

    it('should respect limit parameter', async () => {
      if (!ollamaAvailable) return;

      const result = await client.callTool('search', {
        query: 'test',
        mode: 'vector',
        limit: 2,
      });

      expect(result.isError).not.toBe(true);
      const content = getTextContent(result);
      const parsed = JSON.parse(content);
      expect(parsed.length).toBeLessThanOrEqual(2);
    });
  });

  describe('get_next_chaos', () => {
    it('should be listed as an available tool', async () => {
      const tools = await client.listTools();
      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('get_next_chaos');
      expect(toolNames).toContain('mark_triage');
    });

    it('should return the next untriaged item with content', async () => {
      const result = await client.callTool('get_next_chaos', { path: '1-chaos/' });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.path).toBeDefined();
      expect(data.content).toBeDefined();
      expect(data.queue).toBeDefined();
      expect(data.queue.total).toBeGreaterThan(0);

      // Should not return processed or acknowledged items
      expect(data.path).not.toContain('already-processed');
      expect(data.path).not.toContain('acknowledged-item');
      expect(data.path).not.toContain('deferred-future');
    });

    it('should include deferred items past their date', async () => {
      const result = await client.callTool('get_next_chaos', { path: '1-chaos/', list: true });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      const paths = data.items.map((i: any) => i.path);

      // deferred-past.md has triage: deferred 2026-02-01 — should be in queue
      expect(paths).toContain('1-chaos/deferred-past.md');

      // deferred-future.md has triage: deferred 2099-12-31 — should NOT be in queue
      expect(paths).not.toContain('1-chaos/deferred-future.md');
    });

    it('should return list of items in list mode', async () => {
      const result = await client.callTool('get_next_chaos', { path: '1-chaos/', list: true });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.items).toBeDefined();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeGreaterThan(0);

      // Each item should have metadata but NOT full content
      const item = data.items[0];
      expect(item.path).toBeDefined();
      expect(item.title).toBeDefined();
      expect(item).not.toHaveProperty('content');
    });

    it('should sort by date descending (newest first)', async () => {
      const result = await client.callTool('get_next_chaos', { path: '1-chaos/', list: true });
      const data = JSON.parse(getTextContent(result));

      // Items with dates should be sorted newest first
      const datedItems = data.items.filter((i: any) => i.date);
      for (let idx = 1; idx < datedItems.length; idx++) {
        expect(datedItems[idx - 1].date >= datedItems[idx].date).toBe(true);
      }
    });

    it('should return empty for a path with no chaos items', async () => {
      const result = await client.callTool('get_next_chaos', { path: '1-chaos/nonexistent/' });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.items).toBeDefined();
      expect(data.items.length).toBe(0);
    });

    it('should show next items first in list mode', async () => {
      const result = await client.callTool('get_next_chaos', { path: '1-chaos/', list: true });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      const items = data.items;

      // Find the next-up-item (has triage: next in test vault)
      const nextItem = items.find((i: any) => i.path === '1-chaos/next-up-item.md');
      expect(nextItem).toBeDefined();
      expect(nextItem.priority).toBe('next');

      // Next items should appear before normal items
      const nextIdx = items.indexOf(nextItem);
      const normalItems = items.filter((i: any) => i.priority !== 'next');
      if (normalItems.length > 0) {
        const firstNormalIdx = items.indexOf(normalItems[0]);
        expect(nextIdx).toBeLessThan(firstNormalIdx);
      }
    });

    it('should include next count in queue stats', async () => {
      const result = await client.callTool('get_next_chaos', { path: '1-chaos/', list: true });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.queue.next).toBeDefined();
      expect(data.queue.next).toBeGreaterThanOrEqual(1);
    });
  });

  describe('mark_triage', () => {
    const triageFile = '1-chaos/triage-target.md';

    beforeAll(async () => {
      // Reset the triage target file (remove triage field if set from previous run)
      await client.callTool('delete', { path: triageFile }).catch(() => {});
      await client.callTool('write_file', {
        path: triageFile,
        content: '---\ntitle: Item to Triage\ndate: 2026-02-08\n---\n\n# Item to Triage\n\nThis file will be used to test the mark_triage tool.\n',
      });
    });

    it('should mark an item as processed', async () => {
      const result = await client.callTool('mark_triage', {
        path: triageFile,
        action: 'processed',
      });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.action).toBe('processed');
      expect(data.triage).toMatch(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD

      // Verify: file should now have triage in frontmatter
      const readResult = await client.callTool('read_file', { path: triageFile });
      expect(getTextContent(readResult)).toContain('triage:');
    });

    it('should mark an item as deferred', async () => {
      const result = await client.callTool('mark_triage', {
        path: triageFile,
        action: 'deferred',
        defer_until: '2099-12-31',
      });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.action).toBe('deferred');
      expect(data.triage).toBe('deferred 2099-12-31');

      // Verify in file
      const readResult = await client.callTool('read_file', { path: triageFile });
      expect(getTextContent(readResult)).toContain('deferred 2099-12-31');
    });

    it('should mark an item as acknowledged', async () => {
      const result = await client.callTool('mark_triage', {
        path: triageFile,
        action: 'acknowledged',
      });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.action).toBe('acknowledged');
      expect(data.triage).toBe('acknowledged');
    });

    it('should error when deferred without defer_until', async () => {
      const result = await client.callTool('mark_triage', {
        path: triageFile,
        action: 'deferred',
      });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('defer_until');
    });

    it('should mark an item as next', async () => {
      const result = await client.callTool('mark_triage', {
        path: triageFile,
        action: 'next',
      });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.action).toBe('next');
      expect(data.triage).toBe('next');

      // Verify in file
      const readResult = await client.callTool('read_file', { path: triageFile });
      expect(getTextContent(readResult)).toContain('triage: next');
    });

    it('should reset triage (remove field)', async () => {
      // First set triage to something
      await client.callTool('mark_triage', {
        path: triageFile,
        action: 'acknowledged',
      });

      // Then reset
      const result = await client.callTool('mark_triage', {
        path: triageFile,
        action: 'reset',
      });
      expect(result.isError).not.toBe(true);

      const data = JSON.parse(getTextContent(result));
      expect(data.action).toBe('reset');

      // Verify triage field is removed from file
      const readResult = await client.callTool('read_file', { path: triageFile });
      const content = getTextContent(readResult);
      expect(content).not.toMatch(/triage:/);
    });

    it('should error for non-existent file', async () => {
      const result = await client.callTool('mark_triage', {
        path: '1-chaos/does-not-exist.md',
        action: 'processed',
      });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('not found');
    });
  });

  describe('logging', () => {
    // Helper to get log file path
    const getLogPath = () => {
      const today = new Date().toISOString().split('T')[0];
      // Tests run from test/ directory, so go up one level to find test/vault
      return path.resolve(
        __dirname,
        '..',
        'vault',
        '.obsidian',
        'plugins',
        'witness',
        'logs',
        `mcp-${today}.log`
      );
    };

    it('should write logs to file', async () => {
      // Wait a moment for logs to flush (buffer flushes every second)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const logPath = getLogPath();
      expect(fs.existsSync(logPath)).toBe(true);

      // Read and verify log content
      const logContent = fs.readFileSync(logPath, 'utf-8');

      // Should contain MCP-related entries from our test session
      expect(logContent).toContain('[MCP]');
      expect(logContent).toContain('POST /mcp');
      expect(logContent).toContain('initialize');

      // Should contain tool calls we made
      expect(logContent).toContain('read_file');

      // Should have proper log format with timestamps
      expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should log error cases', async () => {
      // Wait for logs to flush
      await new Promise((resolve) => setTimeout(resolve, 500));

      const logPath = getLogPath();
      const logContent = fs.readFileSync(logPath, 'utf-8');

      // Should log when file lookups fail
      expect(logContent.toLowerCase()).toContain('not found');

      // Should log the path that wasn't found
      expect(logContent).toContain('does-not-exist.md');
    });
  });
});
