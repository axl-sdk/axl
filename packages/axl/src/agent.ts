import type { Tool } from './tool.js';
import type { AskOptions, GuardrailsConfig } from './types.js';
import { ProviderRegistry } from './providers/registry.js';
import { WorkflowContext } from './context.js';
import { randomUUID } from 'node:crypto';

/** Descriptor for a handoff target agent with optional description. */
export type HandoffDescriptor = {
  agent: Agent;
  description?: string;
  /** Handoff mode: 'oneway' (default) exits source loop, 'roundtrip' returns result to source. */
  mode?: 'oneway' | 'roundtrip';
};

/** Agent configuration */
export type AgentConfig = {
  name?: string;
  model: string | ((ctx: { metadata?: Record<string, unknown> }) => string);
  system: string | ((ctx: { metadata?: Record<string, unknown> }) => string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Tool<any, any>[];
  handoffs?: HandoffDescriptor[];
  mcp?: string[];
  mcpTools?: string[];
  temperature?: number;
  maxTurns?: number;
  timeout?: string;
  maxContext?: number;
  version?: string;
  guardrails?: GuardrailsConfig;
};

/** A defined agent instance */
export type Agent = {
  readonly _config: AgentConfig;
  readonly _name: string;
  /** Direct invocation for prototyping (no workflow context) */
  ask<T = string>(prompt: string, options?: AskOptions<T>): Promise<T>;
  /** Resolve model string for given context */
  resolveModel(ctx?: { metadata?: Record<string, unknown> }): string;
  /** Resolve system prompt for given context */
  resolveSystem(ctx?: { metadata?: Record<string, unknown> }): string;
};

let agentCounter = 0;

/**
 * Define an agent with a model, system prompt, tools, and optional handoffs.
 * Agents are inert definitions until invoked via `ctx.ask()` or `agent.ask()`.
 * @param config - Agent configuration: model URI, system prompt (static or dynamic), tools, temperature, etc.
 * @returns An Agent instance that can be used with `ctx.ask()` inside workflows or called directly for prototyping.
 */
export function agent(config: AgentConfig): Agent {
  agentCounter++;

  // Derive a name: prefer explicit name, then model string, then fallback counter
  const modelStr = typeof config.model === 'string' ? config.model : undefined;
  const defaultName = config.name ?? modelStr ?? `Agent_${agentCounter}`;

  const resolveModel = (ctx?: { metadata?: Record<string, unknown> }): string => {
    return typeof config.model === 'function' ? config.model(ctx ?? {}) : config.model;
  };

  const resolveSystem = (ctx?: { metadata?: Record<string, unknown> }): string => {
    const sys = config.system;
    return typeof sys === 'function' ? sys(ctx ?? {}) : sys;
  };

  const agentInstance: Agent = {
    _config: config,
    _name: defaultName,

    async ask<T = string>(prompt: string, options?: AskOptions<T>): Promise<T> {
      // Direct invocation — creates a lightweight implicit context
      // This is a simplified path for quick experiments and prototyping;
      // production use should use ctx.ask() inside a workflow.
      const registry = new ProviderRegistry();
      const ctx = new WorkflowContext({
        input: prompt,
        executionId: randomUUID(),
        config: {},
        providerRegistry: registry,
      });
      return ctx.ask(agentInstance, prompt, options);
    },

    resolveModel,
    resolveSystem,
  };

  return agentInstance;
}
