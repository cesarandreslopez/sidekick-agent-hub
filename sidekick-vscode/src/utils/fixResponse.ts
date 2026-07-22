/** True only for a leading natural-language refusal, not code containing refusal words. */
export function isFixRefusal(response: string): boolean {
  const firstLine = response.trimStart().split(/\r?\n/, 1)[0].trim();
  return /^(?:i\s+)?(?:cannot|can't|am\s+unable\s+to|unable\s+to|need\s+more\s+context)\b/i.test(
    firstLine,
  );
}
