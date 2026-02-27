/**
 * Cross-platform browser opener for HTML report files.
 */

import { exec } from 'child_process';

/** Open a file path in the default system browser. */
export function openInBrowser(filePath: string): void {
  const url = `file://${filePath}`;
  switch (process.platform) {
    case 'darwin':
      exec(`open "${url}"`);
      break;
    case 'win32':
      exec(`start "" "${url}"`);
      break;
    default:
      exec(`xdg-open "${url}"`);
      break;
  }
}
