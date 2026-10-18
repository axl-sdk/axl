import type { ExecutionCursor } from '@axlsdk/axl';

/** Encode a history position as the opaque `cursor` query value. */
export function encodeExecutionCursor(cursor: ExecutionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode a `cursor` query value. Returns `undefined` when it is not one this server issued. */
export function decodeExecutionCursor(value: string): ExecutionCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { startedAt, executionId } = parsed as Record<string, unknown>;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  if (typeof executionId !== 'string' || executionId === '') return undefined;
  return { startedAt, executionId };
}
