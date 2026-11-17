/**
 * The presentation layer drawn into the captured page: lower-third captions,
 * keycap chips (a TUI has no pointer, so the keys pressed are shown instead) and
 * a pointer with click ripples (the real pointer never appears in a screencast).
 *
 * Built with createElement/textContent only: VS Code's workbench enforces
 * Trusted Types, so innerHTML would throw.
 */

/** Install once per page. `scale` multiplies every size (2 for the 2560-px terminal page). */
export async function installOverlay(page, { scale = 1, captionBottom = 36, captionX = null } = {}) {
  await page.evaluate(({ scale, captionBottom, captionX }) => {
    if (document.getElementById('demo-overlay')) return;
    const px = (n) => `${n * scale}px`;
    const root = document.createElement('div');
    root.id = 'demo-overlay';
    Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '2147483646', pointerEvents: 'none', fontFamily: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif' });

    const caption = document.createElement('div');
    caption.id = 'demo-caption';
    Object.assign(caption.style, {
      position: 'absolute', left: captionX === null ? '50%' : `${captionX}px`, bottom: px(captionBottom), transform: `translate(-50%, ${px(12)})`, opacity: '0',
      padding: `${px(10)} ${px(22)}`, borderRadius: px(999), background: 'rgba(17, 17, 27, 0.86)', color: '#f5f3ff',
      fontSize: px(26), fontWeight: '600', letterSpacing: '0.01em', whiteSpace: 'nowrap',
      boxShadow: `0 ${px(10)} ${px(30)} rgba(0,0,0,0.45), inset 0 0 0 ${px(1)} rgba(196, 167, 231, 0.45)`,
      transition: 'opacity 260ms ease, transform 260ms ease',
    });
    root.appendChild(caption);

    const keys = document.createElement('div');
    keys.id = 'demo-keys';
    Object.assign(keys.style, { position: 'absolute', right: px(28), bottom: px(captionBottom), display: 'flex', gap: px(8) });
    root.appendChild(keys);

    const NS = 'http://www.w3.org/2000/svg';
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    Object.assign(cursor.style, {
      position: 'absolute', left: '0', top: '0', opacity: '0', willChange: 'transform',
      filter: `drop-shadow(0 ${px(4)} ${px(8)} rgba(0,0,0,0.5))`, transform: 'translate(70%, 70%)',
    });
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(22 * scale));
    svg.setAttribute('height', String(26 * scale));
    svg.setAttribute('viewBox', '0 0 16 20');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M1 1v15.5l4.2-4 2.9 6.4 2.6-1.2-2.9-6.2H14z');
    path.setAttribute('fill', '#ffffff');
    path.setAttribute('stroke', '#111111');
    path.setAttribute('stroke-width', '1.2');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    cursor.appendChild(svg);
    root.appendChild(cursor);

    document.body.appendChild(root);
    window.__demo = { scale, x: innerWidth * 0.7, y: innerHeight * 0.7 };
  }, { scale, captionBottom, captionX });
}

/** Show a caption; it stays until replaced or cleared. */
export function caption(page, text) {
  return page.evaluate((text) => {
    const el = document.getElementById('demo-caption');
    if (!el) return;
    const s = window.__demo.scale;
    if (!text) {
      el.style.opacity = '0';
      el.style.transform = `translate(-50%, ${12 * s}px)`;
      return;
    }
    el.textContent = text;
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%, 0)';
  }, text ?? '');
}

/** A keycap chip that fades out after a moment. */
export function keycap(page, label) {
  return page.evaluate((label) => {
    const box = document.getElementById('demo-keys');
    if (!box) return;
    const s = window.__demo.scale;
    const chip = document.createElement('div');
    chip.textContent = label;
    Object.assign(chip.style, {
      minWidth: `${30 * s}px`, textAlign: 'center', padding: `${6 * s}px ${12 * s}px`, borderRadius: `${8 * s}px`,
      background: 'rgba(245, 243, 255, 0.95)', color: '#1e1b2e', fontSize: `${22 * s}px`, fontWeight: '700',
      fontFamily: '"SF Mono", Menlo, monospace', boxShadow: `0 ${3 * s}px 0 rgba(120, 100, 160, 0.9), 0 ${8 * s}px ${20 * s}px rgba(0,0,0,0.4)`,
      transform: `translateY(${8 * s}px)`, opacity: '0', transition: 'opacity 160ms ease, transform 160ms ease',
    });
    box.appendChild(chip);
    requestAnimationFrame(() => {
      chip.style.opacity = '1';
      chip.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      chip.style.opacity = '0';
      setTimeout(() => chip.remove(), 220);
    }, 1100);
  }, label);
}

/**
 * Move the drawn pointer to (x, y) CSS px over `ms`, eased. The real pointer
 * follows, so hover states (and only the intended ones) appear in the footage.
 */
export async function moveCursor(page, x, y, ms = 650) {
  page.mouse.move(x, y, { steps: Math.max(2, Math.round(ms / 40)) }).catch(() => {});
  await page.evaluate(
    ({ x, y, ms }) => {
      const el = document.getElementById('demo-cursor');
      if (!el) return;
      el.style.opacity = '1';
      el.style.transition = `transform ${ms}ms cubic-bezier(0.65, 0, 0.35, 1), opacity 200ms ease`;
      el.style.transform = `translate(${x}px, ${y}px)`;
      window.__demo.x = x;
      window.__demo.y = y;
    },
    { x, y, ms },
  );
  await new Promise((r) => setTimeout(r, ms + 40));
}

/** A ripple at the pointer. */
export function ripple(page) {
  return page.evaluate(() => {
    const root = document.getElementById('demo-overlay');
    if (!root) return;
    const { x, y, scale: s } = window.__demo;
    const ring = document.createElement('div');
    Object.assign(ring.style, {
      position: 'absolute', left: `${x - 18 * s}px`, top: `${y - 18 * s}px`, width: `${36 * s}px`, height: `${36 * s}px`,
      borderRadius: '50%', border: `${3 * s}px solid rgba(196, 167, 231, 0.95)`, transform: 'scale(0.3)', opacity: '1',
      transition: 'transform 420ms ease-out, opacity 420ms ease-out',
    });
    root.appendChild(ring);
    requestAnimationFrame(() => {
      ring.style.transform = 'scale(1.6)';
      ring.style.opacity = '0';
    });
    setTimeout(() => ring.remove(), 480);
  });
}

/** Move to an element's centre (or an offset inside it), ripple, and click it for real. */
export async function clickAt(page, x, y, { ms = 650 } = {}) {
  await moveCursor(page, x, y, ms);
  await ripple(page);
  await page.mouse.click(x, y);
}

export function hideCursor(page) {
  return page.evaluate(() => {
    const el = document.getElementById('demo-cursor');
    if (el) el.style.opacity = '0';
  });
}
