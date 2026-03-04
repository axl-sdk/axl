/**
 * MCP (Model Context Protocol) types for tool discovery and execution.
 */

/** A tool definition discovered from an MCP server. */
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema
};

/** Configuration for connecting to an MCP server. */
export type McpServerConfig = {
  name: string;
  /** Command to spawn for stdio transport (e.g. "npx -y @modelcontextprotocol/server-fs") */
  command?: string;
  /** Arguments for the command */
  args?: string[];
  /** HTTP/SSE endpoint URI for HTTP transport */
  uri?: string;
  /** Environment variables to pass to the spawned process */
  env?: Record<string, string>;
};

/** Result from calling an MCP tool. */
export type McpToolResult = {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

/** JSON-RPC request/response types for MCP protocol. */
export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** A connected MCP server with its discovered tools. */
export type McpServer = {
  name: string;
  tools: McpToolDefinition[];
  callTool(toolName: string, args: unknown): Promise<McpToolResult>;
  close(): Promise<void>;
};
