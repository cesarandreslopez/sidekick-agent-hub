/**
 * Minimal RFC 4180 CSV writer for `--csv` output.
 *
 * Every read command that has a tabular answer can hand rows to `toCsv` so
 * spreadsheets and scripts get the same numbers the terminal table shows,
 * without a second code path per command.
 */

export type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  /** Header text. */
  header: string;
  /** Cell value for a row. */
  value: (row: T) => CsvValue;
}

function escapeCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' && !Number.isFinite(value) ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render rows as CSV with a header line and `\n` line endings. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((column) => escapeCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(column.value(row))).join(','));
  }
  return lines.join('\n') + '\n';
}
