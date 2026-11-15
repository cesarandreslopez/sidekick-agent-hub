// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderInsights } from './insights';
import { isPlaybackKeyTarget } from './index';

function station(id: string, busyMs: number) {
  return {
    id,
    calls: 3,
    busyMs,
    resultChars: 10,
    errors: 0,
    denials: 0,
    estTokens: 100,
  };
}

const insights = {
  stations: [station('files', 5000), station('network', 3000), station('shell', 1000)],
  patterns: [],
} as never;

const handlers = { onSelectStation: () => {}, onSelectPattern: () => {} };

describe('renderInsights', () => {
  it('keeps keyboard focus on the same station row across re-renders', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderInsights(container, insights, undefined, handlers, { summary: false });

    const row = container.querySelector<HTMLElement>('[data-station="network"]');
    row?.focus();
    expect(document.activeElement).toBe(row);

    renderInsights(container, insights, 'network', handlers, { summary: false });
    const after = document.activeElement as HTMLElement | null;
    expect(after).not.toBe(row);
    expect(after?.dataset.station).toBe('network');
    container.remove();
  });
});

describe('isPlaybackKeyTarget', () => {
  it('leaves Space to buttons outside the transport bar and to section headers', () => {
    document.body.innerHTML = `
      <div id="am-controls"><button id="play" type="button">Play</button></div>
      <details><summary id="sum">Feed</summary></details>
      <button id="row" type="button">Row</button>
      <input id="field" />`;
    const get = (id: string) => document.getElementById(id) as HTMLElement;

    expect(isPlaybackKeyTarget(get('play'), ' ')).toBe(true);
    expect(isPlaybackKeyTarget(get('row'), ' ')).toBe(false);
    expect(isPlaybackKeyTarget(get('row'), 'ArrowLeft')).toBe(false);
    expect(isPlaybackKeyTarget(get('sum'), ' ')).toBe(false);
    expect(isPlaybackKeyTarget(get('sum'), 'ArrowRight')).toBe(false);
    expect(isPlaybackKeyTarget(get('field'), ' ')).toBe(false);
    expect(isPlaybackKeyTarget(document.body, ' ')).toBe(true);
  });
});
