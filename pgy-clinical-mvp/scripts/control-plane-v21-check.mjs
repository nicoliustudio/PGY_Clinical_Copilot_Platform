import { spawnSync } from 'node:child_process';

// Source exports no longer ship the historical reference/ tree. Run the canonical V2.1 core
// invariant test from this repository instead of importing a missing file.
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/control-plane-v21.test.ts'], {
  stdio: 'inherit',
  cwd: process.cwd(),
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
