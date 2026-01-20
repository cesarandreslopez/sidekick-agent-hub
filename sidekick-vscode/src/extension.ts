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
import { AuthService } from "./services/AuthService";
import { CompletionService } from "./services/CompletionService";
import { InlineCompletionProvider } from "./providers/InlineCompletionProvider";

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

/** Auth service managing Claude API access */
let authService: AuthService | undefined;

/** Completion service managing completion requests */
let completionService: CompletionService | undefined;

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

  // Initialize auth service
  authService = new AuthService(context);
  context.subscriptions.push(authService);

  // Initialize completion service (depends on authService)
  completionService = new CompletionService(authService);
  context.subscriptions.push(completionService);

  // Register inline completion provider using CompletionService
  const inlineProvider = new InlineCompletionProvider(completionService);
  const inlineDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" }, // All files
    inlineProvider
  );
  context.subscriptions.push(inlineDisposable);

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

  // Register set API key command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your Anthropic API Key",
        placeHolder: "sk-ant-...",
        password: true,
        ignoreFocusOut: true,
      });

      if (key) {
        await authService?.getSecretsManager().setApiKey(key);
        vscode.window.showInformationMessage("API key saved securely.");
      }
    })
  );

  // Register test connection command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick.testConnection", async () => {
      if (!authService) {
        vscode.window.showErrorMessage("Auth service not initialized");
        return;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Testing connection...",
          cancellable: false,
        },
        async () => authService!.testConnection()
      );

      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
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
 * Called when the extension is deactivated.
 * Cleanup handled via context.subscriptions (AuthService, CompletionService).
 */
export function deactivate(): void {
  // Cleanup handled via context.subscriptions (AuthService, CompletionService)
}
