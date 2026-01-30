/**
 * @fileoverview Tests for TimeoutManager service.
 *
 * Tests timeout calculation, retry logic, and abort signal handling.
 *
 * @module TimeoutManager.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TimeoutManager,
  TimeoutConfig,
  DEFAULT_TIMEOUTS,
  getTimeoutManager,
} from './TimeoutManager';
import { TimeoutError } from '../types';

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    withProgress: vi.fn(async (_options, task) => {
      // Create a mock cancellation token
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      };
      return task({ report: vi.fn() }, token);
    }),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => {
        const defaults: Record<string, unknown> = {
          timeouts: DEFAULT_TIMEOUTS,
          timeoutPerKb: 500,
          maxTimeout: 120000,
          autoRetryOnTimeout: false,
        };
        return defaults[key];
      }),
    })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  ProgressLocation: {
    Notification: 15,
  },
}));

describe('TimeoutManager', () => {
  let manager: TimeoutManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TimeoutManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('calculateTimeout', () => {
    it('should return base timeout for zero context size', () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      const timeout = manager.calculateTimeout(config, 0);
      expect(timeout).toBe(30000);
    });

    it('should add time proportional to context size', () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      // 10KB context = 30000 + (10 * 500) = 35000ms
      const timeout = manager.calculateTimeout(config, 10 * 1024);
      expect(timeout).toBe(35000);
    });

    it('should cap timeout at maxTimeout', () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 60000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      // 100KB context would be 30000 + (100 * 500) = 80000, capped at 60000
      const timeout = manager.calculateTimeout(config, 100 * 1024);
      expect(timeout).toBe(60000);
    });

    it('should round to nearest millisecond', () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      // Context of 1.5KB = 30000 + (1.5 * 500) = 30750
      const timeout = manager.calculateTimeout(config, 1.5 * 1024);
      expect(timeout).toBe(30750);
    });
  });

  describe('getTimeoutConfig', () => {
    it('should return default timeout for operation type', () => {
      const config = manager.getTimeoutConfig('explanation');
      expect(config.baseTimeout).toBe(DEFAULT_TIMEOUTS.explanation);
      expect(config.perKbTimeout).toBe(500);
      expect(config.maxTimeout).toBe(120000);
      expect(config.retryMultiplier).toBe(1.5);
    });

    it('should return correct timeout for different operations', () => {
      expect(manager.getTimeoutConfig('inlineCompletion').baseTimeout).toBe(15000);
      expect(manager.getTimeoutConfig('codeTransform').baseTimeout).toBe(60000);
      expect(manager.getTimeoutConfig('commitMessage').baseTimeout).toBe(30000);
    });
  });

  describe('executeWithTimeout', () => {
    it('should return successful result when task completes', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      const result = await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async () => 'success',
        config,
        showProgress: false,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.timedOut).toBe(false);
    });

    it('should return error result when task throws', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      const error = new Error('Test error');
      const result = await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async () => { throw error; },
        config,
        showProgress: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
      expect(result.timedOut).toBe(false);
    });

    it('should return timeout result when TimeoutError is thrown', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      const result = await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async () => { throw new TimeoutError('Timed out', 30000); },
        config,
        showProgress: false,
      });

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.timeoutMs).toBe(30000);
    });

    it('should pass abort signal to task', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      let receivedSignal: AbortSignal | undefined;
      await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async (signal) => {
          receivedSignal = signal;
          return 'success';
        },
        config,
        showProgress: false,
      });

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });

    it('should include context size in result', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 30000,
        maxTimeout: 120000,
        perKbTimeout: 500,
        retryMultiplier: 1.5,
      };

      const result = await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async () => 'success',
        config,
        contextSize: 5 * 1024, // 5KB
        showProgress: false,
      });

      expect(result.contextSizeKb).toBe(5);
    });

    it('should retry when onTimeout returns retry', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 1000,
        maxTimeout: 10000,
        perKbTimeout: 0,
        retryMultiplier: 2.0,
      };

      let callCount = 0;
      const result = await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async () => {
          callCount++;
          if (callCount === 1) {
            throw new TimeoutError('Timed out', 1000);
          }
          return 'success';
        },
        config,
        showProgress: false,
        onTimeout: async () => 'retry',
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(callCount).toBe(2);
    });

    it('should not retry when onTimeout returns cancel', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 1000,
        maxTimeout: 10000,
        perKbTimeout: 0,
        retryMultiplier: 2.0,
      };

      let callCount = 0;
      const result = await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async () => {
          callCount++;
          throw new TimeoutError('Timed out', 1000);
        },
        config,
        showProgress: false,
        onTimeout: async () => 'cancel',
      });

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(callCount).toBe(1);
    });

    it('should increase timeout on retry', async () => {
      const config: TimeoutConfig = {
        baseTimeout: 1000,
        maxTimeout: 10000,
        perKbTimeout: 0,
        retryMultiplier: 2.0,
      };

      const timeouts: number[] = [];
      let callCount = 0;
      await manager.executeWithTimeout({
        operation: 'Test operation',
        task: async () => {
          callCount++;
          if (callCount < 3) {
            throw new TimeoutError('Timed out', config.baseTimeout);
          }
          return 'success';
        },
        config,
        showProgress: false,
        onTimeout: async (timeoutMs) => {
          timeouts.push(timeoutMs);
          return 'retry';
        },
      });

      // First timeout at 1000ms, then 2000ms (1000 * 2.0)
      expect(timeouts[0]).toBe(1000);
      expect(timeouts[1]).toBe(2000);
    });
  });

  describe('execute', () => {
    it('should return result directly when successful', async () => {
      const result = await manager.execute(
        'Test operation',
        async () => 'success',
        'explanation',
        1024
      );

      expect(result).toBe('success');
    });

    it('should throw TimeoutError when timed out', async () => {
      await expect(
        manager.execute(
          'Test operation',
          async () => { throw new TimeoutError('Timed out', 30000); },
          'explanation',
          1024
        )
      ).rejects.toThrow(TimeoutError);
    });

    it('should throw original error on non-timeout failure', async () => {
      const error = new Error('Test error');
      await expect(
        manager.execute(
          'Test operation',
          async () => { throw error; },
          'explanation',
          1024
        )
      ).rejects.toThrow('Test error');
    });
  });

  describe('getTimeoutManager', () => {
    it('should return singleton instance', () => {
      const instance1 = getTimeoutManager();
      const instance2 = getTimeoutManager();
      expect(instance1).toBe(instance2);
    });

    it('should return TimeoutManager instance', () => {
      const instance = getTimeoutManager();
      expect(instance).toBeInstanceOf(TimeoutManager);
    });
  });

  describe('DEFAULT_TIMEOUTS', () => {
    it('should have all operation types defined', () => {
      expect(DEFAULT_TIMEOUTS.inlineCompletion).toBeDefined();
      expect(DEFAULT_TIMEOUTS.explanation).toBeDefined();
      expect(DEFAULT_TIMEOUTS.commitMessage).toBeDefined();
      expect(DEFAULT_TIMEOUTS.documentation).toBeDefined();
      expect(DEFAULT_TIMEOUTS.codeTransform).toBeDefined();
      expect(DEFAULT_TIMEOUTS.review).toBeDefined();
      expect(DEFAULT_TIMEOUTS.prDescription).toBeDefined();
      expect(DEFAULT_TIMEOUTS.inlineChat).toBeDefined();
      expect(DEFAULT_TIMEOUTS.errorExplanation).toBeDefined();
    });

    it('should have sensible timeout values', () => {
      // Inline completions should be fast
      expect(DEFAULT_TIMEOUTS.inlineCompletion).toBeLessThanOrEqual(30000);

      // Code transforms can take longer
      expect(DEFAULT_TIMEOUTS.codeTransform).toBeGreaterThanOrEqual(45000);

      // All timeouts should be at least 5 seconds
      Object.values(DEFAULT_TIMEOUTS).forEach(timeout => {
        expect(timeout).toBeGreaterThanOrEqual(5000);
      });
    });
  });
});
