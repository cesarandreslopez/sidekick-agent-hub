/**
 * Cross-platform browser opener for HTML report files.
 */

import { execFile } from 'child_process';

/** Open a file path in the default system browser. */
export function openInBrowser(filePath: string): void {
  const url = `file://${filePath}`;
  switch (process.platform) {
    case 'darwin':
      execFile('open', [url]);
      break;
    case 'win32':
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
      break;
    default:
      execFile('xdg-open', [url]);
      break;
  }
}
