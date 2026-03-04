# Contributing to Axl

## Development Setup

```bash
# Clone the repo
git clone https://github.com/axl-sdk/axl.git
cd axl

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Type check
pnpm typecheck
```

## Project Structure

```
packages/
  axl/           Core SDK: tools, agents, workflows, runtime, providers, state stores
  axl-testing/   Test utilities: MockProvider, MockTool, AxlTestRuntime
  axl-eval/      Evaluation framework: datasets, scorers, LLM-as-judge, CLI
  axl-studio/    Local dev UI: Hono server + React SPA for debugging agents and workflows
docs/            Public documentation (architecture, security, testing, observability, etc.)
```

## Workflow

1. Create a branch from `main`
2. Make your changes
3. Run `pnpm typecheck && pnpm test` to verify
4. Run `pnpm lint` to check formatting
5. Commit with a descriptive message
6. Open a pull request

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: Add new voting strategy
fix: Handle empty content in handoff messages
test: Add integration tests for budget hard_stop
docs: Update README with streaming examples
refactor: Extract token estimation into utility
```

## Running Tests

```bash
# All tests
pnpm test

# Single package
pnpm -F axl test
pnpm -F @axlsdk/testing test
pnpm -F @axlsdk/eval test
pnpm -F @axlsdk/studio test

# Watch mode
pnpm -F axl test:watch

# Specific test file
pnpm -F axl test -- agent

# Integration tests (requires API keys)
source .env && pnpm -F axl test -- integration-advanced --reporter=verbose
```

Integration tests require `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` in a `.env` file. They are automatically skipped when keys are not present.

## Code Conventions

- **TypeScript strict mode** — all code must pass `tsc --noEmit`
- **ESM imports** — use `.js` extension on all relative imports
- **Zod schemas** — use Zod for all input validation
- **No SDK dependencies** — provider adapters use raw `fetch`
- **Error hierarchy** — extend `AxlError` for all custom errors
- **Testing** — write tests for all new features; use MockProvider for unit tests

## Adding a New Provider

1. Create `packages/axl/src/providers/yourprovider.ts`
2. Implement the `Provider` interface (`chat` and `stream` methods)
3. Register the factory in `packages/axl/src/providers/registry.ts`
4. Add tests in `packages/axl/src/__tests__/`

## Adding a New Context Primitive

1. Add the method to `WorkflowContext` in `packages/axl/src/context.ts`
2. Add corresponding types to `packages/axl/src/types.ts`
3. Export from `packages/axl/src/index.ts`
4. Mirror the method in `AxlTestRuntime` in `packages/axl-testing/src/test-runtime.ts`
5. Add unit tests and integration tests

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
