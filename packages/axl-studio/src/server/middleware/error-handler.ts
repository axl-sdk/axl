import type { Context, Next } from 'hono';
import type { StudioEnv, ApiError } from '../types.js';
import { redactErrorMessage } from '../redact.js';

export async function errorHandler(c: Context<StudioEnv>, next: Next) {
  try {
    await next();
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';

    // Determine HTTP status from error properties. Status classification
    // uses the raw message (not the redacted one) — redaction only affects
    // what the client sees, not how we categorize the error.
    let status = 500;
    if ('status' in (err as object)) {
      const errStatus = (err as { status: unknown }).status;
      if (typeof errStatus === 'number' && errStatus >= 400 && errStatus < 600) {
        status = errStatus;
      }
    } else if (
      code === 'NOT_FOUND' ||
      rawMessage.includes('not found') ||
      rawMessage.includes('not registered')
    ) {
      status = 404;
    } else if (
      code === 'VALIDATION_ERROR' ||
      rawMessage.includes('Expected') ||
      rawMessage.includes('invalid')
    ) {
      status = 400;
    }

    // Under `trace.redact`, error messages can echo user input
    // (ValidationError includes the failing reason, provider errors often
    // quote the request body, GuardrailError includes the trigger reason).
    // `redactErrorMessage` lets structural errors (Budget/Timeout/MaxTurns/
    // Quorum/NoConsensus/ToolDenied) pass through and scrubs the rest.
    const runtime = c.get('runtime');
    const redactOn = runtime?.isRedactEnabled?.() ?? false;

    const body: ApiError = {
      ok: false,
      error: { code, message: redactErrorMessage(err, redactOn) },
    };

    return c.json(body, status as 400 | 404 | 500);
  }
}
