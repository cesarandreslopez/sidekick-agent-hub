// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { captureFocus, restoreFocus } from './focus';

function list(rows: Array<{ key: string; focusableRow?: boolean }>): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = rows
    .map(
      (row) =>
        `<div data-key="${row.key}"${row.focusableRow ? ' tabindex="0"' : ''}>` +
        `<button type="button" class="toggle">${row.key}</button></div>`,
    )
    .join('');
  return container;
}

describe('focus across a list rebuild', () => {
  it('returns focus to the same control in the same row', () => {
    const container = list([{ key: 'Read' }, { key: 'Bash' }]);
    document.body.replaceChildren(container);
    container.querySelectorAll<HTMLElement>('button.toggle')[1].focus();
    const snapshot = captureFocus(container, 'data-key');
    expect(snapshot).toMatchObject({ key: 'Bash', control: 'button.toggle', index: 1 });

    // Rebuilt in a different order, as a re-sorted tool list is.
    container.innerHTML = list([{ key: 'Bash' }, { key: 'Read' }]).innerHTML;
    restoreFocus(container, 'data-key', snapshot);
    expect(document.activeElement?.textContent).toBe('Bash');
  });

  it('moves to a neighbouring row when the focused one is gone', () => {
    const container = list([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
    document.body.replaceChildren(container);
    container.querySelectorAll<HTMLElement>('button.toggle')[1].focus();
    const snapshot = captureFocus(container, 'data-key');
    container.innerHTML = list([{ key: 'a' }, { key: 'c' }]).innerHTML;
    restoreFocus(container, 'data-key', snapshot);
    expect(document.activeElement?.textContent).toBe('c');
  });

  it('focuses the row itself when the row was the control, and skips rows that no longer are', () => {
    const container = list([
      { key: 'n1', focusableRow: true },
      { key: 'n2', focusableRow: true },
    ]);
    document.body.replaceChildren(container);
    container.querySelector<HTMLElement>('[data-key="n1"]')!.focus();
    const snapshot = captureFocus(container, 'data-key');
    expect(snapshot?.control).toBe('');
    // n1 was marked read: no longer focusable.
    container.innerHTML = list([{ key: 'n1' }, { key: 'n2', focusableRow: true }]).innerHTML;
    restoreFocus(container, 'data-key', snapshot);
    expect(document.activeElement?.getAttribute('data-key')).toBe('n2');
  });

  it('leaves focus alone when nothing in the list had it', () => {
    const container = list([{ key: 'a' }]);
    const outside = document.createElement('button');
    document.body.replaceChildren(container, outside);
    outside.focus();
    const snapshot = captureFocus(container, 'data-key');
    expect(snapshot).toBeNull();
    container.innerHTML = list([{ key: 'a' }]).innerHTML;
    restoreFocus(container, 'data-key', snapshot);
    expect(document.activeElement).toBe(outside);
  });
});
