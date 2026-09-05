import { statuslineAction } from './commands/statusline';
import { isStatuslineInvocation } from './argvScan';

if (isStatuslineInvocation(process.argv.slice(2))) {
  void statuslineAction();
} else {
  await import('./sidekick-main.mjs');
}
