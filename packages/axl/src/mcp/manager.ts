import type { McpServer, McpServerConfig, McpToolDefinition, McpToolResult } from './types.js';
import { createMcpClient } from './client.js';
import type { ToolDefinition } from '../providers/types.js';

/**
 * Manages connections to multiple MCP servers.
 * Discovers tools, filters by agent config, and routes tool calls.
 *
 * MCP tools are namespaced internally as "server:tool_name" for disambiguation
 * and trace output, but presented to the LLM with their original names
 * (no prefix) to avoid confusing the model.
 */
export class McpManager {
  private servers = new Map<string, McpServer>();
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize connections to all configured MCP servers.
   * Safe to call multiple times — subsequent calls return the original promise.
   */
  async initialize(configs: McpServerConfig[]): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      for (const config of configs) {
        const client = createMcpClient(config);
        await client.connect();
        this.servers.set(config.name, client);
      }
    })();

    try {
      await this.initPromise;
    } catch (err) {
      // Reset so a retry can attempt initialization again
      this.initPromise = null;
      throw err;
    }
  }

  /**
   * Get all tools from all connected servers.
   */
  getAllTools(): Array<{ server: string; tool: McpToolDefinition }> {
    const tools: Array<{ server: string; tool: McpToolDefinition }> = [];
    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools) {
        tools.push({ server: serverName, tool });
      }
    }
    return tools;
  }

  /**
   * Get the qualified name for an MCP tool: "server:tool_name".
   * Used in traces and ACL declarations.
   */
  getQualifiedName(toolName: string): string | undefined {
    for (const [serverName, server] of this.servers) {
      if (server.tools.some((t) => t.name === toolName)) {
        return `${serverName}:${toolName}`;
      }
    }
    return undefined;
  }

  /**
   * Get tool definitions filtered for a specific agent's MCP configuration.
   *
   * @param agentMcp - Server names the agent has access to (undefined = all)
   * @param agentMcpTools - Specific tool names the agent can use.
   *   Accepts both plain names ("read_file") and qualified names ("fs-server:read_file").
   *   Qualified names enable disambiguation when multiple servers expose same-named tools.
   */
  getToolsForAgent(
    agentMcp?: string[],
    agentMcpTools?: string[],
  ): Array<{ server: string; tool: McpToolDefinition }> {
    const allTools = this.getAllTools();

    // Filter by server names if specified
    let filtered = agentMcp ? allTools.filter(({ server }) => agentMcp.includes(server)) : allTools;

    // Filter by specific tool names if specified
    if (agentMcpTools) {
      filtered = filtered.filter(({ server, tool }) => {
        const qualifiedName = `${server}:${tool.name}`;
        // Match against both qualified ("server:tool") and plain ("tool") names
        return agentMcpTools.includes(qualifiedName) || agentMcpTools.includes(tool.name);
      });
    }

    return filtered;
  }

  /**
   * Convert MCP tools to ToolDefinition format for sending to LLMs.
   * Tools are presented with their original names (no server prefix)
   * to avoid confusing the LLM.
   */
  getToolDefinitions(agentMcp?: string[], agentMcpTools?: string[]): ToolDefinition[] {
    const tools = this.getToolsForAgent(agentMcp, agentMcpTools);
    return tools.map(({ tool }) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * Call a tool by name. Finds the correct server automatically.
   *
   * @param toolName - The tool name
   * @param args - Arguments for the tool
   * @param serverHint - Optional server name if known (for disambiguation)
   */
  async callTool(toolName: string, args: unknown, serverHint?: string): Promise<McpToolResult> {
    // If server hint provided, use it directly
    if (serverHint) {
      const server = this.servers.get(serverHint);
      if (!server) {
        return {
          content: [{ type: 'text', text: `MCP server "${serverHint}" not found` }],
          isError: true,
        };
      }
      return server.callTool(toolName, args);
    }

    // Find the server that has this tool
    for (const [, server] of this.servers) {
      const hasTool = server.tools.some((t) => t.name === toolName);
      if (hasTool) {
        return server.callTool(toolName, args);
      }
    }

    return {
      content: [{ type: 'text', text: `MCP tool "${toolName}" not found on any server` }],
      isError: true,
    };
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMcpTool(toolName: string): boolean {
    for (const [, server] of this.servers) {
      if (server.tools.some((t) => t.name === toolName)) return true;
    }
    return false;
  }

  /**
   * Shut down all MCP server connections.
   */
  async shutdown(): Promise<void> {
    for (const [, server] of this.servers) {
      await server.close();
    }
    this.servers.clear();
  }

  /**
   * Get the number of connected servers.
   */
  get serverCount(): number {
    return this.servers.size;
  }
}
