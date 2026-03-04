import { spawn, type ChildProcess } from 'node:child_process';
import type {
  McpToolDefinition,
  McpToolResult,
  McpServer,
  McpServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

/**
 * MCP client using stdio transport.
 *
 * Spawns a child process and communicates via JSON-RPC over stdin/stdout.
 * Each message is a newline-delimited JSON-RPC object.
 */
export class StdioMcpClient implements McpServer {
  readonly name: string;
  tools: McpToolDefinition[] = [];
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private buffer = '';

  constructor(private config: McpServerConfig) {
    this.name = config.name;
  }

  async connect(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`MCP server "${this.name}" has no command configured for stdio transport`);
    }

    const args = this.config.args ?? [];
    this.process = spawn(this.config.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    });

    this.process.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.on('error', (err) => {
      // Reject all pending requests
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });

    // Send initialize request
    const initResponse = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'axl', version: '0.1.0' },
    });

    if (!initResponse.result) {
      throw new Error(`MCP server "${this.name}" failed to initialize`);
    }

    // Send initialized notification (no id = notification)
    this.sendNotification('notifications/initialized');

    // Discover tools
    await this.discoverTools();
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            pending.resolve(msg);
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  private sendRequest(
    method: string,
    params?: unknown,
    timeoutMs = 30000,
  ): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error(`MCP server "${this.name}" is not connected`));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP server "${this.name}" request "${method}" timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };
    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  private async discoverTools(): Promise<void> {
    const response = await this.sendRequest('tools/list');
    if (response.error) {
      throw new Error(
        `Failed to list tools from MCP server "${this.name}": ${response.error.message}`,
      );
    }

    const result = response.result as {
      tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    };
    this.tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(toolName: string, args: unknown): Promise<McpToolResult> {
    const response = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    if (response.error) {
      return {
        content: [{ type: 'text', text: `Error: ${response.error.message}` }],
        isError: true,
      };
    }

    return response.result as McpToolResult;
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error('MCP client closed'));
    }
    this.pending.clear();
  }
}

/**
 * MCP client using HTTP/SSE transport.
 *
 * Communicates with an MCP server via HTTP POST requests.
 */
export class HttpMcpClient implements McpServer {
  readonly name: string;
  tools: McpToolDefinition[] = [];
  private baseUrl: string;

  constructor(private config: McpServerConfig) {
    this.name = config.name;
    this.baseUrl = (config.uri ?? '').replace(/\/$/, '');
  }

  async connect(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error(`MCP server "${this.name}" has no URI configured for HTTP transport`);
    }

    // Initialize
    const initResult = await this.postRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'axl', version: '0.1.0' },
    });

    if (!initResult) {
      throw new Error(`MCP server "${this.name}" failed to initialize`);
    }

    // Discover tools
    await this.discoverTools();
  }

  private async postRequest(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    };

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`MCP HTTP error (${res.status}): ${await res.text()}`);
    }

    const response = (await res.json()) as JsonRpcResponse;
    if (response.error) {
      throw new Error(`MCP server error: ${response.error.message}`);
    }

    return response.result;
  }

  private async discoverTools(): Promise<void> {
    const result = (await this.postRequest('tools/list')) as {
      tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    };
    this.tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(toolName: string, args: unknown): Promise<McpToolResult> {
    try {
      const result = (await this.postRequest('tools/call', {
        name: toolName,
        arguments: args,
      })) as McpToolResult;
      return result;
    } catch (err) {
      return {
        content: [
          { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    // HTTP transport: no persistent connection to close
  }
}

/**
 * Create the appropriate MCP client based on configuration.
 */
export function createMcpClient(config: McpServerConfig): StdioMcpClient | HttpMcpClient {
  if (config.uri) {
    return new HttpMcpClient(config);
  }
  return new StdioMcpClient(config);
}
