/**
 * @fileoverview VS Code extension providing Sidekick for Max inline completions.
 *
 * This extension integrates with the Sidekick server to provide
 * intelligent code suggestions as you type. It registers an inline completion
 * provider that sends code context to the server and displays suggestions.
 *
 * Features:
 * - Automatic inline completions as you type
 * - Configurable debounce delay
 * - Toggle enable/disable via status bar or command
 * - Manual trigger via keyboard shortcut (Ctrl+Shift+Space)
 * - Model selection (haiku for speed, sonnet for quality)
 *
 * @module extension
 */

import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";

/**
 * Response from the completion server.
 */
interface CompletionResponse {
  /** The generated code completion */
  completion: string;
  /** Error message if the request failed */
  error?: string;
  /** Request ID for tracing (correlates with server logs) */
  requestId?: string;
  /** HTTP status code from the response */
  statusCode?: number;
}

/**
 * Response from the transform endpoint.
 */
interface TransformResponse {
  /** The modified code */
  modified_code: string;
  /** Error message if the request failed */
  error?: string;
  /** Request ID for tracing */
  requestId?: string;
  /** HTTP status code from the response */
  statusCode?: number;
}

/** Status bar item showing extension state */
let statusBarItem: vscode.StatusBarItem;

/** Whether completions are currently enabled */
let enabled = true;

/** Timer for debouncing completion requests */
let debounceTimer: NodeJS.Timeout | undefined;

/** Counter for tracking the latest request (used to cancel stale requests) */
let lastRequestId = 0;

/**
 * Activates the extension.
 *
 * This function is called when the extension is activated. It sets up:
 * - Status bar item for toggling completions
 * - Inline completion provider
 * - Commands for toggling and manual triggering
 *
 * @param context - The extension context provided by VS Code
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("Sidekick for Max extension activated");

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "sidekick.toggle";
  updateStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register inline completion provider
  const provider = new SidekickInlineCompletionProvider();
  const disposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" }, // All files
    provider
  );
  context.subscriptions.push(disposable);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick.toggle", () => {
      enabled = !enabled;
      updateStatusBar();
      vscode.window.showInformationMessage(
        `Sidekick: ${enabled ? "Enabled" : "Disabled"}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick.triggerCompletion",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          // Trigger inline completion manually
          vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        }
      }
    )
  );

  // Register transform selected code command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick.transform",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          vscode.window.showWarningMessage("Select code to transform first");
          return;
        }

        const instruction = await vscode.window.showInputBox({
          prompt: "How should this code be transformed?",
          placeHolder: "e.g., Add error handling, Convert to async/await, Add types",
        });

        if (!instruction) {
          return; // User cancelled
        }

        const selectedText = editor.document.getText(editor.selection);
        const language = editor.document.languageId;
        const filename = editor.document.fileName.split("/").pop() || "unknown";
        const config = vscode.workspace.getConfiguration("sidekick");
        const serverUrl = config.get<string>("serverUrl") || "http://localhost:3456";
        const model = config.get<string>("transformModel") || "opus";
        const contextLines = config.get<number>("transformContextLines") || 50;

        // Get context before selection
        const selectionStart = editor.selection.start;
        const prefixStartLine = Math.max(0, selectionStart.line - contextLines);
        const prefixRange = new vscode.Range(
          new vscode.Position(prefixStartLine, 0),
          selectionStart
        );
        const prefix = editor.document.getText(prefixRange);

        // Get context after selection
        const selectionEnd = editor.selection.end;
        const suffixEndLine = Math.min(
          editor.document.lineCount - 1,
          selectionEnd.line + contextLines
        );
        const suffixRange = new vscode.Range(
          selectionEnd,
          new vscode.Position(suffixEndLine, editor.document.lineAt(suffixEndLine).text.length)
        );
        const suffix = editor.document.getText(suffixRange);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Sidekick: Transforming code...",
            cancellable: true,
          },
          async (progress, token) => {
            const result = await fetchTransform(serverUrl, {
              code: selectedText,
              instruction,
              language,
              filename,
              model,
              prefix,
              suffix,
            });

            if (token.isCancellationRequested) {
              return;
            }

            if (result.statusCode === 429) {
              vscode.window.showWarningMessage(
                "Rate limited. Please wait a moment."
              );
              return;
            }

            if (result.error) {
              vscode.window.showErrorMessage(`Transform failed: ${result.error}`);
              return;
            }

            if (!result.modified_code) {
              vscode.window.showWarningMessage("No transformation returned");
              return;
            }

            // Replace selection with modified code
            await editor.edit((editBuilder) => {
              editBuilder.replace(editor.selection, result.modified_code);
            });
          }
        );
      }
    )
  );
}

/**
 * Updates the status bar item to reflect the current enabled state.
 */
function updateStatusBar(): void {
  statusBarItem.text = enabled ? "$(sparkle) Sidekick" : "$(sparkle-off) Sidekick";
  statusBarItem.tooltip = `Sidekick for Max: ${enabled ? "Enabled" : "Disabled"} (click to toggle)`;
}

