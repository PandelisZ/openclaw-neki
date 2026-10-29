import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionFromEnv, errorCode } from '../src/connection.mjs';

test('connection inputs preserve credentials and TLS and omit adapter-only selector', () => {
  const url = new URL(connectionFromEnv('TEST_DSN', { TEST_DSN: 'postgres://test:secret%40value@example.test/db?sslmode=require&neki=true&application_name=test' }));
  assert.equal(url.password, 'secret%40value');
  assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  assert.equal(url.searchParams.has('neki'), false);
  assert.equal(url.searchParams.get('application_name'), 'test');
});

test('input and server failures never expose raw credential-bearing errors', () => {
  assert.throws(() => connectionFromEnv('NEKI_DATABASE_URL', { NEKI_DATABASE_URL: 'secret-value' }), /must contain a PostgreSQL connection URL/);
  assert.throws(() => connectionFromEnv('bad env', {}), /Invalid/);
  assert.equal(errorCode({ code: 'NK013', message: 'password=secret' }), 'NK013');
  assert.equal(errorCode({ code: 'password=secret' }), 'UNKNOWN');
});
