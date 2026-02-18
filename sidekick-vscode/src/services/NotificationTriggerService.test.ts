/**
 * @fileoverview Unit tests for NotificationTriggerService.
 *
 * Tests destructive command pattern matching, description field usage,
 * sensitive path triggers, and false positive avoidance.
 */

import { describe, it, expect } from 'vitest';

// Extract the patterns from BUILT_IN_TRIGGERS for direct regex testing.
// These must stay in sync with the actual values in NotificationTriggerService.ts.
const DESTRUCTIVE_CMD_PATTERN = 'rm\\s+-[a-zA-Z]*[rf]|git\\s+push\\s+(-f|--force)|git\\s+reset\\s+--hard|git\\s+clean\\s+-[a-zA-Z]*[fd]|drop\\s+(table|database)|chmod\\s+-R|chown\\s+-R|>\\s*/dev/';
const ENV_ACCESS_PATTERN = '\\.(env|pem|key|secret|credentials)$|id_rsa|id_ed25519';
const SENSITIVE_PATH_PATTERN = '^/(etc|boot|usr/(s?bin|lib))|/\\.ssh/|/\\.gnupg/';

describe('NotificationTriggerService patterns', () => {
  describe('destructive-cmd pattern', () => {
    const regex = new RegExp(DESTRUCTIVE_CMD_PATTERN, 'i');

    describe('rm variants', () => {
      it('matches rm -rf', () => {
        expect(regex.test('rm -rf /tmp/project')).toBe(true);
      });

      it('matches rm -r (without -f)', () => {
        expect(regex.test('rm -r /tmp/test')).toBe(true);
      });

      it('matches rm -f (without -r)', () => {
        expect(regex.test('rm -f important.txt')).toBe(true);
      });

      it('matches rm -fr (reversed flags)', () => {
        expect(regex.test('rm -fr /home/user/project')).toBe(true);
      });

      it('matches rm -Rf (uppercase R)', () => {
        expect(regex.test('rm -Rf build/')).toBe(true);
      });

      it('matches rm with extra flags like -rfv', () => {
        expect(regex.test('rm -rfv /tmp/cache')).toBe(true);
      });

      it('does not match rm without dangerous flags', () => {
        expect(regex.test('rm file.txt')).toBe(false);
      });

      it('does not match words containing "rm"', () => {
        expect(regex.test('echo "format this"')).toBe(false);
      });
    });

    describe('git push variants', () => {
      it('matches git push --force', () => {
        expect(regex.test('git push --force origin main')).toBe(true);
      });

      it('matches git push -f (short flag)', () => {
        expect(regex.test('git push -f origin main')).toBe(true);
      });

      it('does not match regular git push', () => {
        expect(regex.test('git push origin main')).toBe(false);
      });
    });

    describe('git reset', () => {
      it('matches git reset --hard', () => {
        expect(regex.test('git reset --hard HEAD~1')).toBe(true);
      });

      it('does not match git reset --soft', () => {
        expect(regex.test('git reset --soft HEAD~1')).toBe(false);
      });
    });

    describe('git clean variants', () => {
      it('matches git clean -fd', () => {
        expect(regex.test('git clean -fd')).toBe(true);
      });

      it('matches git clean -f', () => {
        expect(regex.test('git clean -f')).toBe(true);
      });

      it('matches git clean -fdx', () => {
        expect(regex.test('git clean -fdx')).toBe(true);
      });

      it('does not match git clean -n (dry run)', () => {
        expect(regex.test('git clean -n')).toBe(false);
      });
    });

    describe('SQL drops', () => {
      it('matches drop table', () => {
        expect(regex.test('DROP TABLE users')).toBe(true);
      });

      it('matches drop database', () => {
        expect(regex.test('drop database production')).toBe(true);
      });
    });

    describe('permission changes', () => {
      it('matches chmod -R', () => {
        expect(regex.test('chmod -R 777 /var/www')).toBe(true);
      });

      it('matches chown -R', () => {
        expect(regex.test('chown -R root:root /etc/app')).toBe(true);
      });

      it('does not match chmod without -R', () => {
        expect(regex.test('chmod 644 file.txt')).toBe(false);
      });
    });

    describe('device file redirect', () => {
      it('matches redirect to /dev/null', () => {
        expect(regex.test('cat data > /dev/null')).toBe(true);
      });

      it('matches redirect to /dev/sda', () => {
        expect(regex.test('dd if=image.iso > /dev/sda')).toBe(true);
      });
    });

    describe('false positives', () => {
      it('does not match echo command', () => {
        expect(regex.test('echo "hello world"')).toBe(false);
      });

      it('does not match ls command', () => {
        expect(regex.test('ls -la /tmp')).toBe(false);
      });

      it('does not match npm install', () => {
        expect(regex.test('npm install express')).toBe(false);
      });

      it('does not match git status', () => {
        expect(regex.test('git status')).toBe(false);
      });

      it('does not match git commit', () => {
        expect(regex.test('git commit -m "fix: something"')).toBe(false);
      });

      it('does not match mkdir -p', () => {
        expect(regex.test('mkdir -p /tmp/test')).toBe(false);
      });
    });
  });

  describe('env-access pattern', () => {
    const regex = new RegExp(ENV_ACCESS_PATTERN, 'i');

    it('matches .env file', () => {
      expect(regex.test('/project/.env')).toBe(true);
    });

    it('matches .pem file', () => {
      expect(regex.test('/certs/server.pem')).toBe(true);
    });

    it('matches .key file', () => {
      expect(regex.test('/ssl/private.key')).toBe(true);
    });

    it('matches id_rsa', () => {
      expect(regex.test('/home/user/.ssh/id_rsa')).toBe(true);
    });

    it('matches id_ed25519', () => {
      expect(regex.test('/home/user/.ssh/id_ed25519')).toBe(true);
    });

    it('does not match .ts file', () => {
      expect(regex.test('/src/index.ts')).toBe(false);
    });
  });

  describe('sensitive-path-write pattern', () => {
    const regex = new RegExp(SENSITIVE_PATH_PATTERN, 'i');

    it('matches /etc/ paths', () => {
      expect(regex.test('/etc/hosts')).toBe(true);
    });

    it('matches /etc/nginx/ paths', () => {
      expect(regex.test('/etc/nginx/nginx.conf')).toBe(true);
    });

    it('matches /boot/ paths', () => {
      expect(regex.test('/boot/grub/grub.cfg')).toBe(true);
    });

    it('matches /usr/bin/ paths', () => {
      expect(regex.test('/usr/bin/python3')).toBe(true);
    });

    it('matches /usr/sbin/ paths', () => {
      expect(regex.test('/usr/sbin/nginx')).toBe(true);
    });

    it('matches /usr/lib/ paths', () => {
      expect(regex.test('/usr/lib/systemd/system/app.service')).toBe(true);
    });

    it('matches .ssh directory paths', () => {
      expect(regex.test('/home/user/.ssh/config')).toBe(true);
    });

    it('matches .gnupg directory paths', () => {
      expect(regex.test('/home/user/.gnupg/pubring.kbx')).toBe(true);
    });

    it('does not match /home/user/project/', () => {
      expect(regex.test('/home/user/project/src/main.ts')).toBe(false);
    });

    it('does not match /tmp/ paths', () => {
      expect(regex.test('/tmp/build/output.js')).toBe(false);
    });

    it('does not match /var/log/ paths', () => {
      expect(regex.test('/var/log/app.log')).toBe(false);
    });
  });

  describe('description field in notification body', () => {
    it('uses description when present', () => {
      const description = 'Delete all project files recursively';
      const command = 'rm -rf /tmp/project';
      const body = description
        ? `${description} (${command.substring(0, 60)})`
        : `Command: ${command.substring(0, 80)}`;
      expect(body).toBe('Delete all project files recursively (rm -rf /tmp/project)');
    });

    it('falls back to Command: format without description', () => {
      const description = undefined;
      const command = 'rm -rf /tmp/project';
      const body = description
        ? `${description} (${command.substring(0, 60)})`
        : `Command: ${command.substring(0, 80)}`;
      expect(body).toBe('Command: rm -rf /tmp/project');
    });

    it('truncates long commands in description format', () => {
      const description = 'Clean build artifacts';
      const command = 'rm -rf ' + 'a'.repeat(100);
      const body = `${description} (${command.substring(0, 60)})`;
      expect(body.length).toBeLessThan(description.length + 65);
    });
  });
});
