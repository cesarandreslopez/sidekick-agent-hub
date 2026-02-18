/**
 * @fileoverview Simple logger that outputs to VS Code Output channel.
 */

import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

/**
 * Initializes the logger with an output channel.
 */
export function initLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Sidekick Agent Hub');
  }
  return outputChannel;
}

/**
 * Logs an info message.
 */
export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${JSON.stringify(args)}`
    : `[${timestamp}] ${message}`;
  outputChannel?.appendLine(formatted);
  console.log(`[Sidekick] ${formatted}`);
}

/**
 * Logs an error message.
 */
export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  let formatted = `[${timestamp}] ERROR: ${message}`;
  if (error instanceof Error) {
    formatted += `\n  ${error.message}\n  ${error.stack}`;
  } else if (error) {
    formatted += `\n  ${JSON.stringify(error)}`;
  }
  outputChannel?.appendLine(formatted);
  console.error(`[Sidekick] ${formatted}`);
}

/**
 * Shows the output channel.
 */
export function showLog(): void {
  outputChannel?.show();
}
