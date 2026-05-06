/**
 * Streaming walker for progressive structured-output emission.
 *
 * Drives `string_delta` and `partial_object` event emissions during a
 * schema-mode `ctx.ask()` call. The walker is fed each provider
 * `text_delta` chunk in order; it walks chars and reports back via
 * callbacks:
 *
 *   - `onStringDelta(path, delta)` — flushed at end-of-chunk or on string
 *     close. Each invocation carries the unescaped chars accumulated for
 *     one (chunk, path) pair. JSON escapes (`\\n`, `\\"`, `\\uXXXX`, ...)
 *     are translated; surrogate pairs emit as two consecutive code units.
 *   - `onStructuralBoundary()` — fired when a `,`/`}`/`]` lands outside a
 *     string. The caller runs `parsePartialJson(content)` and emits a
 *     `partial_object` event. Same trigger as the pre-0.18 walker.
 *
 * The walker tracks JSON Pointer paths (RFC 6901) by maintaining a frame
 * stack: ObjectFrame{currentKey?} | ArrayFrame{currentIndex}. The path to
 * the current value is the concatenation of `/<segment>` per frame.
 *
 * State is reset by constructing a fresh walker. Schema retries get a new
 * walker — the conversation is replayed and the next attempt starts from
 * a clean slate. Same gating as `partial_object` (schema set, no tools,
 * root is `ZodObject`); construction is a no-op when gating is false.
 *
 * Standalone module, no Zod or AxlEvent imports — keeps it unit-testable
 * and re-usable. The integration site in `context.ts` adapts callbacks
 * into emitEvent() calls.
 */

/** Maximum nesting depth before the walker bails. Mirrors `parsePartialJson`'s
 *  256-frame cap — adversarial nesting is an availability guard, not a
 *  correctness limit. */
const MAX_DEPTH = 256;

/**
 * One frame of the JSON container stack. Container is whatever is currently
 * open and accepting child values.
 *
 * Object: `currentKey` is set after the key string closes; remains set
 * across the value being read so path computation can include it. Cleared
 * when the next key starts (a new key string opens after `,`).
 *
 * Array: `currentIndex` is the index of the value currently being read.
 * Incremented on `,` between values. Starts at 0 when `[` is pushed.
 */
type Frame = { type: 'object'; currentKey?: string } | { type: 'array'; currentIndex: number };

/** RFC 6901 path-segment encoding. `~` escapes first (so the `/` we add
 *  doesn't get re-escaped), then `/`. Numbers stringify directly. */
