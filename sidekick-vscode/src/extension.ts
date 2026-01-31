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
import { warmupSdk } from "./services/MaxSubscriptionClient";
import { GitService } from "./services/GitService";
import { CommitMessageService } from "./services/CommitMessageService";
import { DocumentationService } from "./services/DocumentationService";
import { ExplanationService } from "./services/ExplanationService";
import { ErrorExplanationService } from "./services/ErrorExplanationService";
import { InlineChatService } from "./services/InlineChatService";
import { PreCommitReviewService } from "./services/PreCommitReviewService";
import { PrDescriptionService } from "./services/PrDescriptionService";
import { getTimeoutManager } from "./services/TimeoutManager";
import { SessionMonitor } from './services/SessionMonitor';
import { MonitorStatusBar } from './services/MonitorStatusBar';
import { QuotaService } from './services/QuotaService';
import { InlineCompletionProvider } from "./providers/InlineCompletionProvider";
import { InlineChatProvider } from "./providers/InlineChatProvider";
import { RsvpViewProvider } from "./providers/RsvpViewProvider";
import { ExplainViewProvider } from "./providers/ExplainViewProvider";
import { ErrorExplanationProvider } from "./providers/ErrorExplanationProvider";
import { ErrorViewProvider } from "./providers/ErrorViewProvider";
import { DashboardViewProvider } from "./providers/DashboardViewProvider";
import { MindMapViewProvider } from "./providers/MindMapViewProvider";
import { TempFilesTreeProvider } from "./providers/TempFilesTreeProvider";
import { SubagentTreeProvider } from "./providers/SubagentTreeProvider";
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

/** Documentation service for AI-powered doc generation */
let documentationService: DocumentationService | undefined;

/** RSVP view provider for speed reading */
let rsvpProvider: RsvpViewProvider | undefined;

/** Explain view provider for code explanations */
let explainProvider: ExplainViewProvider | undefined;

/** Inline chat provider for quick ask */
let inlineChatProvider: InlineChatProvider | undefined;

/** Pre-commit review service for AI code review */
let preCommitReviewService: PreCommitReviewService | undefined;

/** PR description service for AI-powered PR generation */
let prDescriptionService: PrDescriptionService | undefined;

/** Session monitor for Claude Code sessions */
let sessionMonitor: SessionMonitor | undefined;

/** Dashboard view provider for session analytics */
let dashboardProvider: DashboardViewProvider | undefined;

