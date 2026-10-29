import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import profile, { activateRuntime, afterSeal, beforeSeal, executeFreshDdl, initializeConnection, prepare } from '../src/schema-profile.mjs';

const metadataSql = 'CREATE TABLE openclaw_schema_meta (store TEXT PRIMARY KEY, version BIGINT NOT NULL, store_id TEXT NOT NULL)';
const ddl = 'CREATE TABLE sample (id integer PRIMARY KEY); CREATE INDEX sample_id ON sample (id)';

function fixture(t) {
  const previousShard = process.env.NEKI_RUNTIME_SHARD_UID;
  process.env.NEKI_RUNTIME_SHARD_UID = 'shfixture123';
  t.after(() => {
    if (previousShard === undefined) delete process.env.NEKI_RUNTIME_SHARD_UID;
    else process.env.NEKI_RUNTIME_SHARD_UID = previousShard;
  });
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-neki-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = {
    isTransaction: false,
    namespace: false,
    metadata: false,
    native: undefined,
    effects: [],
    exec(sql) {
      this.effects.push(sql);
      if (sql.startsWith('CREATE SCHEMA')) this.namespace = true;
      if (sql.startsWith('CREATE TABLE openclaw_schema_meta')) this.metadata = true;
      this.onExec?.(sql);
    },
    prepare(sql) {
      return { get: (...values) => {
        if (sql.includes('pg_namespace')) { assert.deepEqual(values, ['qualification']); return this.namespace ? { oid: 42 } : undefined; }
        if (sql.includes('to_regclass')) return { relation: this.metadata ? 'openclaw_schema_meta' : null };
        if (/SELECT (?:store, )?version, store_id/.test(sql)) {
          assert.deepEqual(values, ['agent']);
          this.metadataReadSql = sql;
          return sql.includes('SELECT store,') && this.native ? { store: 'agent', ...this.native } : this.native;
        }
        throw new Error(`Unexpected fake query: ${sql}`);
      } };
    },
  };
  const args = { db, namespace: 'qualification', store: 'agent', storeId: 'dedicated-store', version: 17, ddl, metadataSql, journalPath: join(directory, 'custody.sqlite'), allowCreate: true, assertCurrent() {} };
  const editJournal = (operation) => {
    const journal = new DatabaseSync(args.journalPath);
    try { operation(journal); } finally { journal.close(); }
  };
  return { db, args, editJournal };
}

test('connection initialization constrains both normal transactions and fanout to one shard', (t) => {
  const { db, args } = fixture(t);
  assert.equal(profile.derivedSearch, 'unavailable');
  assert.equal(profile.sequenceAllocation, 'standalone');
  assert.equal(profile.initializeConnection, initializeConnection);
  initializeConnection(args);
  assert.deepEqual(db.effects, ['RESET __neki.shard', "SET __neki.tx_mode = 'single'", "SET __neki.fanout = 'single'"]);
});

test('connection initialization refuses transactions and rechecks custody before each setting', (t) => {
  const { db, args } = fixture(t);
  db.isTransaction = true;
  assert.throws(() => initializeConnection(args), /autocommit/);
  assert.deepEqual(db.effects, []);
  db.isTransaction = false;
  assert.throws(() => initializeConnection({ ...args, assertCurrent() { if (db.effects.length) throw new Error('custody revoked'); } }), /custody revoked/);
  assert.deepEqual(db.effects, ['RESET __neki.shard']);
});

test('connection initialization requires a valid runtime shard UID before remote effects', (t) => {
  const { db, args } = fixture(t);
  delete process.env.NEKI_RUNTIME_SHARD_UID;
  assert.throws(() => initializeConnection(args), /NEKI_RUNTIME_SHARD_UID must be a Neki shard UID/);
  for (const invalid of ['', 'sh', 'shUPPER', 'sh_has_separator', 'sh123\' /* injected */', 'other123', 'sh123\n']) {
    process.env.NEKI_RUNTIME_SHARD_UID = invalid;
    assert.throws(() => initializeConnection(args), /NEKI_RUNTIME_SHARD_UID/);
  }
  assert.deepEqual(db.effects, []);
});

