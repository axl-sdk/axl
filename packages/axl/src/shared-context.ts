/**
 * Ambient state shared by compatible loads of this package in one JS realm.
 *
 * Each protocol has its own registry key, so an incompatible copy cannot
 * prevent compatible copies from joining. The guard has a stable key across
 * protocols: a copy can see another copy's active scope and refuse to lose
 * its spend.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

/** Replaced by tsup; source tests use the fallbacks below. */
declare const __AXL_BUILD_PATH__: string;
declare const __AXL_PACKAGE_VERSION__: string;

const PROTOCOL = 1;
const CONTEXT_KEY = Symbol.for(`axl.accounting.context.v${PROTOCOL}`);
const GUARD_KEY = Symbol.for('axl.accounting.scopeGuard');

export type CopyIdentity = { path: string; version: string };
export type ScopeGuard = {
  contextId: symbol;
  owner: CopyIdentity;
  markUninstrumented(): void;
  /** Older guard implementations may omit this; treat them as active. */
  isActive?(): boolean;
};

type SharedContext = {
  protocol: number;
  id: symbol;
  accounting: AsyncLocalStorage<unknown>;
  dispatch: AsyncLocalStorage<unknown>;
  capture: AsyncLocalStorage<unknown>;
  correlation: AsyncLocalStorage<unknown>;
  turn: AsyncLocalStorage<unknown>;
  nextOperationId(): string;
};

type SharedGuard = {
  storage: AsyncLocalStorage<ScopeGuard>;
  warned: WeakMap<CopyIdentity, WeakSet<CopyIdentity>>;
};

function createContext(): SharedContext {
  let operationCounter = 0;
  return {
    protocol: PROTOCOL,
    id: Symbol('axl.accounting.context.instance'),
    accounting: new AsyncLocalStorage(),
    dispatch: new AsyncLocalStorage(),
    capture: new AsyncLocalStorage(),
    correlation: new AsyncLocalStorage(),
    turn: new AsyncLocalStorage(),
    nextOperationId: () => `op_${++operationCounter}`,
  };
}

function isStorage(value: unknown): value is AsyncLocalStorage<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncLocalStorage<unknown>).getStore === 'function' &&
    typeof (value as AsyncLocalStorage<unknown>).run === 'function'
  );
}

function isCompatible(value: unknown): value is SharedContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SharedContext>;
  return (
    candidate.protocol === PROTOCOL &&
    typeof candidate.id === 'symbol' &&
    isStorage(candidate.accounting) &&
    isStorage(candidate.dispatch) &&
    isStorage(candidate.capture) &&
    isStorage(candidate.correlation) &&
    isStorage(candidate.turn) &&
    typeof candidate.nextOperationId === 'function'
  );
}

const registry = globalThis as Record<symbol, unknown>;
const installed = registry[CONTEXT_KEY];
// Never overwrite a malformed entry in this protocol's slot. The local
// fallback can still account for its own work, while the stable guard blocks
// crossings into a context it cannot join.
export const sharedContext: SharedContext =
  installed === undefined
    ? ((registry[CONTEXT_KEY] = createContext()) as SharedContext)
    : isCompatible(installed)
      ? installed
      : createContext();

const installedGuard = registry[GUARD_KEY];
export const sharedGuard: SharedGuard =
  typeof installedGuard === 'object' &&
  installedGuard !== null &&
  isStorage((installedGuard as Partial<SharedGuard>).storage) &&
  (installedGuard as Partial<SharedGuard>).warned instanceof WeakMap
    ? (installedGuard as SharedGuard)
    : ((registry[GUARD_KEY] = {
        storage: new AsyncLocalStorage<ScopeGuard>(),
        warned: new WeakMap<CopyIdentity, WeakSet<CopyIdentity>>(),
      }) as SharedGuard);

// The build injects the resolved entry path and package version for each format.
// Source-only tests have no build metadata, but still retain a distinct owner.
const buildPath = typeof __AXL_BUILD_PATH__ === 'string' ? __AXL_BUILD_PATH__ : '<source>';
export const thisCopy: CopyIdentity = {
  path: buildPath.startsWith('file:') ? fileURLToPath(buildPath) : buildPath,
  version: typeof __AXL_PACKAGE_VERSION__ === 'string' ? __AXL_PACKAGE_VERSION__ : 'unknown',
};

/** One warning per pair, regardless of which copy first entered the other's scope. */
export function warnCrossCopy(other: CopyIdentity, joined: boolean): void {
  if (other === thisCopy) return;
  if (sharedGuard.warned.get(other)?.has(thisCopy)) return;
  const fromThis = sharedGuard.warned.get(thisCopy) ?? new WeakSet<CopyIdentity>();
  if (fromThis.has(other)) return;
  fromThis.add(other);
  sharedGuard.warned.set(thisCopy, fromThis);
  try {
    console.warn(
      `[axl] Cross-copy accounting: ${other.path} (v${other.version}) and ` +
        `${thisCopy.path} (v${thisCopy.version}). ` +
        (joined
          ? 'Shared accounting, admission, and request capture context joined.'
          : 'Accounting protocols could not join; paid work is refused and the active scope is incomplete.'),
    );
  } catch {
    // A broken/custom logger cannot change the outcome of a paid operation.
  }
}
