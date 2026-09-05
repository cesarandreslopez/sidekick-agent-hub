/**
 * Chart.js Vendor Bundle — Browser Entry Point
 *
 * Registers only the controllers, elements, scales, and plugins the dashboard
 * uses (doughnut, line with fill, bar, category and linear axes, legend,
 * tooltip, title) instead of `registerables`, so esbuild can drop the rest
 * (radar, polar, bubble, scatter, time and log scales, decimation, ...).
 *
 * Adding a new chart type to the dashboard means registering its controller
 * and elements here, or it renders nothing.
 *
 * Bundled by esbuild as an IIFE into `out/webview/chartjs-vendor.js`.
 *
 * @module webview/chartjs-vendor
 */

import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from 'chart.js';

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
);

// Expose on window for inline scripts that reference `window.Chart` / `new Chart(...)`
(window as unknown as Record<string, unknown>).Chart = Chart;
