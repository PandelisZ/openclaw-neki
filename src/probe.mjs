import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createClient, errorCode, inRollbackTransaction } from './connection.mjs';
import { quoteIdentifier } from './sql.mjs';

/** Owns its connection and optional disposable schema; never opens an OpenClaw store. */
export async function probeNeki(connectionString, { writeProbes = false } = {}) {
  const client = createClient(connectionString);
  const checks = [];
  let schema;
  let cleanup = 'not-needed';
  const check = async (id, operation) => {
    const started = performance.now();
    try {
      await operation();
      checks.push({ id, supported: true, durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      checks.push({ id, supported: false, code: errorCode(error), durationMs: Math.round(performance.now() - started) });
    }
  };
  try {
    await client.connect();
    await check('postgres16_utf8', async () => {
      const { rows: [row] } = await client.query("SELECT current_setting('server_version_num')::int AS version, current_setting('server_encoding') AS encoding");
      assert.ok(row.version >= 160000 && row.encoding === 'UTF8');
    });
    await check('exported_snapshot', () => inRollbackTransaction(client, () => client.query('SELECT pg_export_snapshot()')));
    await check('neki_ddl_barrier', () => client.query('SELECT __neki.wait_for_ddl()'));
    if (writeProbes) {
      schema = `oc_neki_probe_${randomBytes(12).toString('hex')}`;
      const q = quoteIdentifier(schema);
      cleanup = 'pending';
      await client.query(`CREATE SCHEMA ${q}`);
      await check('autocommit_ddl', async () => {
        await client.query(`CREATE TABLE ${q}.probe (id integer PRIMARY KEY, value integer NOT NULL)`);
        await client.query(`INSERT INTO ${q}.probe VALUES (1, 10)`);
      });
      await check('transaction_rollback', async () => {
        await inRollbackTransaction(client, async () => {
          await client.query(`UPDATE ${q}.probe SET value = 20 WHERE id = 1`);
        });
        const { rows: [row] } = await client.query(`SELECT value FROM ${q}.probe WHERE id = 1`);
        assert.equal(row.value, 10);
      });
      await check('nested_savepoint', () => inRollbackTransaction(client, async () => {
        await client.query('SAVEPOINT openclaw_tx_nested');
        await client.query(`UPDATE ${q}.probe SET value = 30 WHERE id = 1`);
        await client.query('ROLLBACK TO SAVEPOINT openclaw_tx_nested');
        const { rows: [row] } = await client.query(`SELECT value FROM ${q}.probe WHERE id = 1`);
        assert.equal(row.value, 10);
      }));
      await check('dependent_trigger_ddl', () => inRollbackTransaction(client, async () => {
        await client.query(`CREATE TABLE ${q}.dependent (id integer PRIMARY KEY, value integer)`);
        await client.query(`CREATE FUNCTION ${q}.invalidate() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN UPDATE ${q}.dependent SET value = NULL WHERE id = NEW.id; RETURN NULL; END; $fn$`);
        await client.query(`CREATE TRIGGER invalidate AFTER UPDATE OF value ON ${q}.dependent FOR EACH ROW WHEN (NEW.value IS NOT DISTINCT FROM OLD.value) EXECUTE FUNCTION ${q}.invalidate()`);
      }));
    }
  } finally {
    try {
      if (schema) {
        try {
          await client.query('ROLLBACK');
          await client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
          const { rows: [row] } = await client.query('SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present', [schema]);
          cleanup = row.present ? 'failed' : 'complete';
        } catch { cleanup = 'failed'; }
      }
    } finally { await client.end(); }
  }
  return {
    reportVersion: 1,
    checks,
    cleanup,
    nativeConversationStorage: {
      ready: false,
      reason: 'Stock OpenClaw has no pre-boot database schema lifecycle extension point. These probes do not establish native conversation support.',
    },
  };
}
