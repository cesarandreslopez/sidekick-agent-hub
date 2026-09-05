/**
 * D3.js Vendor Bundle — Browser Entry Point
 *
 * Exposes the D3 functions the mind map actually uses on `window.d3`, so the
 * inline webview script keeps calling `d3.*` as it did with the CDN build.
 * Named imports let esbuild drop the D3 modules nothing references
 * (geo, scales, shapes, DSV parsing, ...), which is most of the library.
 *
 * `transition` and `interrupt` are listed even though the inline script only
 * reaches them through `selection.transition()`: importing them keeps
 * d3-transition in the bundle, and that module is what patches
 * `Selection.prototype.transition`.
 *
 * Bundled by esbuild as an IIFE into `out/webview/d3-vendor.js`.
 *
 * @module webview/d3-vendor
 */

import {
  drag,
  easeCubicInOut,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  interrupt,
  select,
  selectAll,
  transition,
  zoom,
  zoomIdentity,
  zoomTransform,
} from 'd3';

const d3 = {
  drag,
  easeCubicInOut,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  interrupt,
  select,
  selectAll,
  transition,
  zoom,
  zoomIdentity,
  zoomTransform,
};

// Expose on window for inline scripts that reference `d3.*`
(window as unknown as Record<string, unknown>).d3 = d3;
