#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadHostManifest } from '../src/host-manifest.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const target = process.argv[2];
const profile = process.argv[3] === '--profile' ? process.argv[4] : undefined;
if (!target || ![3, 5].includes(process.argv.length) || (process.argv.length === 5 && !profile)) {
  console.error('Usage: node scripts/apply-host-patch.mjs /absolute/path/to/task-owned/openclaw-checkout [--profile main-3462563]');
  process.exitCode = 1;
} else {
  try {
    const root = path.resolve(target);
    const manifest = loadHostManifest(profile);
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== manifest.baseCommit) throw new Error('Checkout HEAD does not match the qualified upstream commit');
    for (const file of manifest.files) {
      const local = path.join(root, file.path);
      if (file.beforeSha256 === null ? existsSync(local) : !existsSync(local) || sha(readFileSync(local)) !== file.beforeSha256) {
        throw new Error(`Target file differs from the qualified base: ${file.path}`);
      }
    }
    const patch = path.join(packageRoot, 'patches', manifest.patch);
    if (sha(readFileSync(patch)) !== manifest.patchSha256) throw new Error('Host patch checksum does not match manifest');
    execFileSync('git', ['-C', root, 'apply', '--check', patch], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'apply', patch], { stdio: 'pipe' });
    for (const file of manifest.files) {
      if (sha(readFileSync(path.join(root, file.path))) !== file.afterSha256) throw new Error(`Applied file verification failed: ${file.path}`);
    }
    console.log(`Applied experimental host patch at ${manifest.baseCommit}. Native conversation qualification is a separate check.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot apply host patch');
    process.exitCode = 1;
  }
}
