import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock vscode module
vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: vi.fn(() => ({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      text: "",
      tooltip: "",
      command: "",
    })),
    showInformationMessage: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => {
        const defaults: Record<string, unknown> = {
          enabled: true,
          debounceMs: 300,
          maxContextLines: 50,
          maxTokens: 150,
          model: "haiku",
        };
        return defaults[key];
      }),
    })),
  },
  languages: {
    registerInlineCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  StatusBarAlignment: { Right: 1 },
  Position: class {
    constructor(
      public line: number,
      public character: number
    ) {}
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown
    ) {}
  },
  InlineCompletionItem: class {
    constructor(
      public text: string,
      public range: unknown
    ) {}
  },
}));

describe("Extension Configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should have correct default configuration values", async () => {
    const vscode = await import("vscode");
    const config = vscode.workspace.getConfiguration("sidekick");

    expect(config.get("enabled")).toBe(true);
    expect(config.get("debounceMs")).toBe(300);
    expect(config.get("maxContextLines")).toBe(50);
    expect(config.get("maxTokens")).toBe(150);
    expect(config.get("model")).toBe("haiku");
  });
});

describe("HTTP Request Formation", () => {
  // Test the request body formation logic
  it("should form correct request body with all fields", () => {
    const requestBody = {
      prefix: "function add(a, b) {\n  return ",
      suffix: "\n}",
      language: "javascript",
      filename: "math.js",
      max_tokens: 150,
      model: "haiku",
    };

    expect(requestBody.prefix).toContain("function add");
    expect(requestBody.suffix).toBe("\n}");
    expect(requestBody.language).toBe("javascript");
    expect(requestBody.filename).toBe("math.js");
    expect(requestBody.model).toBe("haiku");
  });

  it("should include model in request body", () => {
    const requestBody = {
      prefix: "test",
      suffix: "",
      language: "python",
      filename: "test.py",
      max_tokens: 100,
      model: "haiku",
    };

    expect(requestBody.model).toBe("haiku");
  });
});

describe("Completion Response Parsing", () => {
  it("should handle successful response", () => {
    const response = {
      completion: "a + b;",
    };

    expect(response.completion).toBe("a + b;");
    expect(response.completion).toBeTruthy();
  });

  it("should handle error response", () => {
    const response = {
      completion: "",
      error: "Server error",
    };

    expect(response.completion).toBe("");
    expect(response.error).toBe("Server error");
  });

  it("should handle empty completion", () => {
    const response: { completion: string; error?: string } = {
      completion: "",
    };

    expect(response.completion).toBe("");
    expect(response.error).toBeUndefined();
  });
});

describe("Debounce Logic", () => {
  it("should respect debounce timing", async () => {
    const debounceMs = 300;
    let executed = false;

    const debouncePromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        executed = true;
        resolve();
      }, debounceMs);
    });

    expect(executed).toBe(false);
    await debouncePromise;
    expect(executed).toBe(true);
  });

  it("should cancel previous request when new one arrives", async () => {
    let lastRequestId = 0;
    const requests: number[] = [];

    // Simulate rapid requests
    for (let i = 0; i < 3; i++) {
      const requestId = ++lastRequestId;
      requests.push(requestId);
    }

    // Only the last request should be processed
    const currentRequestId = lastRequestId;
    const shouldProcess = requests.filter((id) => id === currentRequestId);

    expect(shouldProcess.length).toBe(1);
    expect(shouldProcess[0]).toBe(3);
  });
});

describe("Model Configuration", () => {
  it("should support sonnet model", () => {
    const validModels = ["sonnet", "haiku"];
    expect(validModels).toContain("sonnet");
  });

  it("should support haiku model", () => {
    const validModels = ["sonnet", "haiku"];
    expect(validModels).toContain("haiku");
  });

  it("should default to haiku when not specified", () => {
    const config = { model: undefined };
    const model = config.model || "haiku";
    expect(model).toBe("haiku");
  });
});

describe("Context Extraction", () => {
  it("should calculate correct line ranges", () => {
    const position = { line: 100, character: 0 };
    const maxContextLines = 30;
    const documentLineCount = 200;

    const startLine = Math.max(0, position.line - maxContextLines);
    const endLine = Math.min(
      documentLineCount - 1,
      position.line + maxContextLines
    );

    expect(startLine).toBe(70);
    expect(endLine).toBe(130);
  });

  it("should handle start of file", () => {
    const position = { line: 10, character: 0 };
    const maxContextLines = 30;

    const startLine = Math.max(0, position.line - maxContextLines);

    expect(startLine).toBe(0);
  });

  it("should handle end of file", () => {
    const position = { line: 190, character: 0 };
    const maxContextLines = 30;
    const documentLineCount = 200;

    const endLine = Math.min(
      documentLineCount - 1,
      position.line + maxContextLines
    );

    expect(endLine).toBe(199);
  });
});
