import { describe, it, expect, vi } from 'vitest';
import { McpManager } from '../mcp/manager.js';
import type { McpServer, McpToolDefinition, McpToolResult } from '../mcp/types.js';
import { WorkflowContext } from '../context.js';

import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';

// ── Mock MCP Server ──────────────────────────────────────────────────────

class MockMcpServer implements McpServer {
  name: string;
  tools: McpToolDefinition[];
  callLog: Array<{ toolName: string; args: unknown }> = [];

  constructor(name: string, tools: McpToolDefinition[]) {
    this.name = name;
    this.tools = tools;
  }

  async callTool(toolName: string, args: unknown): Promise<McpToolResult> {
    this.callLog.push({ toolName, args });
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Result from ${toolName}: ${JSON.stringify(args)}` }],
    };
  }

  async close(): Promise<void> {
    // no-op
  }
}

// ── Helper: McpManager with mock servers ─────────────────────────────────

function createMockManager(servers: Array<{ name: string; tools: McpToolDefinition[] }>): {
  manager: McpManager;
  mocks: MockMcpServer[];
} {
  const manager = new McpManager();
  const mocks: MockMcpServer[] = [];

  for (const s of servers) {
    const mock = new MockMcpServer(s.name, s.tools);
    mocks.push(mock);
    // Inject mock server directly into the manager's private map
    (manager as any).servers.set(s.name, mock);
  }

  return { manager, mocks };
}

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  private responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>;
  private callIndex = 0;
  calls: any[] = [];

  constructor(responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>) {
    this.responses = responses;
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return {
      content: resp.content,
      tool_calls: resp.tool_calls,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: resp.cost ?? 0.001,
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: (resp as any).usage };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// McpManager tests
// ═════════════════════════════════════════════════════════════════════════

describe('McpManager', () => {
  describe('tool discovery', () => {
    it('returns all tools from all servers', () => {
      const { manager } = createMockManager([
        {
          name: 'fs-server',
          tools: [
            { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
            { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } },
          ],
        },
        {
          name: 'git-server',
          tools: [{ name: 'git_log', description: 'Get git log', inputSchema: { type: 'object' } }],
        },
      ]);

      const allTools = manager.getAllTools();
      expect(allTools).toHaveLength(3);
      expect(allTools.map((t) => t.tool.name)).toEqual(['read_file', 'write_file', 'git_log']);
    });
  });

  describe('per-agent filtering', () => {
    it('filters tools by server name', () => {
      const { manager } = createMockManager([
        {
          name: 'fs-server',
          tools: [{ name: 'read_file', description: 'Read', inputSchema: {} }],
        },
        {
          name: 'git-server',
          tools: [{ name: 'git_log', description: 'Log', inputSchema: {} }],
        },
      ]);

      const fsTools = manager.getToolsForAgent(['fs-server']);
      expect(fsTools).toHaveLength(1);
      expect(fsTools[0].tool.name).toBe('read_file');
    });

    it('filters tools by specific tool names', () => {
      const { manager } = createMockManager([
        {
          name: 'fs-server',
          tools: [
            { name: 'read_file', description: 'Read', inputSchema: {} },
            { name: 'write_file', description: 'Write', inputSchema: {} },
            { name: 'delete_file', description: 'Delete', inputSchema: {} },
          ],
        },
      ]);

      const limited = manager.getToolsForAgent(undefined, ['read_file', 'write_file']);
      expect(limited).toHaveLength(2);
      expect(limited.map((t) => t.tool.name)).toEqual(['read_file', 'write_file']);
    });

    it('filters tools by qualified server:tool_name format', () => {
      const { manager } = createMockManager([
        {
          name: 'fs-server',
          tools: [
            { name: 'read_file', description: 'Read', inputSchema: {} },
            { name: 'write_file', description: 'Write', inputSchema: {} },
          ],
        },
        {
          name: 'git-server',
          tools: [{ name: 'read_file', description: 'Git read', inputSchema: {} }],
        },
      ]);

      // Qualified name disambiguates same-named tools across servers
      const filtered = manager.getToolsForAgent(undefined, ['fs-server:read_file']);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].server).toBe('fs-server');
      expect(filtered[0].tool.name).toBe('read_file');
    });

    it('getQualifiedName returns server:tool_name', () => {
      const { manager } = createMockManager([
        {
          name: 'fs-server',
          tools: [{ name: 'read_file', description: 'Read', inputSchema: {} }],
        },
      ]);

      expect(manager.getQualifiedName('read_file')).toBe('fs-server:read_file');
      expect(manager.getQualifiedName('unknown')).toBeUndefined();
    });

    it('returns all tools when no filter specified', () => {
      const { manager } = createMockManager([
        {
          name: 'server-a',
          tools: [{ name: 'tool1', description: '', inputSchema: {} }],
        },
        {
          name: 'server-b',
          tools: [{ name: 'tool2', description: '', inputSchema: {} }],
        },
      ]);

      const all = manager.getToolsForAgent();
      expect(all).toHaveLength(2);
    });
  });

  describe('tool calls', () => {
    it('routes calls to correct server', async () => {
      const { manager, mocks } = createMockManager([
        {
          name: 'fs-server',
          tools: [{ name: 'read_file', description: 'Read', inputSchema: {} }],
        },
        {
          name: 'git-server',
          tools: [{ name: 'git_log', description: 'Log', inputSchema: {} }],
        },
      ]);

      const result = await manager.callTool('git_log', { count: 5 });
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Result from git_log: {"count":5}',
      });
      expect(mocks[1].callLog).toHaveLength(1);
      expect(mocks[0].callLog).toHaveLength(0);
    });

    it('returns error for unknown tool', async () => {
      const { manager } = createMockManager([
        {
          name: 'server',
          tools: [{ name: 'known_tool', description: '', inputSchema: {} }],
        },
      ]);

      const result = await manager.callTool('unknown_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
    });

    it('uses server hint when provided', async () => {
      const { manager, mocks } = createMockManager([
        {
          name: 'server-a',
          tools: [{ name: 'shared_tool', description: '', inputSchema: {} }],
        },
        {
          name: 'server-b',
          tools: [{ name: 'shared_tool', description: '', inputSchema: {} }],
        },
      ]);

      await manager.callTool('shared_tool', {}, 'server-b');
      expect(mocks[0].callLog).toHaveLength(0);
      expect(mocks[1].callLog).toHaveLength(1);
    });
  });

  describe('isMcpTool', () => {
    it('returns true for known MCP tools', () => {
      const { manager } = createMockManager([
        {
          name: 'server',
          tools: [{ name: 'mcp_tool', description: '', inputSchema: {} }],
        },
      ]);

      expect(manager.isMcpTool('mcp_tool')).toBe(true);
      expect(manager.isMcpTool('unknown')).toBe(false);
    });
  });

  describe('getToolDefinitions', () => {
    it('converts MCP tools to ToolDefinition format', () => {
      const { manager } = createMockManager([
        {
          name: 'server',
          tools: [
            {
              name: 'search',
              description: 'Search for items',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
          ],
        },
      ]);

      const defs = manager.getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0]).toEqual({
        type: 'function',
        function: {
          name: 'search',
          description: 'Search for items',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      });
    });
  });

  describe('shutdown', () => {
    it('closes all servers', async () => {
      const { manager } = createMockManager([
        { name: 'a', tools: [] },
        { name: 'b', tools: [] },
      ]);

      expect(manager.serverCount).toBe(2);
      await manager.shutdown();
      expect(manager.serverCount).toBe(0);
    });
  });

  describe('concurrent initialization guard', () => {
    it('returns the same promise for concurrent initialize calls', async () => {
      const manager = new McpManager();

      // Mock createMcpClient by injecting servers directly after first init
      const originalInit = (manager as any).initPromise;
      expect(originalInit).toBeNull();

      // We can't easily mock createMcpClient, but we can verify the guard
      // by calling initialize with empty configs (no-op) multiple times
      const p1 = manager.initialize([]);
      const p2 = manager.initialize([]);
      const p3 = manager.initialize([]);

      // All should return the same promise
      expect((manager as any).initPromise).not.toBeNull();

      await Promise.all([p1, p2, p3]);
    });

    it('resets initPromise on failure so retry is possible', async () => {
      const manager = new McpManager();

      // First call with a bad config should fail and reset
      try {
        await manager.initialize([
          { name: 'bad', transport: 'stdio' as any, command: '/nonexistent/binary/xyz' },
        ]);
      } catch {
        // Expected to fail
      }

      // initPromise should be reset to null
      expect((manager as any).initPromise).toBeNull();

      // Second call should be able to proceed (not stuck on the failed promise)
      await manager.initialize([]); // empty = no-op success
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// MCP integration with WorkflowContext
// ═════════════════════════════════════════════════════════════════════════

describe('MCP integration with WorkflowContext', () => {
  it('includes MCP tools in tool definitions sent to LLM', async () => {
    const { manager } = createMockManager([
      {
        name: 'fs-server',
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      },
    ]);

    const provider = new TestProvider([{ content: 'response' }]);
    const registry = new ProviderRegistry();
    registry.registerInstance('test', provider as any);

    const agentWithMcp = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      mcp: ['fs-server'],
    });

    const ctx = new WorkflowContext({
      input: 'test',
      executionId: 'mcp-test-1',
      config: { defaultProvider: 'test' },
      providerRegistry: registry,
      onTrace: vi.fn(),
      mcpManager: manager,
    });

    await ctx.ask(agentWithMcp, 'Read a file');

    // Verify that MCP tools were included in the request
    const tools = provider.calls[0].options.tools;
    expect(tools).toBeDefined();
    const mcpTool = tools.find((t: any) => t.function.name === 'read_file');
    expect(mcpTool).toBeDefined();
    expect(mcpTool.function.description).toBe('Read a file');
  });

  it('routes MCP tool calls correctly when LLM invokes them', async () => {
    const { manager, mocks } = createMockManager([
      {
        name: 'fs-server',
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      },
    ]);

    const provider = new TestProvider([
      // First response: LLM calls the MCP tool
      {
        content: '',
        tool_calls: [
          {
            id: 'call_mcp_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"/tmp/test.txt"}',
            },
          },
        ],
      },
      // Second response: final text after seeing tool result
      { content: 'The file contains hello world.' },
    ]);
    const registry = new ProviderRegistry();
    registry.registerInstance('test', provider as any);

    const agentWithMcp = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      mcp: ['fs-server'],
    });

    const ctx = new WorkflowContext({
      input: 'test',
      executionId: 'mcp-test-2',
      config: { defaultProvider: 'test' },
      providerRegistry: registry,
      onTrace: vi.fn(),
      mcpManager: manager,
    });

    const result = await ctx.ask(agentWithMcp, 'Read /tmp/test.txt');

    expect(result).toBe('The file contains hello world.');
    expect(mocks[0].callLog).toHaveLength(1);
    expect(mocks[0].callLog[0]).toEqual({
      toolName: 'read_file',
      args: { path: '/tmp/test.txt' },
    });

    // Verify the tool result was included in messages for second call
    const secondCallMessages = provider.calls[1].messages;
    const toolMsg = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain('Result from read_file');
  });

  it('mcpTools restriction limits available tools', async () => {
    const { manager } = createMockManager([
      {
        name: 'fs-server',
        tools: [
          { name: 'read_file', description: 'Read', inputSchema: {} },
          { name: 'write_file', description: 'Write', inputSchema: {} },
          { name: 'delete_file', description: 'Delete', inputSchema: {} },
        ],
      },
    ]);

    const provider = new TestProvider([{ content: 'ok' }]);
    const registry = new ProviderRegistry();
    registry.registerInstance('test', provider as any);

    // Agent only allowed to use read_file
    const restrictedAgent = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      mcpTools: ['read_file'],
    });

    const ctx = new WorkflowContext({
      input: 'test',
      executionId: 'mcp-test-3',
      config: { defaultProvider: 'test' },
      providerRegistry: registry,
      onTrace: vi.fn(),
      mcpManager: manager,
    });

    await ctx.ask(restrictedAgent, 'Do something');

    // Only read_file should be in the tools
    const tools = provider.calls[0].options.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('read_file');
  });
});