test('runtime activation pins the captured shard and verifies qualified native identity', (t) => {
  const { db, args } = fixture(t);
  initializeConnection(args);
  db.native = { store_id: args.storeId, version: BigInt(args.version) };
  assert.equal(profile.activateRuntime, activateRuntime);
  activateRuntime(args);
  assert.equal(db.effects.at(-1), "SET __neki.shard = 'shfixture123'");
  assert.equal(db.metadataReadSql, 'SELECT store, version, store_id FROM "qualification".openclaw_schema_meta WHERE store = ?');
});

test('runtime activation uses immutable captured UID after environment changes', (t) => {
  const { db, args } = fixture(t);
  initializeConnection(args);
  db.native = { store_id: args.storeId, version: args.version };
  process.env.NEKI_RUNTIME_SHARD_UID = 'shdifferent456';
  activateRuntime(args);
  assert.equal(db.effects.at(-1), "SET __neki.shard = 'shfixture123'");
  const effects = db.effects.length;
  assert.throws(() => initializeConnection(args), /runtime shard binding is immutable/);
  assert.equal(db.effects.length, effects);
});

test('reinitializing a pooled connection resets prior runtime targeting before bootstrap', (t) => {
  const { db, args } = fixture(t);
  initializeConnection(args);
  db.native = { store_id: args.storeId, version: args.version };
  activateRuntime(args);
  db.effects.length = 0;
  initializeConnection(args);
  assert.deepEqual(db.effects, ['RESET __neki.shard', "SET __neki.tx_mode = 'single'", "SET __neki.fanout = 'single'"]);
});

test('runtime activation refuses uninitialized connections and mismatched target metadata', (t) => {
  const { db, args } = fixture(t);
  assert.throws(() => activateRuntime(args), /runtime connection was not initialized/);
  assert.deepEqual(db.effects, []);
  initializeConnection(args);
  for (const native of [undefined, { store: 'other-store', store_id: args.storeId, version: args.version }, { store_id: 'other-anchor', version: args.version }, { store_id: args.storeId, version: args.version - 1 }]) {
    db.native = native;
    assert.throws(() => activateRuntime(args), /runtime shard does not own the admitted native store/);
  }
});

test('runtime activation requires autocommit and current custody before pin and target proof', (t) => {
  const { db, args } = fixture(t);
  initializeConnection(args);
  const effects = db.effects.length;
  db.isTransaction = true;
  assert.throws(() => activateRuntime(args), /autocommit/);
  db.isTransaction = false;
  assert.throws(() => activateRuntime({ ...args, assertCurrent() { throw new Error('custody revoked'); } }), /custody revoked/);
  assert.equal(db.effects.length, effects);
  assert.throws(() => activateRuntime({ ...args, assertCurrent() { if (db.effects.length > effects) throw new Error('custody revoked before proof'); } }), /custody revoked before proof/);
  assert.equal(db.metadataReadSql, undefined);
});

test('versioned synchronous provider bootstraps in autocommit and preserves exact core statements', (t) => {
  const { db, args, editJournal } = fixture(t);
  assert.equal(profile.version, 1);
  assert.deepEqual(prepare(args), { fresh: true });
  assert.deepEqual(db.effects, ['CREATE SCHEMA "qualification"', metadataSql, 'CREATE TABLE sample (id integer PRIMARY KEY)', 'CREATE INDEX sample_id ON sample (id)']);
  editJournal((journal) => assert.deepEqual(journal.prepare('SELECT state FROM steps ORDER BY position').all().map((row) => row.state), ['done', 'done', 'done', 'done']));
  const effects = db.effects.length;
  assert.deepEqual(prepare(args), { fresh: true });
  assert.equal(db.effects.length, effects, 'complete active receipt allows independent core validation/seal retry');
});

test('matching native metadata reopens without remote effects or custody journal', (t) => {
  const { db, args } = fixture(t);
  db.namespace = db.metadata = true;
  db.native = { store_id: args.storeId, version: 17n };
  assert.deepEqual(prepare({ ...args, allowCreate: false }), { fresh: false });
  assert.deepEqual(db.effects, []);
});

