/**
 * Context stack for overlay and focus management.
 * Push overlays/states onto the stack; Escape pops the top.
 * Each context kind has a cleanup callback for dismissing its overlay.
 */

export type ContextKind = 'side' | 'detail' | 'filter' | 'help' | 'context-menu';

export interface ContextEntry {
  kind: ContextKind;
  /** Called when this context is popped (to dismiss overlays, etc.). */
  onPop?: () => void;
}

export class FocusStack {
  private stack: ContextEntry[] = [{ kind: 'side' }];

  /** Push a new context onto the stack. */
  push(entry: ContextEntry): void {
    this.stack.push(entry);
  }

  /**
   * Pop the top context, calling its onPop cleanup.
   * Returns the new current context, or null if at root.
   */
  pop(): ContextEntry | null {
    if (this.stack.length <= 1) return null;
    const popped = this.stack.pop()!;
    popped.onPop?.();
    return this.current;
  }

  /** Get the current (top) context. */
  get current(): ContextEntry {
    return this.stack[this.stack.length - 1];
  }

  /** Get the stack depth. */
  get depth(): number {
    return this.stack.length;
  }

  /** Reset to side-level context only. */
  reset(): void {
    // Pop all overlays cleanly
    while (this.stack.length > 1) {
      const popped = this.stack.pop()!;
      popped.onPop?.();
    }
  }

  /** Check if a specific context kind is in the stack. */
  has(kind: ContextKind): boolean {
    return this.stack.some(e => e.kind === kind);
  }

  /** Check if any overlay context is active (anything above side/detail). */
  get hasOverlay(): boolean {
    return this.stack.some(e =>
      e.kind !== 'side' && e.kind !== 'detail'
    );
  }

  /**
   * Replace the base focus (side/detail) without affecting overlays.
   * Replaces the bottom-most entry.
   */
  setBaseFocus(kind: 'side' | 'detail'): void {
    if (this.stack.length > 0) {
      this.stack[0] = { kind };
    }
  }

  /** Get the base focus kind (side or detail). */
  get baseFocus(): 'side' | 'detail' {
    return (this.stack[0]?.kind === 'detail') ? 'detail' : 'side';
  }
}
