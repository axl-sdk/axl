import { warnDiagnosticOnce } from '../schema-diagnostics.js';
import type { SessionUpdate, StateStore } from './types.js';

/**
 * `updateSession` for a subclass of a built-in store that overrides
 * `saveSession` or `getSession`, for example to encrypt or audit.
 *
 * The built-in versions work on the stored value directly, which would skip
 * those overrides without a sound, and an encrypting subclass would write
 * plaintext. So this goes through the overrides instead, and gives up the
 * protection against another process's write, because only the subclass can
 * make its own read and write atomic.
 */
export async function updateSessionThroughOverrides(
  store: Pick<StateStore, 'getSession' | 'saveSession'>,
  storeName: string,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  warnDiagnosticOnce(
    `session_update_overridden\0${storeName}`,
    `${storeName}: this subclass overrides saveSession or getSession, so session turns go ` +
      'through them, and overlapping turns from different instances can overwrite each other. ' +
      'Override updateSession too to keep that protection.',
    undefined,
    'docs/api-reference.md#several-app-instances-sharing-a-session',
  );
  const stored = await store.getSession(sessionId);
  const next = update(stored.length > 0 ? stored : null);
  if (next !== null) await store.saveSession(sessionId, next);
}
