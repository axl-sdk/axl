/**
 * Tolerant JSON parser for progressive structured-output streaming.
 *
 * Accepts partial / truncated JSON and returns the longest parseable prefix
 * as a structured value. Used by `ctx.ask({ schema })` while streaming so
 * consumers can render fields as they arrive — see `partial_object` AxlEvent.
 *
 * Scope (intentional minimum):
 *   - Single-pass tokenizer + recursive-descent state machine.
 *   - Only TRAILING truncation is tolerated. Mid-document malformed input
 *     throws. (A consumer rendering progressive output sees one well-formed
 *     subtree at a time, never bogus shape changes.)
 *   - Supports objects, arrays, strings (with `\"` `\\` `\n` `\t` `\r` `\b`
 *     `\f` `\/` `\uXXXX`), numbers (int/float/exp/negative), `true` /
 *     `false` / `null`.
 *   - Rejects: trailing commas, comments, unquoted keys.
 *
 * Truncation recovery:
 *   - Unterminated string  → return content parsed so far.
 *   - Unterminated number  → return valid prefix if it's a complete number;
 *                            drop the key/value if the prefix is malformed
 *                            (`-`, `1.`, `1e` → drop).
 *   - Unclosed `[`         → array with parsed elements.
 *   - Unclosed `{`         → object with parsed pairs. A key without a value
 *                            is dropped.
 *   - `,` or `:` at EOF    → ignored; the last complete value wins.
 *
 * Zero runtime deps. ~250 LOC.
 */

/**
 * Maximum nesting depth we'll accept before throwing. LLM responses
 * don't organically produce 256-deep nested structures — a deeply-
 * adversarial provider returning `[[[[[...]]]]]` can exhaust V8's
 * default ~10k-frame stack via the recursive-descent walker (each
 * `parseValue` → `parseArray/Object` pair consumes ~3 frames). The
 * cap is an availability guard, not a correctness limit.
 */
const MAX_DEPTH = 256;

/** Parse a JSON-shaped string that may be truncated mid-stream. */
export function parsePartialJson(input: string): unknown {
  const parser = new PartialParser(input);
  parser.skipWhitespace();
  if (parser.eof()) return undefined;
  const result = parser.parseValue();
  return result.value;
}

/** Internal: a single attempt at parsing some prefix of the input. */
type ParseResult = { value: unknown; complete: boolean };

