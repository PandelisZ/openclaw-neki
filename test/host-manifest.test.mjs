import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHostManifest } from '../src/host-manifest.mjs';

test('default pin remains stable while an explicit profile qualifies a separate main snapshot', () => {
  assert.equal(loadHostManifest().baseCommit, 'd7349d9395e2bde0f42882a9f7ef8afab59e19c3');
  const main = loadHostManifest('main-3462563');
  assert.equal(main.baseCommit, '34625635a1c04944ca68d2897f68fb24866e5552');
  assert.equal(main.files.length, loadHostManifest().files.length);
  assert.equal(main.patchSha256, loadHostManifest().patchSha256);
});

test('profile cannot read a path, arbitrary manifest, or external URL', () => {
  for (const value of ['../host', '/tmp/host', 'https://example.org', '', 'main/3462563', null, {}]) {
    assert.throws(() => loadHostManifest(value), /bundled snapshot/);
  }
  assert.throws(() => loadHostManifest('missing-snapshot'), { code: 'ENOENT' });
});
