#!/usr/bin/env node
/** Capture the extra docs stills (directors/screenshots.mjs) into out/screenshots/final/stills/. */
import { join } from 'node:path';
import { DEMO_DIR } from './lib/sandbox.mjs';
import { capture } from './directors/screenshots.mjs';

const { leak, stills } = await capture({ outDir: join(DEMO_DIR, 'out', 'screenshots') });
console.log(leak.assertClean());
console.log(stills);