class PartialParser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly src: string) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  peek(): string {
    return this.src[this.pos];
  }

  advance(): string {
    return this.src[this.pos++];
  }

  skipWhitespace(): void {
    while (!this.eof()) {
      const c = this.peek();
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
        this.pos++;
      } else {
        break;
      }
    }
  }

  parseValue(): ParseResult {
    this.skipWhitespace();
    if (this.eof()) return { value: undefined, complete: false };
    const c = this.peek();
    // Gate object/array recursion on the depth counter — scalar parsers
    // don't recurse so they skip the check. Enter/exit via try/finally
    // so any throw from below (EOF, malformed input) still restores the
    // depth counter to its caller-visible state.
    if (c === '{' || c === '[') {
      if (++this.depth > MAX_DEPTH) {
        throw new SyntaxError(
          `Maximum nesting depth exceeded (${MAX_DEPTH}) at position ${this.pos}`,
        );
      }
      try {
        return c === '{' ? this.parseObject() : this.parseArray();
      } finally {
        this.depth--;
      }
    }
    if (c === '"') return this.parseString();
    if (c === 't' || c === 'f') return this.parseBool();
    if (c === 'n') return this.parseNull();
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    throw new SyntaxError(`Unexpected character '${c}' at position ${this.pos}`);
  }

  parseObject(): ParseResult {
    this.advance(); // consume '{'
    const obj: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.eof()) return { value: obj, complete: false };
    if (this.peek() === '}') {
      this.advance();
      return { value: obj, complete: true };
    }
    while (!this.eof()) {
      this.skipWhitespace();
      if (this.eof()) return { value: obj, complete: false };
      // Trailing comma sniff (mid-stream, the previous iteration already
      // consumed a comma): if we see `}` here, the object is closed.
      if (this.peek() === '}') {
        this.advance();
        return { value: obj, complete: true };
      }
      // Key must be a string. Unquoted keys are rejected.
      if (this.peek() !== '"') {
        throw new SyntaxError(`Expected '"' at position ${this.pos}, got '${this.peek()}'`);
      }
      const keyResult = this.parseString();
      if (!keyResult.complete) {
        // Truncated key — drop it; the rest of the object stands.
        return { value: obj, complete: false };
      }
      const key = keyResult.value as string;
      this.skipWhitespace();
      if (this.eof()) return { value: obj, complete: false };
      if (this.peek() !== ':') {
        // Truncated before colon — drop the dangling key.
        return { value: obj, complete: false };
      }
      this.advance(); // consume ':'
      this.skipWhitespace();
      if (this.eof()) return { value: obj, complete: false };
      const valueResult = this.parseValue();
      if (valueResult.value !== undefined || valueResult.complete) {
        obj[key] = valueResult.value;
      }
      if (!valueResult.complete) {
        return { value: obj, complete: false };
      }
      this.skipWhitespace();
      if (this.eof()) return { value: obj, complete: false };
      const next = this.peek();
      if (next === ',') {
        this.advance();
        continue;
      }
      if (next === '}') {
        this.advance();
        return { value: obj, complete: true };
      }
      throw new SyntaxError(`Expected ',' or '}' at position ${this.pos}, got '${next}'`);
    }
    return { value: obj, complete: false };
  }

  parseArray(): ParseResult {
    this.advance(); // consume '['
    const arr: unknown[] = [];
    this.skipWhitespace();
    if (this.eof()) return { value: arr, complete: false };
    if (this.peek() === ']') {
      this.advance();
      return { value: arr, complete: true };
    }
    while (!this.eof()) {
      this.skipWhitespace();
      if (this.eof()) return { value: arr, complete: false };
      if (this.peek() === ']') {
        this.advance();
        return { value: arr, complete: true };
      }
      const elemResult = this.parseValue();
      if (elemResult.value !== undefined || elemResult.complete) {
        arr.push(elemResult.value);
      }
      if (!elemResult.complete) {
        return { value: arr, complete: false };
      }
      this.skipWhitespace();
      if (this.eof()) return { value: arr, complete: false };
      const next = this.peek();
      if (next === ',') {
        this.advance();
        continue;
      }
      if (next === ']') {
        this.advance();
        return { value: arr, complete: true };
      }
      throw new SyntaxError(`Expected ',' or ']' at position ${this.pos}, got '${next}'`);
    }
    return { value: arr, complete: false };
  }

  parseString(): ParseResult {
    this.advance(); // consume opening '"'
    let result = '';
    while (!this.eof()) {
      const c = this.advance();
      if (c === '"') return { value: result, complete: true };
      if (c === '\\') {
        if (this.eof()) {
          // Trailing backslash — drop it, return what we have.
          return { value: result, complete: false };
        }
        const esc = this.advance();
        switch (esc) {
          case '"':
            result += '"';
            break;
          case '\\':
            result += '\\';
            break;
          case '/':
            result += '/';
            break;
          case 'b':
            result += '\b';
            break;
          case 'f':
            result += '\f';
            break;
          case 'n':
            result += '\n';
            break;
          case 'r':
            result += '\r';
            break;
          case 't':
            result += '\t';
            break;
          case 'u': {
            // 4 hex digits
            if (this.pos + 4 > this.src.length) {
              return { value: result, complete: false };
            }
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new SyntaxError(`Invalid \\u escape '${hex}' at position ${this.pos}`);
            }
            this.pos += 4;
            result += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            throw new SyntaxError(`Invalid escape '\\${esc}' at position ${this.pos - 1}`);
        }
      } else {
        result += c;
      }
    }
    // EOF without closing quote.
    return { value: result, complete: false };
  }

  parseNumber(): ParseResult {
    const start = this.pos;
    if (this.peek() === '-') this.advance();
    // Integer part
    while (!this.eof() && this.peek() >= '0' && this.peek() <= '9') this.advance();
    // Fractional part
    if (!this.eof() && this.peek() === '.') {
      this.advance();
      while (!this.eof() && this.peek() >= '0' && this.peek() <= '9') this.advance();
    }
    // Exponent
    if (!this.eof() && (this.peek() === 'e' || this.peek() === 'E')) {
      this.advance();
      if (!this.eof() && (this.peek() === '+' || this.peek() === '-')) this.advance();
      while (!this.eof() && this.peek() >= '0' && this.peek() <= '9') this.advance();
    }
    const text = this.src.slice(start, this.pos);
    // Reject malformed prefixes like '-', '1.', '1e', '1e+'.
    if (text === '' || text === '-' || /\.$/.test(text) || /[eE][+-]?$/.test(text)) {
      return { value: undefined, complete: false };
    }
    const n = Number(text);
    if (Number.isNaN(n)) {
      return { value: undefined, complete: false };
    }
    return { value: n, complete: true };
  }

  parseBool(): ParseResult {
    const remaining = this.src.slice(this.pos);
    if (remaining.startsWith('true')) {
      this.pos += 4;
      return { value: true, complete: true };
    }
    if (remaining.startsWith('false')) {
      this.pos += 5;
      return { value: false, complete: true };
    }
    // Truncated — could be 'tru' or 'fals'. Drop.
    if ('true'.startsWith(remaining) || 'false'.startsWith(remaining)) {
      this.pos = this.src.length;
      return { value: undefined, complete: false };
    }
    throw new SyntaxError(`Expected 'true' or 'false' at position ${this.pos}`);
  }

  parseNull(): ParseResult {
    const remaining = this.src.slice(this.pos);
    if (remaining.startsWith('null')) {
      this.pos += 4;
      return { value: null, complete: true };
    }
    if ('null'.startsWith(remaining)) {
      this.pos = this.src.length;
      return { value: undefined, complete: false };
    }
    throw new SyntaxError(`Expected 'null' at position ${this.pos}`);
  }
}
