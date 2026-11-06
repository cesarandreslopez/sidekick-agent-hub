/**
 * Bounded-concurrency `map` for async work over files.
 *
 * @module mapWithConcurrency
 */

/** Maps `values` with at most `maxConcurrency` mapper calls in flight; results keep input order. */
export async function mapWithConcurrency<A, B>(
  values: readonly A[],
  mapper: (value: A) => Promise<B>,
  maxConcurrency: number,
): Promise<B[]> {
  const results = new Array<B>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(maxConcurrency, values.length)) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}
