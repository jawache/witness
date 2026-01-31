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
      expect(toolNames).toContain('find_files');
      expect(toolNames).toContain('execute_command');
      expect(toolNames).toContain('get_orientation');
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
    const testFileName = 'test-write-temp.md';
    const testContent = '# Temporary Test File\n\nCreated by integration test.';

    afterAll(async () => {
      // Cleanup: try to delete the test file
      try {
        // We don't have delete, so we'll just leave it
        // The test vault can be reset via git
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should create a new file', async () => {
      const result = await client.callTool('write_file', {
        path: testFileName,
        content: testContent,
      });

      expect(result.isError).not.toBe(true);

      // Verify by reading it back
      const readResult = await client.callTool('read_file', { path: testFileName });
      const content = getTextContent(readResult);
      expect(content).toBe(testContent);
    });

    it('should overwrite existing file', async () => {
      const newContent = '# Updated Content\n\nThis was overwritten.';

      const result = await client.callTool('write_file', {
        path: testFileName,
        content: newContent,
      });

      expect(result.isError).not.toBe(true);

      // Verify
      const readResult = await client.callTool('read_file', { path: testFileName });
      const content = getTextContent(readResult);
      expect(content).toBe(newContent);
    });
  });

  describe('edit_file', () => {
    const editTestFile = 'test-edit-temp.md';

    beforeAll(async () => {
      // Create a file to edit
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
    it('should find text across files', async () => {
      const result = await client.callTool('search', { query: 'Hello World' });
      const content = getTextContent(result);

      expect(content).toContain('test-read.md');
    });

    it('should return empty for non-matching query', async () => {
      const result = await client.callTool('search', { query: 'xyznonexistentxyz' });
      const content = getTextContent(result);

      // Should either be empty or indicate no matches
      expect(content).not.toContain('test-read.md');
    });
  });

  describe('find_files', () => {
    it('should find files by name pattern', async () => {
      const result = await client.callTool('find_files', { pattern: 'test' });
      const content = getTextContent(result);

      expect(content).toContain('test-read.md');
    });

    it('should find nested files', async () => {
      const result = await client.callTool('find_files', { pattern: 'nested' });
      const content = getTextContent(result);

      expect(content).toContain('nested.md');
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
      expect(logContent).toContain('NOT FOUND');

      // Should log the path that wasn't found
      expect(logContent).toContain('does-not-exist.md');
    });
  });
});
