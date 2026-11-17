/**
 * Keeps keyboard focus across a list re-render. The live lists (tool rows,
 * the activity timeline, notifications, error groups) are rebuilt with
 * `innerHTML`, which destroys the focused control and drops focus to
 * `<body>`. Capture which keyed row and which control in it had focus before
 * the rebuild, and focus the same control in the new markup afterwards, or
 * the nearest row's when that row is gone.
 *
 * @module webview/dashboard/focus
 */

export interface FocusSnapshot {
  /** The focused row's key (the value of the key attribute). */
  key: string;
  /** Which control in the row: `button.tool-toggle`, or '' for the row itself. */
  control: string;
  /** The row's position, for a neighbour when it disappears. */
  index: number;
}

function rowsOf(container: Element, keyAttr: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${keyAttr}]`));
}

/** Tag plus first class: enough to find the same control in a rebuilt row. */
function controlSelector(el: Element): string {
  const first = el.classList.item(0);
  // The dashboard's own class names are plain identifiers; anything else is
  // matched by tag alone rather than escaped.
  return el.tagName.toLowerCase() + (first && /^[\w-]+$/.test(first) ? `.${first}` : '');
}

function isFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.hidden) return false;
  if (el.tabIndex >= 0) return true;
  return /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
}

/** The focused control inside `container`'s keyed rows, or null. */
export function captureFocus(container: Element, keyAttr: string): FocusSnapshot | null {
  const active = container.ownerDocument.activeElement;
  if (!active || active === container || !container.contains(active)) return null;
  const row = active.closest(`[${keyAttr}]`);
  if (!row || !container.contains(row)) return null;
  const key = row.getAttribute(keyAttr);
  if (key === null) return null;
  return {
    key,
    control: active === row ? '' : controlSelector(active),
    index: rowsOf(container, keyAttr).indexOf(row as HTMLElement),
  };
}

function controlIn(row: HTMLElement, control: string): HTMLElement | null {
  if (!control) return isFocusable(row) ? row : null;
  const found = row.querySelector<HTMLElement>(control);
  return found && isFocusable(found) ? found : null;
}

/**
 * Focus the captured control again after a rebuild: the same row's control,
 * or else the nearest row (after it, then before it) that has one. Nothing
 * happens without a snapshot, so a rebuild never steals focus from elsewhere.
 */
export function restoreFocus(
  container: Element,
  keyAttr: string,
  snapshot: FocusSnapshot | null,
): void {
  if (!snapshot) return;
  const rows = rowsOf(container, keyAttr);
  const same = rows.find((row) => row.getAttribute(keyAttr) === snapshot.key);
  let target = same ? controlIn(same, snapshot.control) : null;
  if (!target) {
    const start = same ? rows.indexOf(same) : Math.min(snapshot.index, rows.length - 1);
    const order = [
      ...rows.slice(start + (same ? 1 : 0)),
      ...rows.slice(0, Math.max(0, start)).reverse(),
    ];
    for (const row of order) {
      target = controlIn(row, snapshot.control) ?? controlIn(row, '');
      if (target) break;
    }
  }
  target?.focus({ preventScroll: true });
}
