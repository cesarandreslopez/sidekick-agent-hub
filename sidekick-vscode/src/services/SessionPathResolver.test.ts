/**
 * @fileoverview Unit tests for SessionPathResolver.
 */

import { describe, it, expect } from 'vitest';
import { encodeWorkspacePath } from './SessionPathResolver';

describe('SessionPathResolver', () => {
  describe('encodeWorkspacePath', () => {
    it('encodes Unix path with leading hyphen', () => {
      const result = encodeWorkspacePath('/home/user/code/project');
      expect(result).toBe('-home-user-code-project');
    });

    it('encodes Mac path with leading hyphen', () => {
      const result = encodeWorkspacePath('/Users/user/code/project');
      expect(result).toBe('-Users-user-code-project');
    });

    it('encodes Windows path with double hyphen for drive letter', () => {
      const result = encodeWorkspacePath('C:\\Users\\user\\code\\project');
      expect(result).toBe('C--Users-user-code-project');
    });

    it('encodes Windows path with forward slashes', () => {
      const result = encodeWorkspacePath('C:/Users/user/code/project');
      expect(result).toBe('C--Users-user-code-project');
    });

    it('encodes Windows path with underscores (OneDrive)', () => {
      const result = encodeWorkspacePath(
        'C:\\Users\\andre\\OneDrive\\Documents\\humans_are_awesome_epub',
      );
      expect(result).toBe('C--Users-andre-OneDrive-Documents-humans-are-awesome-epub');
    });

    it('encodes Unix path with underscores', () => {
      const result = encodeWorkspacePath('/home/user/my_project_name');
      expect(result).toBe('-home-user-my-project-name');
    });

    it('handles root path', () => {
      const result = encodeWorkspacePath('/');
      expect(result).toBe('-');
    });

    it('handles home directory', () => {
      const result = encodeWorkspacePath('/home/cal');
      expect(result).toBe('-home-cal');
    });
  });
});