test('existing anchor cannot silently recreate missing remote storage without custody receipts', (t) => {
  const { db, args } = fixture(t);
  for (const allowCreate of [undefined, false, 'true']) {
    assert.throws(() => prepare({ ...args, allowCreate }), /new bootstrap requires a newly created anchor and allowCreate/);
    assert.equal(existsSync(args.journalPath), false);
  }
  assert.deepEqual(db.effects, []);
});

test('existing empty journal cannot authorize initialization even with a newly created anchor', (t) => {
  const { db, args } = fixture(t);
  writeFileSync(args.journalPath, '', { mode: 0o600 });
  assert.throws(() => prepare(args), /empty or truncated journal cannot establish namespace custody/);
  assert.deepEqual(db.effects, []);
});

test('intact queued journal can resume before namespace creation without minting another anchor', (t) => {
  const { db, args, editJournal } = fixture(t);
  args.assertCurrent = () => {
    if (!existsSync(args.journalPath)) return;
    editJournal((journal) => {
      if (journal.prepare("SELECT name FROM sqlite_master WHERE name = 'steps'").get()) throw new Error('cancel before remote effect');
    });
  };
  assert.throws(() => prepare(args), /cancel before remote effect/);
  assert.equal(db.namespace, false);
  assert.deepEqual(db.effects, []);
  assert.deepEqual(prepare({ ...args, allowCreate: false, assertCurrent() {} }), { fresh: true });
});

test('native identity mismatch and migrations fail closed', (t) => {
  const { db, args } = fixture(t);
  db.namespace = db.metadata = true;
  db.native = { store_id: 'other-store', version: 17 };
  assert.throws(() => prepare(args), /native store identity or version differs/);
  db.native = { store_id: args.storeId, version: 16 };
  assert.throws(() => prepare(args), /migrations are unsupported/);
  assert.deepEqual(db.effects, []);
});

test('preexisting unsealed namespace cannot be adopted', (t) => {
  const { db, args } = fixture(t);
  db.namespace = true;
  assert.throws(() => prepare(args), /no local custody journal/);
  assert.deepEqual(db.effects, []);
});

test('remote failure remains pending and restart refuses duplicate or unknown outcome', (t) => {
  const { db, args, editJournal } = fixture(t);
  db.onExec = (sql) => { if (sql.startsWith('CREATE TABLE sample')) throw new Error('lost receipt'); };
  assert.throws(() => prepare(args), /lost receipt/);
  const effects = db.effects.length;
  editJournal((journal) => assert.equal(journal.prepare('SELECT state FROM steps WHERE position = 2').get().state, 'pending'));
  db.onExec = undefined;
  assert.throws(() => prepare(args), /ambiguous pending DDL/);
  assert.equal(db.effects.length, effects);
});

test('restart resumes known completed prefix and queued suffix after custody cancellation', (t) => {
  const { db, args } = fixture(t);
  let checksAfterSchema = 0;
  args.assertCurrent = () => {
    if (db.effects.length === 1 && ++checksAfterSchema === 2) throw new Error('custody expired');
  };
  assert.throws(() => prepare(args), /custody expired/);
  assert.equal(db.effects.length, 1);
  args.assertCurrent = () => {};
  assert.deepEqual(prepare(args), { fresh: true });
  assert.equal(db.effects.filter((sql) => sql.startsWith('CREATE SCHEMA')).length, 1);
});

test('changed recipe or namespace identity cannot reuse a journal', (t) => {
  const { db, args } = fixture(t);
  prepare(args);
  const effects = db.effects.length;
  assert.throws(() => prepare({ ...args, ddl: `${ddl}; CREATE TABLE another (id integer)` }), /journal identity or full recipe does not match/);
  assert.throws(() => prepare({ ...args, storeId: 'different' }), /journal identity or full recipe does not match/);
  assert.equal(db.effects.length, effects);
});

