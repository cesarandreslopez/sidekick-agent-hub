import { statuslineAction } from './commands/statusline';

function isStatuslineInvocation(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') continue;
    if (argument === '--project' || argument === '--provider') {
      index++;
      continue;
    }
    if (argument.startsWith('--project=') || argument.startsWith('--provider=')) continue;
    return argument === 'statusline';
  }
  return false;
}

if (isStatuslineInvocation(process.argv.slice(2))) {
  statuslineAction();
} else {
  await import('./sidekick-main.mjs');
}
