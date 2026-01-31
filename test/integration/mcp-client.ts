/**
 * Simple MCP client for integration testing.
 * Handles the HTTP-based MCP protocol communication.
 */

const MCP_BASE_URL = process.env.MCP_URL || 'http://localhost:3001/mcp';

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface MCPToolResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export class MCPClient {
  private sessionId: string | null = null;
  private requestId = 0;

  /**
   * Initialize a new MCP session
   */
  async initialize(): Promise<void> {
    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'witness-test-client',
        version: '1.0.0',
      },
    });

    if (response.error) {
      throw new Error(`Initialize failed: ${response.error.message}`);
    }

    // Send initialized notification
    await this.sendNotification('notifications/initialized', {});
  }

  /**
   * List available tools
   */
  async listTools(): Promise<any[]> {
    const response = await this.sendRequest('tools/list', {});
    if (response.error) {
      throw new Error(`List tools failed: ${response.error.message}`);
    }
    return response.result?.tools || [];
  }

  /**
   * Call a tool with arguments
   */
  async callTool(name: string, args: Record<string, any> = {}): Promise<MCPToolResult> {
    const response = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    if (response.error) {
      throw new Error(`Tool call failed: ${response.error.message}`);
    }

    return response.result as MCPToolResult;
  }

  /**
   * Send a JSON-RPC request to the MCP server
   */
  private async sendRequest(method: string, params: any): Promise<MCPResponse> {
    const id = ++this.requestId;
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const response = await fetch(MCP_BASE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // Capture session ID from response headers
    const newSessionId = response.headers.get('mcp-session-id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    const text = await response.text();

    // Handle SSE response format (may have multiple events)
    if (text.startsWith('event:') || text.startsWith('data:')) {
      // Parse SSE format - find the JSON-RPC response
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) {
            try {
              return JSON.parse(data);
            } catch {
              // Continue looking
            }
          }
        }
      }
      throw new Error('No valid JSON-RPC response in SSE stream');
    }

    // Plain JSON response
    return JSON.parse(text);
  }

  /**
   * Send a notification (no response expected)
   */
  private async sendNotification(method: string, params: any): Promise<void> {
    const body = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    await fetch(MCP_BASE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }
}

/**
 * Check if the MCP server is reachable
 */
export async function isServerRunning(): Promise<boolean> {
  try {
    const healthUrl = MCP_BASE_URL.replace('/mcp', '/health');
    const response = await fetch(healthUrl, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Extract text content from MCP tool result
 */
export function getTextContent(result: MCPToolResult): string {
  const textContent = result.content.find((c) => c.type === 'text');
  return textContent?.text || '';
}
