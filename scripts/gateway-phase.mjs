import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Only the qualification harness imports host internals. The installed plugin does not.
const source = process.env.OPENCLAW_SOURCE_DIR;
const root = process.env.OPENCLAW_STATE_DIR;
const phase = process.argv[2];
assert.ok(source && root && ['first', 'restart'].includes(phase), 'Run scripts/qualify-gateway.mjs');
const { marker } = JSON.parse(await readFile(path.join(root, 'identity.json'), 'utf8'));
const { startGatewayServer } = await import(pathToFileURL(path.join(source, 'src/gateway/server.ts')).href);
const { GatewayClient } = await import(pathToFileURL(path.join(source, 'src/gateway/client.ts')).href);
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
let server, client;
const sessionKey = 'agent:main:neki-proof';
const report = {};
try {
  server = await startGatewayServer(port, { bind: 'loopback', auth: { mode: 'token', token }, controlUiEnabled: false });
  await server.startupSettled;
  await new Promise((resolve, reject) => {
    client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, clientName: 'cli',
      clientDisplayName: 'Neki isolated qualification', mode: 'cli', role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write'], deviceIdentity: null,
      onHelloOk: resolve, onConnectError: reject, requestTimeoutMs: 180_000 });
    client.start();
    setTimeout(() => reject(new Error('Gateway connection timeout')), 30_000).unref();
  });
  if (phase === 'restart') {
    const history = await client.request('chat.history', { sessionKey, limit: 20 });
    const assistantText = message => typeof message.content === 'string' ? message.content.trim() :
      (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
    assert.ok(history.messages?.some(message => message.role === 'assistant' && assistantText(message) === `ACK_${marker}`),
      'Persisted first assistant reply missing after process restart');
    report.restartHistory = true;
  }
  const response = await client.request('agent', {
    agentId: 'main', sessionKey, ...(phase === 'first' ? { createSessionIfMissing: true } : {}),
    message: phase === 'first' ? `Remember this marker for our conversation: ${marker}. Reply exactly ACK_${marker}.` :
      'Reply with only the marker I asked you to remember previously, without the ACK_ prefix.',
    deliver: false, idempotencyKey: `neki-${phase}-${randomBytes(8).toString('hex')}`, timeout: 120, promptMode: 'minimal',
  }, { expectFinal: true, timeoutMs: 180_000 });
  // Request echoes, system reports and error payloads are never success evidence.
  const payloads = response.result?.payloads ?? [];
  const visible = payloads.filter(p => !p.isError && typeof p.text === 'string').map(p => p.text).join('\n').trim();
  await writeFile(path.join(root, `${phase}-response.json`), JSON.stringify(response), { mode: 0o600 });
  assert.equal(response.status, 'ok', `Native model turn failed; inspect private ${phase}-response.json`);
  assert.ok(!payloads.some(p => p.isError), 'Assistant returned an error payload');
  assert.equal(visible, phase === 'first' ? `ACK_${marker}` : marker, 'Assistant did not recall the exact marker');
  if (phase === 'first') report.nativeConversation = true;
  else report.modelContextAfterProcessRestart = true;
} finally {
  await client?.stop();
  await server?.close();
}
await writeFile(path.join(root, `${phase}.json`), JSON.stringify(report), { mode: 0o600 });
