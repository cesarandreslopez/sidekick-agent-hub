/** Parse an optional positive base-10 integer limit without partial coercion. */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('Limit must be a positive integer.');
  }
  return Number.parseInt(raw, 10);
}
