import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native Neki model conversation and context survive a process restart', {
  skip: process.env.NEKI_SINGLE_SHARD !== '1' && 'Requires explicit NEKI_SINGLE_SHARD=1 and live credentials', timeout: 660_000,
}, async (context) => {
  const script = fileURLToPath(new URL('../../scripts/qualify-gateway.mjs', import.meta.url));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: process.env, stdio: 'inherit' });
    let hardStop;
    const abort = () => {
      child.kill('SIGTERM');
      hardStop = setTimeout(() => child.kill('SIGKILL'), 30_000);
    };
    context.signal.addEventListener('abort', abort, { once: true });
    const settled = () => { clearTimeout(hardStop); context.signal.removeEventListener('abort', abort); };
    child.once('error', error => { settled(); reject(error); });
    child.once('exit', code => { settled(); resolve(code); });
  });
  assert.equal(code, 0);
});
