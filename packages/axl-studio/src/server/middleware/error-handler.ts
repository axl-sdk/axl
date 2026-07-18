import type { Context } from 'hono';
import type { StudioEnv, ApiError } from '../types.js';
import { redactErrorMessage } from '../redact.js';

export function errorHandler(err: Error, c: Context<StudioEnv>) {
  const rawMessage = err.message;
  const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';

  // Determine HTTP status from error properties. Status classification
  // uses the raw message (not the redacted one) — redaction only affects
  // what the client sees, not how we categorize the error.
  let status = 500;
  if ('status' in err) {
    const errStatus = (err as { status: unknown }).status;
    if (typeof errStatus === 'number' && errStatus >= 400 && errStatus < 600) {
      status = errStatus;
    }
  } else if (code === 'CROSS_PROCESS_RESUME_UNSUPPORTED') {
    status = 409;
  } else if (
    code === 'NOT_FOUND' ||
    code === 'PENDING_DECISION_NOT_FOUND' ||
    rawMessage.includes('not found') ||
    rawMessage.includes('not registered')
  ) {
    status = 404;
  } else if (
    code === 'VALIDATION_ERROR' ||
    code === 'INVALID_HUMAN_DECISION' ||
    rawMessage.includes('Expected') ||
    rawMessage.includes('invalid')
  ) {
    status = 400;
  }

  // Under `trace.redact`, error messages can echo user input
  // (ValidationError includes the failing reason, provider errors often
  // quote the request body, GuardrailError includes the trigger reason).
  // `redactErrorMessage` lets structural errors (Budget/Timeout/MaxTurns/
  // Quorum/NoConsensus) pass through and scrubs the rest.
  const runtime = c.get('runtime');
  const redactOn = runtime?.isRedactEnabled?.() ?? false;

  const body: ApiError = {
    ok: false,
    error: { code, message: redactErrorMessage(err, redactOn) },
  };

  return c.json(body, status as 400 | 404 | 409 | 500);
}
