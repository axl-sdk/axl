import { types as nodeTypes } from 'node:util';
import { ToolModelOutputError } from './errors.js';
import type { ToolModelOutput } from './tool.js';

function invalid(path: string, reason: string): Error {
  return new Error(`Invalid tool model output at ${path}: ${reason}`);
}

function propertyPath(parent: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parent}.${key}`;
  let escaped = '';
  for (const character of key) {
    const code = character.charCodeAt(0);
    if (character === '\\' || character === '"') escaped += `\\${character}`;
    else if (code <= 0x1f || code === 0x2028 || code === 0x2029) {
      escaped += `\\u${code.toString(16).padStart(4, '0')}`;
    } else escaped += character;
  }
  return `${parent}["${escaped}"]`;
}

function normalize(value: unknown, path: string, stack: WeakSet<object>): ToolModelOutput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(path, 'number must be finite');
    return value;
  }

  if (value === undefined) throw invalid(path, 'undefined is only allowed on object properties');
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw invalid(path, `unsupported ${typeof value}`);
  }
  if (typeof value !== 'object') throw invalid(path, `unsupported ${typeof value}`);

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    // Descriptor maps are ordinary objects. Remove their prototype before any
    // keyed lookup so ambient Object.prototype pollution cannot masquerade as
    // an own array element or trigger an inherited accessor.
    Object.setPrototypeOf(descriptors, null);
  } catch (cause) {
    throw invalid(
      path,
      `object inspection failed (${cause instanceof Error ? cause.name : 'error'})`,
    );
  }

  if (stack.has(value)) throw invalid(path, 'cyclic reference');

  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof PropertyDescriptorMap];
    if (descriptor && !('value' in descriptor)) {
      throw invalid(
        typeof key === 'string' ? propertyPath(path, key) : `${path}[symbol]`,
        'accessor properties are not supported',
      );
    }
    if (typeof key === 'symbol') {
      throw invalid(`${path}[symbol]`, 'symbol keys are not supported');
    }
  }

  if (typeof descriptors.toJSON?.value === 'function') {
    throw invalid(propertyPath(path, 'toJSON'), 'custom toJSON is not supported');
  }

  const array = Array.isArray(value);
  if (array && prototype !== Array.prototype && prototype !== null) {
    throw invalid(path, 'array subclasses are not supported');
  }
  const inheritedToJSON =
    prototype === Array.prototype || prototype === Object.prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'toJSON')
      : undefined;
  if (typeof inheritedToJSON?.value === 'function') {
    throw invalid(propertyPath(path, 'toJSON'), 'inherited custom toJSON is not supported');
  }
  const inheritedThen =
    prototype === Array.prototype || prototype === Object.prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'then')
      : undefined;
  if (
    typeof descriptors.then?.value === 'function' ||
    (inheritedThen !== undefined &&
      (!('value' in inheritedThen) || typeof inheritedThen.value === 'function'))
  ) {
    throw invalid(path, 'thenable output is not supported');
  }

  stack.add(value);
  try {
    if (array) {
      const normalized: ToolModelOutput[] = [];
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw invalid(propertyPath(path, 'length'), 'array length is invalid');
      }
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
          throw invalid(`${path}[${index}]`, 'arrays must be dense data properties');
        }
        if (descriptor.value === undefined) {
          throw invalid(`${path}[${index}]`, 'array values cannot be undefined');
        }
        normalized.push(normalize(descriptor.value, `${path}[${index}]`, stack));
      }

      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable) continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
          throw invalid(propertyPath(path, key), 'non-index array properties are not supported');
        }
      }
      Object.setPrototypeOf(normalized, null);
      return normalized;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(path, 'only plain objects and null-prototype records are supported');
    }

    const normalized = Object.create(null) as Record<string, ToolModelOutput>;
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable) continue;
      if (!('value' in descriptor)) {
        throw invalid(propertyPath(path, key), 'accessor properties are not supported');
      }
      if (descriptor.value === undefined) continue;
      normalized[key] = normalize(descriptor.value, propertyPath(path, key), stack);
    }
    return normalized;
  } finally {
    stack.delete(value);
  }
}

/** Validate and render an explicit model-facing tool result. */
export function serializeToolModelOutput(toolName: string, output: unknown): string {
  try {
    if (nodeTypes.isPromise(output)) {
      // Async projectors are unsupported, but a rejected Promise must still be
      // observed or Node may emit an unhandled rejection after we fail closed.
      // Call the intrinsic directly so Promise subclasses cannot override it.
      void Promise.prototype.then.call(output, undefined, () => undefined);
    }
    if (typeof output === 'string') return output;
    return JSON.stringify(normalize(output, '$', new WeakSet<object>()));
  } catch (cause) {
    throw new ToolModelOutputError(toolName, cause);
  }
}