test('missing and altered completed receipts fail closed', (t) => {
  const { db, args, editJournal } = fixture(t);
  prepare(args);
  const effects = db.effects.length;
  editJournal((journal) => journal.prepare("UPDATE steps SET sql_hash = 'changed' WHERE position = 1").run());
  assert.throws(() => prepare(args), /step recipe does not match/);
  editJournal((journal) => journal.prepare('DELETE FROM steps WHERE position = 1').run());
  assert.throws(() => prepare(args), /missing or extra step receipts/);
  assert.equal(db.effects.length, effects);
});

test('gaps and sealed journals do not authorize reseeding an unsealed namespace', (t) => {
  const { args, editJournal } = fixture(t);
  prepare(args);
  editJournal((journal) => journal.prepare("UPDATE steps SET state = 'queued' WHERE position = 1").run());
  assert.throws(() => prepare(args), /gap in completed step receipts/);
  editJournal((journal) => journal.prepare("UPDATE manifest SET state = 'sealed'").run());
  assert.throws(() => prepare(args), /sealed journal has no native metadata/);
});

test('disappeared namespace cannot replay completed effects from the old journal', (t) => {
  const { db, args } = fixture(t);
  prepare(args);
  db.namespace = db.metadata = false;
  assert.throws(() => prepare(args), /namespace disappeared/);
});

test('catalog lookup errors propagate without assuming an absent metadata table', (t) => {
  const { db, args } = fixture(t);
  db.namespace = true;
  const original = db.prepare;
  db.prepare = (sql) => {
    if (sql.includes('to_regclass')) throw new Error('catalog unavailable');
    return original.call(db, sql);
  };
  assert.throws(() => prepare(args), /catalog unavailable/);
  assert.deepEqual(db.effects, []);
});

test('transactions, stale custody, and transaction-control recipes reject before effects', (t) => {
  const { db, args } = fixture(t);
  db.isTransaction = true;
  assert.throws(() => prepare(args), /autocommit/);
  db.isTransaction = false;
  assert.throws(() => prepare({ ...args, assertCurrent() { throw new Error('stale custody'); } }), /stale custody/);
  for (const control of ['BEGIN', '/* outer /* nested */ comment */ START TRANSACTION', '-- prelude\nCOMMIT', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'SAVEPOINT one']) {
    assert.throws(() => executeFreshDdl({ ...args, ddl: `${ddl}; ${control}` }), /transaction control/);
  }
  assert.deepEqual(db.effects, []);
});

test('scratch executor keeps function transaction words intact and checks custody before each effect', (t) => {
  const { db, args } = fixture(t);
  const functionSql = 'CREATE FUNCTION sample() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN PERFORM 1; END; $body$';
  executeFreshDdl({ ...args, ddl: `${functionSql}; CREATE TABLE trailing (id integer)` });
  assert.deepEqual(db.effects, [functionSql, 'CREATE TABLE trailing (id integer)']);
  db.effects.length = 0;
  assert.throws(() => executeFreshDdl({ ...args, ddl, assertCurrent() { if (db.effects.length) throw new Error('custody revoked'); } }), /custody revoked/);
  assert.equal(db.effects.length, 1);
});

test('each remote effect has a durable pending receipt before execution', (t) => {
  const { db, args, editJournal } = fixture(t);
  db.onExec = () => editJournal((journal) => {
    const rows = journal.prepare('SELECT position, state FROM steps ORDER BY position').all();
    assert.equal(rows[db.effects.length - 1].state, 'pending');
    assert.ok(rows.slice(0, db.effects.length - 1).every((row) => row.state === 'done'));
    assert.ok(rows.slice(db.effects.length).every((row) => row.state === 'queued'));
  });
  prepare(args);
});

test('custody revocation after remote success leaves an ambiguous receipt rather than authorizing replay', (t) => {
  const { db, args, editJournal } = fixture(t);
  args.assertCurrent = () => { if (db.effects.length) throw new Error('revoked after remote effect'); };
  assert.throws(() => prepare(args), /revoked after remote effect/);
  editJournal((journal) => assert.equal(journal.prepare('SELECT state FROM steps WHERE position = 0').get().state, 'pending'));
  args.assertCurrent = () => {};
  assert.throws(() => prepare(args), /ambiguous pending DDL/);
  assert.equal(db.effects.length, 1);
});

