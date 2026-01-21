/**
 * @fileoverview VS Code extension providing Sidekick for Max inline completions.
 *
 * This extension uses Claude via the Agent SDK (Max subscription) or API key
 * to provide intelligent code suggestions as you type. It registers an inline
 * completion provider that sends code context to Claude and displays suggestions.
 *
 * Features:
 * - Automatic inline completions as you type
 * - Code transformation via selection and instruction
 * - Configurable debounce delay
 * - Toggle enable/disable via status bar or command
 * - Manual trigger via keyboard shortcut (Ctrl+Shift+Space)
 * - Model selection (haiku for speed, sonnet/opus for quality)
 *
 * @module extension
 */

import * as vscode from "vscode";
import { AuthService } from "./services/AuthService";
import { CompletionService } from "./services/CompletionService";
import { GitService } from "./services/GitService";
import { CommitMessageService } from "./services/CommitMessageService";
import { InlineCompletionProvider } from "./providers/InlineCompletionProvider";
import { StatusBarManager } from "./services/StatusBarManager";
import { initLogger, log, logError, showLog } from "./services/Logger";
import {
  getTransformSystemPrompt,
  getTransformUserPrompt,
  cleanTransformResponse,
} from "./utils/prompts";

/** Whether completions are currently enabled */
let enabled = true;

/** Status bar manager for multi-state status display */
let statusBarManager: StatusBarManager | undefined;

/** Auth service managing Claude API access */
let authService: AuthService | undefined;

/** Completion service managing completion requests */
let completionService: CompletionService | undefined;

/** Git service for repository access */
let gitService: GitService | undefined;

