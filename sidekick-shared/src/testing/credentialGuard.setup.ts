/**
 * Vitest wiring for the credential guard, loaded through `setupFiles` by all
 * three packages: install it, and fail any test that reached real
 * credentials or homes. Imports nothing from vitest on purpose: the CLI and
 * VS Code packages would resolve a second copy from this directory. It
 * relies on `globals: true` instead.
 */
import { installCredentialGuard } from './credentialGuard';

declare const afterEach: (fn: () => void) => void;

const guard = installCredentialGuard();

afterEach(() => guard.assertNoViolations());
