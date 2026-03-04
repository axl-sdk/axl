# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Axl, please report it responsibly.

**Email:** <security@axlsdk.com>

Please include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

**Please do not open a public GitHub issue for security vulnerabilities.**

## Supported Versions

| Version      | Supported |
|--------------|-----------|
| 0.x (latest) | Yes       |

## Security Model

Axl provides several built-in security mechanisms for agentic systems. See [docs/security.md](./docs/security.md) for full details:

- **Tool ACL** — Agents can only invoke tools in their `tools` configuration
- **Handoff isolation** — Handoff targets operate with their own tool ACL, no privilege escalation
- **Input sanitization** — Zod schema validation on all tool arguments before handler execution
- **Approval gates** — `requireApproval` on tools suspends the workflow for human review; resolved via `runtime.resolveDecision()`
- **Agent guardrails** — User-defined input/output validation functions run at the agent boundary, with retry, throw, or custom block policies
- **Budget controls** — `ctx.budget()` prevents runaway costs
- **Turn limits** — `maxTurns` prevents infinite tool-call loops
- **Secrets handling** — API keys are never included in LLM prompts or traces
- **Sensitive tools** — `sensitive: true` redacts return values from LLM context