test('truncated journal schema cannot establish custody over an existing namespace', (t) => {
  const { db, args, editJournal } = fixture(t);
  prepare(args);
  editJournal((journal) => journal.exec('DROP TABLE steps'));
  const effects = db.effects.length;
  assert.throws(() => prepare(args), /unrecognized or truncated journal/);
  assert.equal(db.effects.length, effects);
});

test('seal callbacks durably record intent and confirmed completion without remote effects', (t) => {
  const { db, args, editJournal } = fixture(t);
  prepare(args);
  const effects = db.effects.length;
  assert.equal(profile.beforeSeal, beforeSeal);
  assert.equal(profile.afterSeal, afterSeal);
  beforeSeal(args);
  editJournal((journal) => assert.equal(journal.prepare('SELECT state FROM manifest').get().state, 'sealing'));
  db.native = { store_id: args.storeId, version: args.version };
  afterSeal(args);
  editJournal((journal) => assert.equal(journal.prepare('SELECT state FROM manifest').get().state, 'sealed'));
  assert.deepEqual(prepare(args), { fresh: false });
  assert.equal(db.effects.length, effects);
});

test('interrupted native sealing requires manual recovery rather than duplicate seed admission', (t) => {
  const { db, args } = fixture(t);
  prepare(args);
  beforeSeal(args);
  const effects = db.effects.length;
  assert.throws(() => prepare(args), /sealing journal has no native metadata; manual recovery required/);
  assert.throws(() => beforeSeal(args), /sealing journal/);
  assert.equal(db.effects.length, effects);
});

test('confirmed native commit can reopen even if afterSeal callback was lost', (t) => {
  const { db, args } = fixture(t);
  prepare(args);
  beforeSeal(args);
  db.native = { store_id: args.storeId, version: args.version };
  assert.deepEqual(prepare(args), { fresh: false });
});

test('lost native metadata cannot reuse a sealed local receipt', (t) => {
  const { db, args } = fixture(t);
  prepare(args);
  beforeSeal(args);
  db.native = { store_id: args.storeId, version: args.version };
  afterSeal(args);
  db.native = undefined;
  const effects = db.effects.length;
  assert.throws(() => prepare(args), /sealed journal has no native metadata; manual recovery required/);
  assert.equal(db.effects.length, effects);
});

test('seal callbacks refuse wrong identities, altered recipes, missing receipts, and wrong phases', (t) => {
  const { db, args, editJournal } = fixture(t);
  prepare(args);
  assert.throws(() => afterSeal(args), /journal must be sealing/);
  assert.throws(() => beforeSeal({ ...args, storeId: 'other-anchor' }), /identity or full recipe does not match/);
  assert.throws(() => beforeSeal({ ...args, ddl: `${ddl}; CREATE TABLE extra (id integer)` }), /identity or full recipe does not match/);
  beforeSeal(args);
  assert.throws(() => afterSeal({ ...args, storeId: 'other-anchor' }), /identity or full recipe does not match/);
  editJournal((journal) => journal.prepare('DELETE FROM steps WHERE position = 2').run());
  assert.throws(() => afterSeal(args), /missing or extra step receipts/);
  editJournal((journal) => assert.equal(journal.prepare('SELECT state FROM manifest').get().state, 'sealing'));
  assert.equal(db.effects.length, 4);
});

test('seal transition requires every completed receipt and current custody', (t) => {
  const { args, editJournal } = fixture(t);
  prepare(args);
  editJournal((journal) => journal.prepare("UPDATE steps SET state = 'queued' WHERE position = 3").run());
  assert.throws(() => beforeSeal(args), /all DDL receipts must be done/);
  editJournal((journal) => journal.prepare("UPDATE steps SET state = 'done' WHERE position = 3").run());
  let checks = 0;
  assert.throws(() => beforeSeal({ ...args, assertCurrent() { if (++checks === 4) throw new Error('custody revoked before transition'); } }), /custody revoked/);
  editJournal((journal) => assert.equal(journal.prepare('SELECT state FROM manifest').get().state, 'active'));
});