function encodeSegment(s: string | number): string {
  if (typeof s === 'number') return String(s);
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Compute the JSON Pointer to the value currently being read. Walks the
 *  stack oldest-to-newest and concatenates `/<segment>`. Empty stack →
 *  empty path (root document — never used here because gating requires
 *  a ZodObject root, so the document is always an object). */
function computePath(stack: readonly Frame[]): string {
  let path = '';
  for (const frame of stack) {
    if (frame.type === 'object') {
      path += '/' + encodeSegment(frame.currentKey ?? '');
    } else {
      path += '/' + encodeSegment(frame.currentIndex);
    }
  }
  return path;
}

/**
 * Fine-grained walker state.
 *
 * `pre-json` and `done` are terminal in the sense that they ignore most
 * chars — `pre-json` scans for the opening `{`, `done` ignores everything
 * after the root closes (including trailing prose / markdown fence
 * closers).
 *
 * The other states implement the JSON grammar at the granularity needed
 * to track keys, values, and structural boundaries.
 */
type WalkerState =
  | 'pre-json'
  | 'expect-key-or-close'
  | 'read-key'
  | 'expect-colon'
  | 'expect-value'
  | 'read-value-string'
  | 'read-value-other'
  | 'expect-comma-close'
  | 'done';

/**
 * Callbacks fired by the walker. Both run synchronously from inside
 * `processChunk` — the integration site in `context.ts` decides what
 * (if anything) to emit on the AxlEvent bus.
 */
export interface StreamingWalkerCallbacks {
  /** Fired with a non-empty unescaped delta for `path`. Path is a JSON
   *  Pointer (RFC 6901). Multiple calls per chunk are possible if the
   *  chunk crosses string boundaries into different fields. */
  onStringDelta?(path: string, delta: string): void;
  /** Fired when a structural boundary (`,`, `}`, `]`) lands outside a
   *  string. Caller decides whether to re-parse the accumulated content
   *  and emit a `partial_object` event. */
  onStructuralBoundary?(): void;
}

/**
 * Streaming walker — incremental JSON state machine driving structured-output
 * deltas. See module doc.
 *
 * Usage (per ask):
 * ```
 * const w = new StreamingWalker({ onStringDelta, onStructuralBoundary });
 * for await (const chunk of provider.stream(...)) {
 *   if (chunk.type === 'text_delta') w.processChunk(chunk.content);
 * }
 * ```
 */
export class StreamingWalker {
  private state: WalkerState = 'pre-json';
  private stack: Frame[] = [];

  // String parsing state — survives across chunks so escapes can split.
  private escaped = false;
  /** When > 0, we're collecting `\\uXXXX` hex digits. 4→0 as digits arrive. */
  private unicodePending = 0;
  /** Accumulator for `\\uXXXX` digits. Cleared when the escape resolves. */
  private unicodeBuf = '';

  // Per-string accumulators.
  private keyBuf = '';
  private deltaBuf = '';

  /** Cached JSON Pointer to the value currently being read. Recomputed
   *  on entry to `read-value-string` (the only state that needs it). */
  private currentPath = '';

  /** Set true when a structural boundary lands. Caller reads via
   *  `consumeBoundary()` after each chunk to decide on partial_object emit. */
  private boundaryPending = false;

  constructor(private readonly callbacks: StreamingWalkerCallbacks) {}

  /** Walk `text` char-by-char, advancing state and accumulating deltas.
   *  Calls `onStringDelta` at end-of-chunk for any pending value text. */
  processChunk(text: string): void {
    for (let i = 0; i < text.length; i++) {
      // Done check stays inside the loop. Pulling it out as an early
      // return makes TS narrow `this.state` to exclude 'done' for the
      // rest of the function, which then fails the inside-loop check
      // ("comparison appears unintentional").
      if (this.state === 'done') return;
      this.processChar(text[i]);
    }

    // End-of-chunk flush. Only flush when we're still inside a value
    // string — `deltaBuf` is reset to empty whenever we leave that state,
    // so this is also the only state where it's non-empty here.
    if (this.deltaBuf.length > 0 && this.state === 'read-value-string') {
      this.callbacks.onStringDelta?.(this.currentPath, this.deltaBuf);
      this.deltaBuf = '';
    }
  }

  /** Read-and-clear the structural-boundary flag. Caller checks this
   *  after `processChunk` to decide whether to emit `partial_object`. */
  consumeBoundary(): boolean {
    const v = this.boundaryPending;
    this.boundaryPending = false;
    return v;
  }

  /** True when the walker has decided it's done with this stream
   *  (root closed or fatal malformed input). Caller may use this to
   *  short-circuit further work. */
  get isDone(): boolean {
    return this.state === 'done';
  }

  // ── Per-char dispatch ───────────────────────────────────────────────────

  private processChar(ch: string): void {
    switch (this.state) {
      case 'pre-json':
        // Scan forward for the opening `{`. Whitespace and prose
        // (including stray `"` chars in prose) are silently skipped.
        // Markdown fence openers (` ```json\n`) fall through here too —
        // we just look for the brace.
        if (ch === '{') {
          if (!this.pushFrame({ type: 'object' })) return;
          this.state = 'expect-key-or-close';
        }
        return;

      case 'expect-key-or-close':
        if (isWhitespace(ch)) return;
        if (ch === '}') {
          this.popFrame();
          return;
        }
        if (ch === '"') {
          this.keyBuf = '';
          this.escaped = false;
          this.unicodePending = 0;
          this.unicodeBuf = '';
          this.state = 'read-key';
          return;
        }
        // Anything else is malformed — terminate.
        this.state = 'done';
        return;

      case 'read-key':
        this.processStringChar(ch, /* isValue */ false);
        return;

      case 'expect-colon':
        if (isWhitespace(ch)) return;
        if (ch === ':') {
          this.state = 'expect-value';
          return;
        }
        this.state = 'done';
        return;

      case 'expect-value':
        if (isWhitespace(ch)) return;
        if (ch === '{') {
          if (!this.pushFrame({ type: 'object' })) return;
          this.state = 'expect-key-or-close';
          return;
        }
        if (ch === '[') {
          if (!this.pushFrame({ type: 'array', currentIndex: 0 })) return;
          this.state = 'expect-value';
          return;
        }
        if (ch === ']') {
          // Empty array close (`[ ]`) — pop, treat as boundary.
          this.popFrame();
          return;
        }
        if (ch === '"') {
          // Entering a string VALUE. Compute path now (cached for the
          // whole string read). Reset string-parser state.
          this.currentPath = computePath(this.stack);
          this.deltaBuf = '';
          this.escaped = false;
          this.unicodePending = 0;
          this.unicodeBuf = '';
          this.state = 'read-value-string';
          return;
        }
        if (isValueStartChar(ch)) {
          this.state = 'read-value-other';
          return;
        }
        this.state = 'done';
        return;

      case 'read-value-string':
        this.processStringChar(ch, /* isValue */ true);
        return;

      case 'read-value-other':
        // Number / true / false / null. Consume until a structural
        // separator or whitespace; then re-process the separator in
        // `expect-comma-close`.
        if (ch === ',' || ch === '}' || ch === ']' || isWhitespace(ch)) {
          this.state = 'expect-comma-close';
          this.processChar(ch); // re-process separator/whitespace
          return;
        }
        return;

      case 'expect-comma-close':
        if (isWhitespace(ch)) return;
        if (ch === ',') {
          this.boundaryPending = true;
          const top = this.stack[this.stack.length - 1];
          if (!top) {
            // Comma at root — malformed.
            this.state = 'done';
            return;
          }
          if (top.type === 'object') {
            // Clear key for the next pair.
            top.currentKey = undefined;
            this.state = 'expect-key-or-close';
          } else {
            top.currentIndex += 1;
            this.state = 'expect-value';
          }
          return;
        }
        if (ch === '}' || ch === ']') {
          this.popFrame();
          return;
        }
        // Stray char — terminate.
        this.state = 'done';
        return;

      case 'done':
        return;
    }
  }

  // ── String state machine (shared between key and value reads) ───────────

  /**
   * One char inside a string. Translates JSON escapes, accumulates
   * `\\uXXXX` digits across chunks, and routes the resolved char to
   * either `keyBuf` (when reading a key) or `deltaBuf` (when reading a
   * value).
   */
  private processStringChar(ch: string, isValue: boolean): void {
    // 1) Collecting `\\uXXXX` hex digits.
    if (this.unicodePending > 0) {
      if (isHex(ch)) {
        this.unicodeBuf += ch;
        this.unicodePending -= 1;
        if (this.unicodePending === 0) {
          const code = parseInt(this.unicodeBuf, 16);
          this.unicodeBuf = '';
          this.appendChar(String.fromCharCode(code), isValue);
        }
      } else {
        // Malformed `\\u`. Mirror the existing parser (which throws);
        // here we terminate the walker so the upper layer's
        // `parsePartialJson` will be the one to surface the error if
        // the JSON gets re-parsed at the next boundary.
        this.state = 'done';
      }
      return;
    }

    // 2) Previous char was `\\`.
    if (this.escaped) {
      this.escaped = false;
      switch (ch) {
        case '"':
          this.appendChar('"', isValue);
          return;
        case '\\':
          this.appendChar('\\', isValue);
          return;
        case '/':
          this.appendChar('/', isValue);
          return;
        case 'b':
          this.appendChar('\b', isValue);
          return;
        case 'f':
          this.appendChar('\f', isValue);
          return;
        case 'n':
          this.appendChar('\n', isValue);
          return;
        case 'r':
          this.appendChar('\r', isValue);
          return;
        case 't':
          this.appendChar('\t', isValue);
          return;
        case 'u':
          this.unicodePending = 4;
          this.unicodeBuf = '';
          return;
        default:
          // Invalid escape — terminate.
          this.state = 'done';
          return;
      }
    }

    // 3) Backslash starts an escape.
    if (ch === '\\') {
      this.escaped = true;
      return;
    }

    // 4) Closing quote ends the string.
    if (ch === '"') {
      if (isValue) {
        // Flush pending delta, then transition out.
        if (this.deltaBuf.length > 0) {
          this.callbacks.onStringDelta?.(this.currentPath, this.deltaBuf);
          this.deltaBuf = '';
        }
        this.state = 'expect-comma-close';
      } else {
        // Key string close — set the key on the current object frame.
        const top = this.stack[this.stack.length - 1];
        if (!top || top.type !== 'object') {
          this.state = 'done';
          return;
        }
        top.currentKey = this.keyBuf;
        this.keyBuf = '';
        this.state = 'expect-colon';
      }
      return;
    }

    // 5) Regular char.
    this.appendChar(ch, isValue);
  }

  private appendChar(c: string, isValue: boolean): void {
    if (isValue) {
      this.deltaBuf += c;
    } else {
      this.keyBuf += c;
    }
  }

  // ── Frame stack ─────────────────────────────────────────────────────────

  /** Push a frame onto the stack. Returns false if the stack is at the
   *  depth cap — in which case the walker is also moved to `done` so the
   *  caller's subsequent state assignment must be guarded. */
  private pushFrame(frame: Frame): boolean {
    if (this.stack.length >= MAX_DEPTH) {
      // Adversarial nesting — bail. parsePartialJson's matching cap will
      // throw and skip the partial_object emit; we just stop walking.
      this.state = 'done';
      return false;
    }
    this.stack.push(frame);
    return true;
  }

  /** Pop a frame on `}` or `]`, fire boundary, transition to next state.
   *  Defensive on empty stack — the state machine never invokes this
   *  without an enclosing container today (callers gate on state, and
   *  state transitions out of `pre-json` / `done` only after pushing),
   *  but a future state-machine bug could land us here with nothing to
   *  pop. Fail closed (move to `done`, no spurious boundary fire). */
  private popFrame(): void {
    if (this.stack.length === 0) {
      this.state = 'done';
      return;
    }
    this.stack.pop();
    this.boundaryPending = true;
    if (this.stack.length === 0) {
      // Root closed. We're done — ignore trailing prose / fence closers.
      this.state = 'done';
    } else {
      this.state = 'expect-comma-close';
    }
  }
}

// ── Char predicates (kept module-local for inlining) ──────────────────────

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isHex(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

/** A char that could begin a non-string, non-container JSON value:
 *  number (incl. leading `-`), or `t`/`f`/`n` for true/false/null. */
function isValueStartChar(ch: string): boolean {
  return ch === '-' || (ch >= '0' && ch <= '9') || ch === 't' || ch === 'f' || ch === 'n';
}