/** Quota service for Claude Max subscription limits */
let quotaService: QuotaService | undefined;

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

  // Pre-warm SDK in background (don't await - let activation continue)
  warmupSdk().catch(() => { /* ignored - will retry on first request */ });

  // Initialize completion service (depends on authService)
  completionService = new CompletionService(authService);
  context.subscriptions.push(completionService);

  // Initialize documentation service (depends on authService)
  documentationService = new DocumentationService(authService);
  context.subscriptions.push(documentationService);

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

  // Initialize pre-commit review and PR description services (depend on gitService and authService)
  if (gitInitialized) {
    preCommitReviewService = new PreCommitReviewService(gitService, authService);
    context.subscriptions.push(preCommitReviewService);

    prDescriptionService = new PrDescriptionService(gitService, authService);
    context.subscriptions.push(prDescriptionService);
  }

  // Initialize session monitor for Claude Code monitoring
  const monitoringConfig = vscode.workspace.getConfiguration('sidekick');
  const enableMonitoring = monitoringConfig.get<boolean>('enableSessionMonitoring') ?? true;

  if (enableMonitoring) {
    sessionMonitor = new SessionMonitor();
    context.subscriptions.push(sessionMonitor);

    // Start monitoring in background (don't block activation per EXT-04)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      sessionMonitor.start(workspaceFolder.uri.fsPath).then(active => {
        if (active) {
          log(`Claude Code session monitoring started: ${sessionMonitor!.getSessionPath()}`);
        } else {
          log('No active Claude Code session detected');
        }
      }).catch(error => {
        logError('Failed to start session monitor', error);
      });
    }

    // Log token usage events for debugging
    sessionMonitor.onTokenUsage(usage => {
      log(`Token usage: ${usage.inputTokens} in, ${usage.outputTokens} out, model: ${usage.model}`);
    });

    // Create quota service for subscription limits
    quotaService = new QuotaService();
    context.subscriptions.push(quotaService);
    log('QuotaService initialized');

    // Register dashboard view provider (depends on sessionMonitor and quotaService)
    dashboardProvider = new DashboardViewProvider(context.extensionUri, sessionMonitor, quotaService);
    context.subscriptions.push(dashboardProvider);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboardProvider)
    );
    log('Dashboard view provider registered');

    // Register mind map view provider (depends on sessionMonitor)
    const mindMapProvider = new MindMapViewProvider(context.extensionUri, sessionMonitor);
    context.subscriptions.push(mindMapProvider);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(MindMapViewProvider.viewType, mindMapProvider)
    );
    log('Mind map view provider registered');

    // Register temp files tree provider (depends on sessionMonitor)
    const tempFilesProvider = new TempFilesTreeProvider(sessionMonitor);
    context.subscriptions.push(tempFilesProvider);
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('sidekick.tempFiles', tempFilesProvider)
    );
    log('Temp files tree provider registered');

    // Register subagent tree provider (depends on sessionMonitor)
    const subagentProvider = new SubagentTreeProvider(sessionMonitor);
    context.subscriptions.push(subagentProvider);
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('sidekick.subagents', subagentProvider)
    );
    log('Subagent tree provider registered');

    // Create monitor status bar (depends on sessionMonitor)
    const monitorStatusBar = new MonitorStatusBar(sessionMonitor);
    context.subscriptions.push(monitorStatusBar);
  } else {
    log('Session monitoring disabled by configuration');
  }

  // Register inline completion provider using CompletionService
  const inlineProvider = new InlineCompletionProvider(completionService);
  const inlineDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" }, // All files
    inlineProvider
  );
  context.subscriptions.push(inlineDisposable);

  // Create RSVP provider (creates panel on demand, not a sidebar view)
  rsvpProvider = new RsvpViewProvider(context.extensionUri, authService);
  context.subscriptions.push(rsvpProvider);

  // Create ExplanationService for explain provider
  const explanationService = new ExplanationService(authService);

  // Create Explain provider (creates panel on demand) with injected service
  explainProvider = new ExplainViewProvider(context.extensionUri, explanationService);
  context.subscriptions.push(explainProvider);

  // Create ErrorExplanationService for error explanations
  const errorExplanationService = new ErrorExplanationService(authService);

  // Create ErrorViewProvider for error explanation panel
  const errorViewProvider = new ErrorViewProvider(context.extensionUri, errorExplanationService);
  context.subscriptions.push(errorViewProvider);

  // Create InlineChatService for inline chat
  const inlineChatService = new InlineChatService(authService);

  // Create InlineChatProvider for quick ask
  inlineChatProvider = new InlineChatProvider(inlineChatService);
  context.subscriptions.push(inlineChatProvider);

  // Register error explanation code action provider
  const errorProvider = new ErrorExplanationProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'python'],
      errorProvider,
      { providedCodeActionKinds: ErrorExplanationProvider.providedCodeActionKinds }
    )
  );

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

  // Register open dashboard command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.openDashboard', () => {
      // Focus the dashboard view in the sidebar
      vscode.commands.executeCommand('sidekick.dashboard.focus');
    })
  );

  // Register start monitoring command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.startMonitoring', async () => {
      if (!sessionMonitor) {
        vscode.window.showErrorMessage('Session monitor not initialized');
        return;
      }

      if (sessionMonitor.isActive()) {
        vscode.window.showInformationMessage('Session monitoring is already active');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }

      const active = await sessionMonitor.start(workspaceFolder.uri.fsPath);
      if (active) {
        vscode.window.showInformationMessage('Session monitoring started');
        log(`Session monitoring started: ${sessionMonitor.getSessionPath()}`);
      } else {
        vscode.window.showInformationMessage('No active session found. Waiting for Claude Code to start...');
        log('Session monitor in discovery mode, waiting for session');
      }
    })
  );

  // Register stop monitoring command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.stopMonitoring', () => {
      if (!sessionMonitor) {
        vscode.window.showErrorMessage('Session monitor not initialized');
        return;
      }

      if (!sessionMonitor.isActive() && !sessionMonitor.isInDiscoveryMode()) {
        vscode.window.showInformationMessage('Session monitoring is not active');
        return;
      }

      sessionMonitor.dispose();

      // Reinitialize for potential future use
      sessionMonitor = new SessionMonitor();

      vscode.window.showInformationMessage('Session monitoring stopped');
      log('Session monitoring stopped by user');
    })
  );

  // Register refresh session command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.refreshSession', async () => {
      if (!sessionMonitor) {
        vscode.window.showErrorMessage('Session monitor not initialized');
        return;
      }

      const found = await sessionMonitor.refreshSession();
      if (found) {
        vscode.window.showInformationMessage('Session found and attached');
        log(`Session refreshed: ${sessionMonitor.getSessionPath()}`);
      } else {
        vscode.window.showInformationMessage('No active session found. Still searching...');
      }
    })
  );

  // Register session diagnostics command (helps debug path resolution issues)
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.sessionDiagnostics', async () => {
      const { getSessionDiagnostics } = await import('./services/SessionPathResolver');

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const workspacePath = workspaceFolders[0].uri.fsPath;
      const diag = getSessionDiagnostics(workspacePath);

      // Log detailed diagnostics
      log('=== Session Diagnostics ===');
      log(`Platform: ${diag.platform}`);
      log(`Workspace path: ${diag.workspacePath}`);
      log(`Encoded path: ${diag.encodedPath}`);
      log(`Expected session dir: ${diag.expectedSessionDir}`);
      log(`Expected dir exists: ${diag.expectedDirExists}`);
      log(`Discovered session dir: ${diag.discoveredSessionDir || '(not found)'}`);
      log(`Existing project dirs (${diag.existingProjectDirs.length}):`);
      diag.existingProjectDirs.forEach(dir => log(`  - ${dir}`));
      if (diag.similarDirs.length > 0) {
        log(`Similar dirs (possible matches):`);
        diag.similarDirs.forEach(dir => log(`  - ${dir}`));
      }
      log('=== End Diagnostics ===');

      // Show output channel
      showLog();

      // Show summary to user
      if (diag.discoveredSessionDir) {
        const message = diag.discoveredSessionDir === diag.expectedSessionDir
          ? `Session directory found: ${diag.discoveredSessionDir}`
          : `Session directory discovered (encoding differs): ${diag.discoveredSessionDir}`;
        vscode.window.showInformationMessage(message);
      } else if (diag.similarDirs.length > 0) {
        vscode.window.showWarningMessage(
          `Expected dir not found. Similar dirs exist: ${diag.similarDirs.join(', ')}. Check Sidekick logs for details.`
        );
      } else {
        vscode.window.showWarningMessage(
          `No session directory found. Expected: ${diag.encodedPath}. Check Sidekick logs for details.`
        );
      }
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
          // Clear highlight before triggering
          statusBarManager?.clearHighlight();
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

      await generateCommitMessageWithProgress();
    })
  );

  // Register review changes command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.reviewChanges', async () => {
      if (!preCommitReviewService) {
        vscode.window.showErrorMessage('Git integration not available. Cannot review changes.');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Reviewing changes with AI...',
          cancellable: true
        },
        async (progress, token) => {
          // Handle cancellation
          const abortController = new AbortController();
          token.onCancellationRequested(() => {
            abortController.abort();
          });

          try {
            progress.report({ increment: 30, message: 'Analyzing diff...' });

            const result = await preCommitReviewService!.reviewChanges();

            if (token.isCancellationRequested) {
              return;
            }

            progress.report({ increment: 100 });

            if (result.error) {
              vscode.window.showErrorMessage(`Review failed: ${result.error}`);
              return;
            }

            if (result.issueCount === 0) {
              vscode.window.showInformationMessage('AI Review complete: No issues found!');
            } else {
              vscode.window.showInformationMessage(
                `AI Review complete: ${result.issueCount} suggestion${result.issueCount === 1 ? '' : 's'}. Check Problems panel.`,
                'Clear Review'
              ).then(action => {
                if (action === 'Clear Review') {
                  vscode.commands.executeCommand('sidekick.clearReview');
                }
              });
            }
          } catch (error) {
            if (!token.isCancellationRequested) {
              const message = error instanceof Error ? error.message : 'Unknown error';
              vscode.window.showErrorMessage(`Review failed: ${message}`);
            }
          }
        }
      );
    })
  );

  // Register clear review command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.clearReview', () => {
      if (preCommitReviewService) {
        preCommitReviewService.clearReview();
        vscode.window.showInformationMessage('AI Review diagnostics cleared');
      }
    })
  );

  // Register generate PR description command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.generatePrDescription', async () => {
      if (!prDescriptionService) {
        vscode.window.showErrorMessage('Git integration not available. Cannot generate PR description.');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating PR description...',
          cancellable: true
        },
        async (progress, token) => {
          try {
            progress.report({ increment: 20, message: 'Getting commits...' });

            const result = await prDescriptionService!.generatePrDescription();

            if (token.isCancellationRequested) {
              return;
            }

            progress.report({ increment: 100 });

            if (result.error) {
              vscode.window.showErrorMessage(`PR description failed: ${result.error}`);
              return;
            }

            if (result.description) {
              vscode.window.showInformationMessage(
                `PR description copied to clipboard! (${result.commitCount} commit${result.commitCount === 1 ? '' : 's'} analyzed)`,
                'Open GitHub'
              ).then(action => {
                if (action === 'Open GitHub') {
                  vscode.env.openExternal(vscode.Uri.parse('https://github.com'));
                }
              });
            }
          } catch (error) {
            if (!token.isCancellationRequested) {
              const message = error instanceof Error ? error.message : 'Unknown error';
              vscode.window.showErrorMessage(`PR description failed: ${message}`);
            }
          }
        }
      );
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

          // Calculate context size for timeout scaling
          const contextSize = new TextEncoder().encode(prompt).length;
          const timeoutManager = getTimeoutManager();
          const timeoutConfig = timeoutManager.getTimeoutConfig('codeTransform');

          // Execute with timeout management and retry support
          const result = await timeoutManager.executeWithTimeout({
            operation: 'Transforming code',
            task: (signal: AbortSignal) => authService!.complete(prompt, {
              model,
              maxTokens: 4096,
              signal,
            }),
            config: timeoutConfig,
            contextSize,
            showProgress: true,
            cancellable: true,
            onTimeout: (timeoutMs: number, contextKb: number) =>
              timeoutManager.promptRetry('Transforming code', timeoutMs, contextKb),
          });

          if (!result.success) {
            if (result.timedOut) {
              statusBarManager?.setError("Timeout");
              vscode.window.showErrorMessage(`Transform timed out after ${result.timeoutMs}ms. Try again or increase timeout in settings.`);
              return;
            }
            if (result.error?.name === 'AbortError') {
              statusBarManager?.setConnected();
              return; // User cancelled
            }
            throw result.error ?? new Error('Unknown error');
          }

          log(`Transform completed, result length: ${result.result!.length}`);

          // Clean the response
          const cleaned = cleanTransformResponse(result.result!);
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

  // Register generate documentation command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.generateDocs', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      if (!documentationService) {
        vscode.window.showErrorMessage('Documentation service not initialized');
        return;
      }

      // Capture editor state before async operation
      const originalEditor = editor;

      statusBarManager?.setLoading('Generating docs');

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating documentation...',
          cancellable: false,
        },
        async () => {
          try {
            const result = await documentationService!.generateDocumentation(originalEditor);

            if (result.error) {
              statusBarManager?.setError(result.error);
              vscode.window.showErrorMessage(`Documentation generation failed: ${result.error}`);
              return;
            }

            if (result.documentation && result.insertLine !== undefined) {
              // Verify we're still in the same editor and position hasn't changed drastically
              if (vscode.window.activeTextEditor !== originalEditor) {
                vscode.window.showWarningMessage('Editor changed during generation. Please try again.');
                statusBarManager?.setConnected();
                return;
              }

              // Insert documentation above the function/class
              const insertPosition = new vscode.Position(result.insertLine, 0);
              const success = await originalEditor.edit(editBuilder => {
                editBuilder.insert(insertPosition, result.documentation!);
              });

              if (success) {
                statusBarManager?.setConnected();
                log('Documentation generated and inserted successfully');
              } else {
                statusBarManager?.setError('Insert failed');
                vscode.window.showErrorMessage('Failed to insert documentation');
              }
            } else {
              statusBarManager?.setConnected();
              vscode.window.showWarningMessage('Could not generate documentation. Try selecting the code to document.');
            }
          } catch (error) {
            logError('Documentation generation failed', error);
            const message = error instanceof Error ? error.message : 'Unknown error';
            statusBarManager?.setError(message);
            vscode.window.showErrorMessage(`Documentation generation failed: ${message}`);
          }
        }
      );
    })
  );

  // Helper for explain code with specific complexity
  const explainCodeWithComplexity = async (complexity: 'eli5' | 'curious-amateur' | 'imposter-syndrome' | 'senior' | 'phd') => {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('Select code to explain');
      return;
    }

    if (!explainProvider) {
      vscode.window.showErrorMessage('Explain provider not initialized');
      return;
    }

    const selectedText = editor.document.getText(editor.selection);
    const fileName = editor.document.fileName.split(/[/\\]/).pop() || '';
    const languageId = editor.document.languageId;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating explanation...',
        cancellable: false,
      },
      async () => {
        await explainProvider!.showExplanation(
          selectedText,
          complexity,
          { fileName, languageId }
        );
      }
    );
  };

  // Register explain code commands (base + complexity levels)
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.explainCode', () => {
      const config = vscode.workspace.getConfiguration('sidekick');
      const complexity = config.get<string>('explanationComplexity') ?? 'imposter-syndrome';
      return explainCodeWithComplexity(complexity as 'eli5' | 'curious-amateur' | 'imposter-syndrome' | 'senior' | 'phd');
    }),
    vscode.commands.registerCommand('sidekick.explainCode.eli5', () => explainCodeWithComplexity('eli5')),
    vscode.commands.registerCommand('sidekick.explainCode.curiousAmateur', () => explainCodeWithComplexity('curious-amateur')),
    vscode.commands.registerCommand('sidekick.explainCode.imposterSyndrome', () => explainCodeWithComplexity('imposter-syndrome')),
    vscode.commands.registerCommand('sidekick.explainCode.senior', () => explainCodeWithComplexity('senior')),
    vscode.commands.registerCommand('sidekick.explainCode.phd', () => explainCodeWithComplexity('phd'))
  );

  // Open pre-generated explanation in Explain panel (from RSVP)
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.openExplanationPanel', async (explanation: string, code?: string) => {
      if (!explainProvider) {
        vscode.window.showErrorMessage('Explain provider not initialized');
        return;
      }
      if (explanation) {
        explainProvider.showPreGeneratedExplanation(explanation, code);
      }
    })
  );

  // Register inline chat command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.inlineChat', async () => {
      if (!inlineChatProvider) {
        vscode.window.showErrorMessage('Inline chat provider not initialized');
        return;
      }

      await inlineChatProvider.showInlineChat();
    })
  );

  // Helper for explain error with specific complexity
  const explainErrorWithComplexity = async (uri: vscode.Uri, diagnostic: vscode.Diagnostic, complexity?: 'eli5' | 'curious-amateur' | 'imposter-syndrome' | 'senior' | 'phd') => {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Explaining error...',
        cancellable: false,
      },
      async () => {
        await errorViewProvider.showErrorExplanation(document, diagnostic, 'explain', complexity);
      }
    );
  };

  // Register explain error commands (base + complexity levels)
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.explainError', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      return explainErrorWithComplexity(uri, diagnostic);
    }),
    vscode.commands.registerCommand('sidekick.explainError.eli5', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      return explainErrorWithComplexity(uri, diagnostic, 'eli5');
    }),
    vscode.commands.registerCommand('sidekick.explainError.curiousAmateur', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      return explainErrorWithComplexity(uri, diagnostic, 'curious-amateur');
    }),
    vscode.commands.registerCommand('sidekick.explainError.imposterSyndrome', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      return explainErrorWithComplexity(uri, diagnostic, 'imposter-syndrome');
    }),
    vscode.commands.registerCommand('sidekick.explainError.senior', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      return explainErrorWithComplexity(uri, diagnostic, 'senior');
    }),
    vscode.commands.registerCommand('sidekick.explainError.phd', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      return explainErrorWithComplexity(uri, diagnostic, 'phd');
    })
  );

  // Register fix error command
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.fixError', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating fix...',
          cancellable: false,
        },
        async () => {
          await errorViewProvider.showErrorExplanation(document, diagnostic, 'fix');
        }
      );
    })
  );

  // Helper function for speed read commands
  const speedReadWithMode = async (mode: 'direct' | 'explain', complexity?: 'eli5' | 'curious-amateur' | 'imposter-syndrome' | 'senior' | 'phd') => {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('Select text to speed read');
      return;
    }

    const text = editor.document.getText(editor.selection);
    const fileName = editor.document.fileName.split(/[/\\]/).pop() || '';
    const languageId = editor.document.languageId;

    if (!rsvpProvider) {
      return;
    }

    if (mode === 'direct') {
      await rsvpProvider.loadText(text);
    } else if (complexity) {
      await rsvpProvider.loadTextWithExplanation(text, complexity, { fileName, languageId });
    }
  };

  // Register speed read commands for context menu
  context.subscriptions.push(
    vscode.commands.registerCommand('sidekick.speedRead', () => speedReadWithMode('direct')),
    vscode.commands.registerCommand('sidekick.speedRead.direct', () => speedReadWithMode('direct')),
    vscode.commands.registerCommand('sidekick.speedRead.eli5', () => speedReadWithMode('explain', 'eli5')),
    vscode.commands.registerCommand('sidekick.speedRead.curiousAmateur', () => speedReadWithMode('explain', 'curious-amateur')),
    vscode.commands.registerCommand('sidekick.speedRead.imposterSyndrome', () => speedReadWithMode('explain', 'imposter-syndrome')),
    vscode.commands.registerCommand('sidekick.speedRead.senior', () => speedReadWithMode('explain', 'senior')),
    vscode.commands.registerCommand('sidekick.speedRead.phd', () => speedReadWithMode('explain', 'phd')),
    // Speed read pre-generated explanation (from Explain panel)
    vscode.commands.registerCommand('sidekick.speedReadExplanation', async (explanation: string) => {
      if (rsvpProvider && explanation) {
        await rsvpProvider.loadText(explanation);
      }
    })
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
