/**
 * One-shot message pushed from the host into the Ink tree.
 *
 * The render bridge rebuilds props roughly ten times a second, so a bare
 * message string would be re-toasted on every tick. The monotonic id lets the
 * component fire exactly once per distinct notice.
 */
export interface DashboardNotice {
  id: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** How long the toast stays up; defaults by severity (2–4 s). */
  durationMs?: number;
}