/** Commit message service for AI-powered commit generation */
let commitMessageService: CommitMessageService | undefined;

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
export async function activate(context: vscode.ExtensionContext) {
  // Initialize logger first
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);
  log("Sidekick for Max extension activated");

  // Create status bar manager
  statusBarManager = new StatusBarManager();
  statusBarManager.setConnected(); // Start enabled
  context.subscriptions.push(statusBarManager);

  // Initialize status bar with configured model
  const config = vscode.workspace.getConfiguration("sidekick");
  const inlineModel = config.get<string>("inlineModel") ?? "haiku";
  statusBarManager.setModel(inlineModel);

  // Update status bar when model configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sidekick.inlineModel")) {
        const config = vscode.workspace.getConfiguration("sidekick");
        const model = config.get<string>("inlineModel") ?? "haiku";
        statusBarManager?.setModel(model);
      }
    })
  );

  // Initialize auth service
  authService = new AuthService(context);
  context.subscriptions.push(authService);

  // Initialize completion service (depends on authService)
  completionService = new CompletionService(authService);
  context.subscriptions.push(completionService);

  // Initialize Git service
  gitService = new GitService();
  const gitInitialized = await gitService.initialize();
  if (!gitInitialized) {
    log('Git extension not available. Commit message features will be disabled.');
  }
  context.subscriptions.push(gitService);

  // Initialize commit message service (depends on gitService and authService)
  if (gitInitialized) {
    commitMessageService = new CommitMessageService(gitService, authService);
    context.subscriptions.push(commitMessageService);
  }

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
      if (enabled) {
        statusBarManager?.setConnected();
      } else {
        statusBarManager?.setDisconnected();
      }
      vscode.window.showInformationMessage(
        `Sidekick: ${enabled ? "Enabled" : "Disabled"}`
      );
    })
  );

  // Register show logs command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick.showLogs", () => {
      showLog();
    })
  );

  // Register status bar menu command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick.showMenu", async () => {
      const items = [
        {
          label: enabled ? "$(circle-slash) Disable" : "$(sparkle) Enable",
          description: enabled ? "Turn off inline completions" : "Turn on inline completions",
          action: "toggle",
        },
        {
          label: "$(gear) Configure Extension",
          description: "Open Sidekick settings",
          action: "configure",
        },
        {
          label: "$(output) View Logs",
          description: "Open the Sidekick output channel",
          action: "logs",
        },
        {
          label: "$(plug) Test Connection",
          description: "Verify Claude API connection",
          action: "test",
        },
        {
          label: "$(key) Set API Key",
          description: "Configure Anthropic API key",
          action: "apiKey",
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Sidekick Options",
      });

      if (selected) {
        switch (selected.action) {
          case "toggle":
            vscode.commands.executeCommand("sidekick.toggle");
            break;
          case "configure":
            vscode.commands.executeCommand("workbench.action.openSettings", "sidekick");
            break;
          case "logs":
            showLog();
            break;
          case "test":
            vscode.commands.executeCommand("sidekick.testConnection");
            break;
          case "apiKey":
            vscode.commands.executeCommand("sidekick.setApiKey");
            break;
        }
      }
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

      statusBarManager?.setLoading('Testing connection');

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Testing connection...",
          cancellable: false,
        },
        async () => authService!.testConnection()
      );

      if (result.success) {
        statusBarManager?.setConnected();
        vscode.window.showInformationMessage(result.message);
      } else {
        statusBarManager?.setError(result.message);
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  /**
   * Generates commit message with progress indicator and SCM input population.
   * @param guidance - Optional user guidance for regeneration (e.g., "focus on the API changes")
   */
  async function generateCommitMessageWithProgress(guidance?: string): Promise<void> {
    if (!commitMessageService || !gitService) {
      return;
    }

    const isRegenerate = guidance !== undefined;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: isRegenerate ? "Regenerating commit message" : "Generating commit message",
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ message: "Reading changes..." });

          const result = await commitMessageService!.generateCommitMessage(guidance);

          if (result.error) {
            statusBarManager?.setError(result.error);
            vscode.window.showErrorMessage(`Commit message generation failed: ${result.error}`);
            return;
          }

          if (result.message) {
            // Set message in SCM input box (skip confirmation if regenerating)
            const success = await gitService!.setCommitMessage(result.message, !isRegenerate);

            if (success) {
              statusBarManager?.setConnected();

              // Show success with regenerate option (don't await - let progress complete)
              vscode.window.showInformationMessage(
                `Commit message generated`,
                "Regenerate",
                "Regenerate with guidance"
              ).then(async (action) => {
                if (action === "Regenerate") {
                  generateCommitMessageWithProgress("");
                } else if (action === "Regenerate with guidance") {
                  const userGuidance = await vscode.window.showInputBox({
                    prompt: "How should the commit message be different?",
                    placeHolder: "e.g., focus on the bug fix, make it shorter, mention the refactoring",
                    ignoreFocusOut: true,
                  });
                  if (userGuidance) {
                    generateCommitMessageWithProgress(userGuidance);
                  }
                }
              });
            } else {
              // User cancelled overwrite or no repo
              statusBarManager?.setConnected();
            }
          } else {
            statusBarManager?.setConnected();
            vscode.window.showWarningMessage("Could not generate a valid commit message. Try with different changes.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          statusBarManager?.setError(message);
          vscode.window.showErrorMessage(`Commit message generation failed: ${message}`);
        }
      }
    );
  }

  // Register generate commit message command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick.generateCommitMessage", async () => {
      if (!commitMessageService || !gitService) {
        vscode.window.showErrorMessage("Git integration not available. Cannot generate commit message.");
        return;
      }

      await generateCommitMessageWithProgress(false);
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
          ignoreFocusOut: true,
        });

        if (!instruction) {
          return; // User cancelled
        }

        const language = editor.document.languageId;
        const config = vscode.workspace.getConfiguration("sidekick");
        const model = config.get<string>("transformModel") ?? "opus";
        const contextLines = config.get<number>("transformContextLines") ?? 50;

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

        // Capture selection state before async operation
        const originalSelection = editor.selection;
        const selectedText = editor.document.getText(originalSelection);

        statusBarManager?.setLoading("Transforming");

        try {
          log(`Transform starting: model=${model}, language=${language}`);

          // Build prompt using prompt templates
          const prompt =
            getTransformSystemPrompt() +
            "\n\n" +
            getTransformUserPrompt(selectedText, instruction, language, prefix, suffix);

          log(`Calling authService.complete...`);

          // Use AuthService instead of HTTP
          const result = await authService!.complete(prompt, {
            model,
            maxTokens: 4096,
            timeout: 60000, // Transforms can take longer
          });

          log(`Transform completed, result length: ${result.length}`);

          // Clean the response
          const cleaned = cleanTransformResponse(result);
          if (!cleaned) {
            vscode.window.showWarningMessage("No transformation returned");
            statusBarManager?.setConnected();
            return;
          }

          // Verify selection hasn't changed
          if (!editor.selection.isEqual(originalSelection)) {
            vscode.window.showWarningMessage(
              "Selection changed during transform. Please try again."
            );
            statusBarManager?.setConnected();
            return;
          }

          // Apply the edit
          const success = await editor.edit((editBuilder) => {
            editBuilder.replace(originalSelection, cleaned);
          });

          if (success) {
            statusBarManager?.setConnected();
          } else {
            statusBarManager?.setError("Edit failed");
            vscode.window.showErrorMessage("Failed to apply transformation");
          }
        } catch (error) {
          logError("Transform failed", error);
          const message = error instanceof Error ? error.message : "Unknown error";
          statusBarManager?.setError(message);
          vscode.window.showErrorMessage(`Transform failed: ${message}`);
        }
      }
    )
  );
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
