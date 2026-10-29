#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { connectionFromEnv, createClient, errorCode } from '../src/connection.mjs';
import { quoteIdentifier } from '../src/sql.mjs';
import { loadHostManifest } from '../src/host-manifest.mjs';

// Explicit opt-in: this creates disposable schemas and makes two paid model requests.
assert.equal(process.env.NEKI_SINGLE_SHARD, '1', 'Set NEKI_SINGLE_SHARD=1 after confirming the test database has one shard');
assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required');
assert.ok(process.env.OPENCLAW_SOURCE_DIR, 'OPENCLAW_SOURCE_DIR must point to the pinned, patched source checkout');
assert.match(process.env.NEKI_RUNTIME_SHARD_UID || '', /^sh[a-z0-9]+$/, 'NEKI_RUNTIME_SHARD_UID must identify the approved shard');
const source = path.resolve(process.env.OPENCLAW_SOURCE_DIR);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = loadHostManifest(process.env.OPENCLAW_HOST_PROFILE);
assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  manifest.baseCommit, 'Host checkout HEAD must match the pinned upstream commit');
for (const file of manifest.files) {
  const hash = createHash('sha256').update(await readFile(path.join(source, file.path))).digest('hex');
  assert.equal(hash, file.afterSha256, `Host file differs from the qualified patch: ${file.path}`);
}
const connection = connectionFromEnv();
const prefix = `oc_neki_e2e_${randomBytes(7).toString('hex')}`;
const root = await mkdtemp(path.join(tmpdir(), 'openclaw-neki-'));
const marker = `NEKI_NATIVE_${randomBytes(12).toString('hex').toUpperCase()}`;
const token = randomBytes(32).toString('hex');
await mkdir(path.join(root, 'workspace'), { mode: 0o700 });
const config = {
  database: { engine: 'sqlite', families: { agent: { engine: 'postgres' } }, postgres: {
    connection: { source: 'env', provider: 'default', id: 'NEKI_DATABASE_URL' },
    schemaPrefix: prefix, schemaLifecycleProvider: 'neki',
  } },
  gateway: { mode: 'local', auth: { mode: 'token', token }, controlUi: { enabled: false } },
  plugins: { enabled: true, load: { paths: [packageRoot] }, slots: { memory: 'none' }, entries: { neki: { enabled: true }, openai: { enabled: true } } },
  agents: { ownership: 'explicit', defaults: { model: process.env.NEKI_PROOF_MODEL || 'openai/gpt-4.1-mini', skipBootstrap: true }, entries: { main: { workspace: path.join(root, 'workspace') } } },
};
await writeFile(path.join(root, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 });
await writeFile(path.join(root, 'identity.json'), JSON.stringify({ marker }), { mode: 0o600 });
const env = { ...process.env, OPENCLAW_SOURCE_DIR: source, OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), NEKI_DATABASE_URL: connection,
  OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_GMAIL_WATCHER: '1',
  OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_CANVAS_HOST: '1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1' };
const report = { nativeConversation: false, restartHistory: false, modelContextAfterProcessRestart: false, cleanup: 'pending' };
let activeChild;
let cancelled = false;
let processGroupsStopped = true;
const stopChild = (signal = 'SIGTERM') => {
  if (!activeChild) return;
  try {
    if (process.platform !== 'win32') process.kill(-activeChild.pid, signal);
    else activeChild.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const cancel = () => { cancelled = true; stopChild(); };
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
async function phase(name) {
  assert.ok(!cancelled, 'Qualification cancelled');
  const log = await open(path.join(root, `${name}.log`), 'wx', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', path.join(source, 'scripts/tsx.mjs'), path.join(packageRoot, 'scripts/gateway-phase.mjs'), name],
        { cwd: source, env, stdio: ['ignore', log.fd, log.fd], detached: process.platform !== 'win32' });
      activeChild = child;
      let hardStop;
      const terminate = () => {
        stopChild();
        hardStop ??= setTimeout(() => stopChild('SIGKILL'), 10_000);
      };
      const deadline = setTimeout(terminate, 300_000);
      process.on('SIGINT', terminate);
      process.on('SIGTERM', terminate);
      const settled = () => {
        clearTimeout(deadline); clearTimeout(hardStop);
        process.off('SIGINT', terminate); process.off('SIGTERM', terminate);
        activeChild = undefined;
      };
      child.once('error', error => { settled(); reject(error); });
      child.once('exit', async (code, signal) => {
        try {
          // A leader exit does not prove its process group has stopped. Reconcile
          // descendants before releasing ownership or starting remote cleanup.
          if (process.platform !== 'win32') {
            const exists = () => {
              try { process.kill(-child.pid, 0); return true; }
              catch (error) { if (error.code === 'ESRCH') return false; throw error; }
            };
            if (exists()) {
              stopChild('SIGKILL');
              for (let attempt = 0; attempt < 200 && exists(); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 25));
              }
              if (exists()) {
                processGroupsStopped = false;
                throw new Error('Owned Gateway process group could not be reconciled; remote cleanup withheld');
              }
            }
          }
          if (code === 0 && !cancelled) resolve(); else reject(new Error(`Gateway phase ${name} failed (${signal || code}); private evidence: ${root}`));
        } catch (error) { reject(error); }
        finally { settled(); }
      });
    });
    return JSON.parse(await readFile(path.join(root, `${name}.json`), 'utf8'));
  } finally { await log.close(); }
}
try {
  Object.assign(report, await phase('first'));
  console.log(JSON.stringify({ phase: 'first', nativeConversation: report.nativeConversation }));
  Object.assign(report, await phase('restart'));
} catch (error) {
  report.failure = { code: errorCode(error), message: error.message };
  process.exitCode = 1;
} finally {
  const pg = createClient(connection);
  try {
    assert.ok(processGroupsStopped, 'Process termination uncertain; remote cleanup withheld');
    await pg.connect();
    const owned = (await pg.query('SELECT nspname FROM pg_namespace WHERE left(nspname,$1)=$2', [prefix.length + 1, `${prefix}_`])).rows;
    for (const { nspname } of owned) await pg.query(`DROP SCHEMA ${quoteIdentifier(nspname)} CASCADE`);
    const remaining = (await pg.query('SELECT nspname FROM pg_namespace WHERE left(nspname,$1)=$2', [prefix.length + 1, `${prefix}_`])).rows;
    assert.equal(remaining.length, 0, 'Disposable schema cleanup incomplete');
    report.cleanup = 'complete';
  } catch (error) { report.cleanup = processGroupsStopped ? 'failed' : 'uncertain-processes'; report.cleanupCode = errorCode(error); process.exitCode = 1; }
  finally { await pg.end(); }
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  console.log(JSON.stringify({ ...report, evidenceDirectory: root }, null, 2));
}
