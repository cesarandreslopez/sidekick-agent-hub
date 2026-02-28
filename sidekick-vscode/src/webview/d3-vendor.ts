/**
 * D3.js Vendor Bundle — Browser Entry Point
 *
 * Imports the full D3 library and exposes it on `window.d3` so that
 * inline webview scripts can use it the same way they did when it was
 * loaded from a CDN `<script>` tag.
 *
 * Bundled by esbuild as an IIFE into `out/webview/d3-vendor.js`.
 *
 * @module webview/d3-vendor
 */

import * as d3 from 'd3';

// Expose on window for inline scripts that reference `d3.*`
(window as unknown as Record<string, unknown>).d3 = d3;
