/**
 * Chart.js Vendor Bundle — Browser Entry Point
 *
 * Imports Chart.js and exposes it on `window.Chart` so that inline
 * webview scripts can use it the same way they did when it was loaded
 * from a CDN `<script>` tag.
 *
 * Bundled by esbuild as an IIFE into `out/webview/chartjs-vendor.js`.
 *
 * @module webview/chartjs-vendor
 */

import { Chart, registerables } from 'chart.js';

// Register all built-in components (scales, controllers, elements, plugins)
Chart.register(...registerables);

// Expose on window for inline scripts that reference `window.Chart` / `new Chart(...)`
(window as unknown as Record<string, unknown>).Chart = Chart;
