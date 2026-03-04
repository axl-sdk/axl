# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Tier 2: Tool Middleware, Handoff Improvements, Streaming
- `tool({ requireApproval: true })` — approval gate via `ctx.awaitHuman()` before agent-initiated execution
- `tool({ hooks: { before, after } })` — input/output transform hooks with error isolation
- `tool.run(ctx, args)` calls hooks but bypasses approval gate (direct invocation)
- Handoff modes: `'oneway'` (default, exits source loop) and `'roundtrip'` (returns result to source)
- Roundtrip handoffs include a `message` parameter for task delegation
- `HandoffRecord.duration` populated with actual execution time
- `session.handoffs()` returns handoff history; `session.fork()` copies it
- `StreamEvent` union expanded: `agent_start`, `agent_end`, `tool_call`, `tool_result`, `handoff`, `tool_approval`
- `stream.steps` getter filters to structural events (excludes tokens and raw steps)
- `tool_approval` stream events emitted for both approvals and denials
- OTel spans: `axl.tool.approval`, `axl.agent.handoff` with mode and duration attributes

#### Tier 1: Production Features
- OpenTelemetry integration with optional `@opentelemetry/api` peer dependency
- Spans for all `ctx.*` primitives with cost-per-span tracking
- `ctx.remember()` / `ctx.recall()` / `ctx.forget()` memory with session and global scopes
- Semantic recall via `VectorStore` + `Embedder` interfaces
- Agent guardrails: `input`/`output` validators with `'retry'` | `'throw'` | custom `onBlock` policies
- `GuardrailError` for blocked outputs
- `runtime.session(id, { history: { maxMessages, summarize }, persist })` for history management

## [0.1.0] - 2026-02-13

### Added

#### Core SDK (`axl`)
- `tool()` factory with Zod input validation, retry policies, and sensitive output redaction
- `agent()` factory with dynamic model/system selection, tool binding, handoffs, and prompt versioning
- `workflow()` factory for named async functions with typed input/output schemas
- `AxlRuntime` for workflow registration, execution, streaming, and session management
- `defineConfig()` for static configuration with provider URIs and environment variables
- `WorkflowContext` with all agentic primitives:
  - `ctx.ask()` — agent invocation with tool-calling loop and schema validation
  - `ctx.spawn()` — concurrent agent execution with optional quorum
  - `ctx.vote()` — consensus voting (majority, unanimous, highest, lowest, mean, median, custom)
  - `ctx.verify()` — self-correcting schema validation with retry and fallback
  - `ctx.budget()` — cost tracking with warn, finish_and_stop, and hard_stop policies
  - `ctx.race()` — first-to-complete with schema validation
  - `ctx.parallel()` — concurrent execution of independent tasks
  - `ctx.map()` — concurrent mapping with bounded concurrency and quorum
  - `ctx.awaitHuman()` — human-in-the-loop suspension and resume
  - `ctx.checkpoint()` — durable execution with checkpoint-replay semantics
  - `ctx.log()` — structured event logging
- Provider adapters for OpenAI and Anthropic (raw `fetch`, zero SDK dependencies)
- `ProviderRegistry` with factory pattern and lazy instantiation
- State stores: `MemoryStore`, `SQLiteStore` (better-sqlite3), `RedisStore` (ioredis)
- `Session` class with multi-turn history, fork, and streaming support
- `AxlStream` (Readable + AsyncIterable + EventEmitter) for streaming workflows
- MCP (Model Context Protocol) support with stdio and HTTP transports
- Context window management with automatic summarization
- Error hierarchy: `AxlError`, `VerifyError`, `QuorumNotMet`, `NoConsensus`, `TimeoutError`, `BudgetExceededError`, `MaxTurnsError`, `ToolDenied`

#### Testing Utilities (`axl-testing`)
- `MockProvider` with sequence, echo, json, replay, and fn modes
- `MockTool` wrapper for tool mocking
- `AxlTestRuntime` mirroring `WorkflowContext` for deterministic testing

#### Evaluation Framework (`axl-eval`)
- `dataset()` factory with inline and file loading
- `scorer()` for deterministic scoring functions
- `llmScorer()` for LLM-as-judge evaluation
- `defineEval()` for eval discovery
- `runEval()` with concurrent execution
- `evalCompare()` for regression and improvement detection
- CLI entry point (`axl-eval`) for running evaluations
