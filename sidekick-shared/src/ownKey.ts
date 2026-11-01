/**
 * Own-property lookups for plain-object tables indexed by external strings.
 *
 * `table[key]` also finds inherited members, so a model id, tool name, or
 * error code such as `constructor`, `toString`, or `__proto__` would return an
 * `Object.prototype` member instead of `undefined`.
 *
 * @module ownKey
 */

const hasOwn = Object.prototype.hasOwnProperty;

/** The value stored under `key` in `table` itself, or `undefined`. */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return hasOwn.call(table, key) ? table[key] : undefined;
}

/**
 * Store `value` as an own, enumerable property, even for `__proto__`, which a
 * plain assignment would treat as a prototype change.
 */
export function setOwnValue<T>(table: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(table, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
