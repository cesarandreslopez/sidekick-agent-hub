import { statuslineAction } from './commands/statusline';
import { isStatuslineInvocation } from './argvScan';
import { installClosedPipeHandler } from './closedPipe';

if (isStatuslineInvocation(process.argv.slice(2))) {
  // A closed reader must not cut off the state.json write and quota persistence.
  installClosedPipeHandler({ exit: false });
  void statuslineAction();
} else {
  await import('./sidekick-main.mjs');
}
