import type { Context, Next } from 'hono';
import type { StudioEnv, ApiError } from '../types.js';

export async function errorHandler(c: Context<StudioEnv>, next: Next) {
  try {
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';

    // Determine HTTP status from error properties
    let status = 500;
    if ('status' in (err as object)) {
      const errStatus = (err as { status: unknown }).status;
      if (typeof errStatus === 'number' && errStatus >= 400 && errStatus < 600) {
        status = errStatus;
      }
    } else if (
      code === 'NOT_FOUND' ||
      message.includes('not found') ||
      message.includes('not registered')
    ) {
      status = 404;
    } else if (
      code === 'VALIDATION_ERROR' ||
      message.includes('Expected') ||
      message.includes('invalid')
    ) {
      status = 400;
    }

    const body: ApiError = {
      ok: false,
      error: { code, message },
    };

    return c.json(body, status as 400 | 404 | 500);
  }
}