/**
 * Inline completion provider that fetches suggestions from the server.
 *
 * This provider implements VS Code's InlineCompletionItemProvider interface
 * to show AI-generated code suggestions as ghost text in the editor.
 */
class SidekickInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  /**
   * Provides inline completion items for the current cursor position.
   *
   * @param document - The text document being edited
   * @param position - The cursor position
   * @param context - The inline completion context
   * @param token - Cancellation token for aborting the request
   * @returns Array of inline completion items or undefined
   */
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    // Check if enabled
    const config = vscode.workspace.getConfiguration("sidekick");
    if (!enabled || !config.get("enabled")) {
      return undefined;
    }

    // Debounce
    const debounceMs = config.get<number>("debounceMs") || 300;
    const requestId = ++lastRequestId;

    await new Promise((resolve) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(resolve, debounceMs);
    });

    // Check if this request is still valid
    if (requestId !== lastRequestId || token.isCancellationRequested) {
      return undefined;
    }

    try {
      const completion = await this.getCompletion(document, position, config);

      if (
        !completion ||
        token.isCancellationRequested ||
        requestId !== lastRequestId
      ) {
        return undefined;
      }

      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        ),
      ];
    } catch (error) {
      console.error("Completion error:", error);
      return undefined;
    }
  }

  /**
   * Fetches a code completion from the server.
   *
   * @param document - The text document being edited
   * @param position - The cursor position
   * @param config - The extension configuration
   * @returns The completion text or undefined if no completion available
   */
  private async getCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    config: vscode.WorkspaceConfiguration
  ): Promise<string | undefined> {
    const serverUrl =
      config.get<string>("serverUrl") || "http://localhost:3456";
    const maxContextLines = config.get<number>("inlineContextLines") || 30;
    const multiline = config.get<boolean>("multiline") || false;
    const model = config.get<string>("inlineModel") || "haiku";

    // Get context around cursor
    const startLine = Math.max(0, position.line - maxContextLines);
    const endLine = Math.min(
      document.lineCount - 1,
      position.line + maxContextLines
    );

    // Get prefix (everything before cursor)
    const prefixRange = new vscode.Range(
      new vscode.Position(startLine, 0),
      position
    );
    const prefix = document.getText(prefixRange);

    // Get suffix (everything after cursor)
    const suffixRange = new vscode.Range(
      position,
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );
    const suffix = document.getText(suffixRange);

    // Detect language
    const language = document.languageId;
    const filename = document.fileName.split("/").pop() || "unknown";

    // Make request to completion server
    const response = await this.fetchCompletion(serverUrl, {
      prefix,
      suffix,
      language,
      filename,
      model,
      multiline,
    });

    // Log request ID for debugging correlation with server logs
    if (response.requestId) {
      console.debug(`Completion request ${response.requestId}`);
    }

    // Handle rate limiting
    if (response.statusCode === 429) {
      vscode.window.showWarningMessage(
        "Rate limited. Please wait a moment."
      );
      return undefined;
    }

    if (response.error) {
      console.error(
        `Completion server error${response.requestId ? ` [${response.requestId}]` : ""}:`,
        response.error
      );
      return undefined;
    }

    return response.completion || undefined;
  }

  /**
   * Makes an HTTP request to the completion server.
   *
   * @param serverUrl - The base URL of the completion server
   * @param body - The request payload containing code context
   * @returns Promise resolving to the server response
   */
  private fetchCompletion(
    serverUrl: string,
    body: object
  ): Promise<CompletionResponse> {
    return new Promise((resolve) => {
      const url = new URL("/inline", serverUrl);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const postData = JSON.stringify(body);

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 10000,
      };

      const req = httpModule.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ ...parsed, statusCode: res.statusCode });
          } catch {
            resolve({
              completion: "",
              error: "Invalid JSON response",
              statusCode: res.statusCode,
            });
          }
        });
      });

      req.on("error", (error) => {
        resolve({ completion: "", error: error.message });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ completion: "", error: "Request timeout" });
      });

      req.write(postData);
      req.end();
    });
  }
}

/**
 * Makes an HTTP request to the transform endpoint.
 *
 * @param serverUrl - The base URL of the server
 * @param body - The request payload containing code and instruction
 * @returns Promise resolving to the server response
 */
function fetchTransform(
  serverUrl: string,
  body: object
): Promise<TransformResponse> {
  return new Promise((resolve) => {
    const url = new URL("/transform", serverUrl);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const postData = JSON.stringify(body);

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 20000, // 20 second timeout for transforms
    };

    const req = httpModule.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ...parsed, statusCode: res.statusCode });
        } catch {
          resolve({
            modified_code: "",
            error: "Invalid JSON response",
            statusCode: res.statusCode,
          });
        }
      });
    });

    req.on("error", (error) => {
      resolve({ modified_code: "", error: error.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ modified_code: "", error: "Request timeout" });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Deactivates the extension.
 *
 * Called when the extension is deactivated. Cleans up any pending timers.
 */
export function deactivate(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
}
