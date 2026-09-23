import { spawnSync } from 'node:child_process';

// V2.1.2 Closure invariant suite（deterministic，小集合）。
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/control-plane-v212.test.ts'], {
  stdio: 'inherit',
  cwd: process.cwd(),
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
