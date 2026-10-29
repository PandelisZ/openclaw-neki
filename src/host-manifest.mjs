import { readFileSync } from 'node:fs';

/** Named, bundled snapshots only; default installation stays on its original pin. */
export function loadHostManifest(profile) {
  if (profile !== undefined && (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile))) {
    throw new Error('Host profile must be a bundled snapshot name');
  }
  const name = profile === undefined ? 'host.json' : `host-${profile}.json`;
  return JSON.parse(readFileSync(new URL(`../patches/${name}`, import.meta.url), 'utf8'));
}
