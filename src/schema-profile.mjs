import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { quoteIdentifier, splitSqlStatements } from './sql.mjs';

const JOURNAL_VERSION = 1;
const runtimeShards = new WeakMap();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const refuse = (message) => { throw new Error(`Neki schema preparation refused: ${message}`); };

// Only top-level transaction controls are forbidden. Function bodies and literal
// strings are deliberately left intact: this provider never rewrites core SQL.
function statements(sql) {
  if (typeof sql !== 'string' || !sql.trim()) refuse('an audited DDL recipe is required');
  const result = splitSqlStatements(sql);
  if (!result.length) refuse('an audited DDL recipe is required');
  for (const statement of result) {
    let head = statement;
    while (/^\s*(?:--|\/\*)/.test(head)) {
      head = head.trimStart();
      if (head.startsWith('--')) { head = head.slice(head.indexOf('\n') + 1); continue; }
      let depth = 1;
      let i = 2;
      for (; i < head.length && depth; i++) {
        if (head.slice(i, i + 2) === '/*') { depth++; i++; }
        else if (head.slice(i, i + 2) === '*/') { depth--; i++; }
      }
      head = head.slice(i);
    }
    if (/^\s*(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|END\b|ROLLBACK\b|ABORT\b|SAVEPOINT\b|RELEASE\b|PREPARE\s+TRANSACTION\b|SET\s+(?:(?:LOCAL|SESSION)\s+)?TRANSACTION\b|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\b)/i.test(head)) {
      refuse('transaction control in bootstrap DDL');
    }
  }
  return result;
}

function assertAutocommit(db, assertCurrent) {
  if (typeof assertCurrent !== 'function') refuse('assertCurrent is required');
  assertCurrent();
  if (db.isTransaction) refuse('bootstrap requires an autocommit connection');
}

/** Bootstrap through the router; runtime targeting follows native admission. */
export function initializeConnection({ db, assertCurrent }) {
  assertAutocommit(db, assertCurrent);
  const shard = process.env.NEKI_RUNTIME_SHARD_UID;
  if (typeof shard !== 'string' || !/^sh[a-z0-9]+$/.test(shard)) refuse('NEKI_RUNTIME_SHARD_UID must be a Neki shard UID');
  if (runtimeShards.has(db) && runtimeShards.get(db) !== shard) refuse('connection runtime shard binding is immutable');
  for (const sql of ['RESET __neki.shard', "SET __neki.tx_mode = 'single'", "SET __neki.fanout = 'single'"]) {
    assertAutocommit(db, assertCurrent);
    db.exec(sql);
  }
  runtimeShards.set(db, shard);
}

/** Target runtime SQL only after the host admits the native seal and catalog. */
export function activateRuntime({ db, namespace, store, storeId, version, assertCurrent }) {
  assertAutocommit(db, assertCurrent);
  const namespaceSql = validateNativeIdentity({ namespace, store, storeId, version });
  const shard = runtimeShards.get(db);
  if (!shard) refuse('runtime connection was not initialized');
  assertAutocommit(db, assertCurrent);
  db.exec(`SET __neki.shard = '${shard}'`);
  assertAutocommit(db, assertCurrent);
  const row = db.prepare(`SELECT store, version, store_id FROM ${namespaceSql}.openclaw_schema_meta WHERE store = ?`).get(store);
  if (!row || row.store !== store || row.store_id !== storeId || String(row.version) !== String(version)) {
    refuse('runtime shard does not own the admitted native store');
  }
}

/** Execute audited core DDL in a caller-owned scratch namespace. No migrations. */
export function executeFreshDdl({ db, ddl, assertCurrent }) {
  const recipe = statements(ddl);
  assertAutocommit(db, assertCurrent);
  for (const sql of recipe) {
    assertAutocommit(db, assertCurrent);
    db.exec(sql);
  }
}

function openJournal(path, canCreate, assertCurrent) {
  if (typeof path !== 'string' || !path || path === ':memory:') refuse('a durable journalPath is required');
  let created = false;
  if (!existsSync(path)) {
    if (!canCreate) refuse('no local custody journal; new bootstrap requires a newly created anchor and allowCreate');
    assertCurrent();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, 'wx', 0o600)); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
    refuse('journal must be an owner-only regular file');
  }
  assertCurrent();
  const journal = new DatabaseSync(path);
  try {
    journal.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000');
    return { journal, created };
  } catch (error) { journal.close(); throw error; }
}

function initializeOrRead(journal, identity, recipe, canCreate, assertCurrent, expectedState = 'active') {
  const tables = journal.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  if (!tables.length) {
    if (!canCreate) refuse('empty or truncated journal cannot establish namespace custody');
    assertCurrent();
    journal.exec('BEGIN IMMEDIATE');
    try {
      journal.exec(`CREATE TABLE manifest (id INTEGER PRIMARY KEY CHECK (id = 1), format INTEGER NOT NULL, identity TEXT NOT NULL, recipe_hash TEXT NOT NULL, step_count INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'sealing', 'sealed')));
        CREATE TABLE steps (position INTEGER PRIMARY KEY, sql_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued', 'pending', 'done')))`);
      journal.prepare("INSERT INTO manifest VALUES (1, ?, ?, ?, ?, 'active')").run(JOURNAL_VERSION, identity, hash(JSON.stringify(recipe)), recipe.length);
      const insert = journal.prepare("INSERT INTO steps VALUES (?, ?, 'queued')");
      for (const [position, sql] of recipe.entries()) insert.run(position, hash(sql));
      journal.exec('COMMIT');
    } catch (error) { journal.exec('ROLLBACK'); throw error; }
  } else if (tables.join(',') !== 'manifest,steps') {
    refuse('unrecognized or truncated journal');
  }
  const manifestRows = journal.prepare('SELECT * FROM manifest').all();
  const manifest = manifestRows[0];
  if (manifestRows.length !== 1 || manifest.id !== 1 || manifest.format !== JOURNAL_VERSION || manifest.identity !== identity || manifest.recipe_hash !== hash(JSON.stringify(recipe)) || manifest.step_count !== recipe.length) {
    refuse('journal identity or full recipe does not match');
  }
  if (manifest.state !== expectedState) {
    if (expectedState === 'active' && ['sealing', 'sealed'].includes(manifest.state)) refuse(`${manifest.state} journal has no native metadata; manual recovery required`);
    refuse(`journal must be ${expectedState}; manual recovery required`);
  }
  const rows = journal.prepare('SELECT * FROM steps ORDER BY position').all();
  if (rows.length !== recipe.length) refuse('journal has missing or extra step receipts');
  let unfinished = false;
  for (const [position, row] of rows.entries()) {
    if (row.position !== position || row.sql_hash !== hash(recipe[position])) refuse('journal step recipe does not match');
    if (!['queued', 'pending', 'done'].includes(row.state)) refuse('invalid journal step state');
    if (row.state === 'pending') refuse('ambiguous pending DDL requires manual recovery');
    if (row.state === 'done' && unfinished) refuse('journal contains a gap in completed step receipts');
    if (row.state !== 'done') unfinished = true;
  }
  return rows;
}

function validateNativeIdentity({ namespace, store, storeId, version }) {
  const namespaceSql = quoteIdentifier(namespace);
  if (typeof store !== 'string' || !store || typeof storeId !== 'string' || !storeId || !Number.isSafeInteger(version) || version < 0) refuse('native store identity and version are required');
  return namespaceSql;
}

function recipeIdentity({ namespace, store, storeId, version, metadataSql, ddl }) {
  const namespaceSql = validateNativeIdentity({ namespace, store, storeId, version });
  return {
    namespaceSql,
    recipe: [`CREATE SCHEMA ${namespaceSql}`, ...statements(metadataSql), ...statements(ddl)],
    identity: JSON.stringify({ namespace, store, storeId, version }),
  };
}

function transitionSeal(input, from, to) {
  const { db, journalPath, assertCurrent } = input;
  assertAutocommit(db, assertCurrent);
  const { recipe, identity } = recipeIdentity(input);
  const { journal } = openJournal(journalPath, false, assertCurrent);
  try {
    assertCurrent();
    journal.exec('BEGIN IMMEDIATE');
    try {
      const rows = initializeOrRead(journal, identity, recipe, false, assertCurrent, from);
      if (rows.some((row) => row.state !== 'done')) refuse('all DDL receipts must be done before sealing');
      assertCurrent();
      const result = journal.prepare('UPDATE manifest SET state = ? WHERE id = 1 AND state = ?').run(to, from);
      if (result.changes !== 1) refuse('seal receipt was claimed by another preparer');
      journal.exec('COMMIT');
    } catch (error) { journal.exec('ROLLBACK'); throw error; }
  } finally { journal.close(); }
}

/** Persist seal intent before the core starts its native seed/seal transaction. */
export function beforeSeal(input) {
  transitionSeal(input, 'active', 'sealing');
}

/** Called only after the core has confirmed COMMIT of its native metadata seal. */
export function afterSeal(input) {
  transitionSeal(input, 'sealing', 'sealed');
}

/**
 * Experimental synchronous fresh-bootstrap adapter. The native core owns runtime
 * transactions, complete catalog comparison, initial rows, and metadata sealing.
 * A pending remote effect is intentionally not replayed: its outcome is unknown.
 */
export function prepare({ db, namespace, store, storeId, version, ddl, metadataSql, journalPath, assertCurrent, allowCreate = false }) {
  assertAutocommit(db, assertCurrent);
  const { namespaceSql, recipe, identity } = recipeIdentity({ namespace, store, storeId, version, ddl, metadataSql });
  const namespaceExists = Boolean(db.prepare('SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ?').get(namespace));
  if (namespaceExists) {
    const metadataExists = db.prepare('SELECT pg_catalog.to_regclass(?) AS relation').get(`${namespaceSql}."openclaw_schema_meta"`)?.relation != null;
    if (metadataExists) {
      const row = db.prepare(`SELECT version, store_id FROM ${namespaceSql}.openclaw_schema_meta WHERE store = ?`).get(store);
      if (row) {
        if (String(row.version) !== String(version) || row.store_id !== storeId) refuse('native store identity or version differs; migrations are unsupported');
        // A native seal is authoritative; the core independently verifies it and
        // the complete catalog before admitting runtime operations.
        return { fresh: false };
      }
    }
  }
  const { journal, created } = openJournal(journalPath, !namespaceExists && allowCreate === true, assertCurrent);
  try {
    const rows = initializeOrRead(journal, identity, recipe, created, assertCurrent);
    if (namespaceExists && rows[0].state !== 'done') refuse('namespace exists without a completed namespace receipt');
    if (!namespaceExists && rows.some((row) => row.state !== 'queued')) refuse('namespace disappeared after journaled effects');
    for (const [position, sql] of recipe.entries()) {
      if (rows[position].state === 'done') continue;
      assertAutocommit(db, assertCurrent);
      const claimed = journal.prepare("UPDATE steps SET state = 'pending' WHERE position = ? AND state = 'queued'").run(position);
      if (claimed.changes !== 1) refuse('step was claimed by another preparer');
      assertAutocommit(db, assertCurrent);
      db.exec(sql);
      assertCurrent();
      const completed = journal.prepare("UPDATE steps SET state = 'done' WHERE position = ? AND state = 'pending'").run(position);
      if (completed.changes !== 1) refuse('pending step receipt changed');
    }
    return { fresh: true };
  } finally { journal.close(); }
}

export default Object.freeze({ version: 1, derivedSearch: 'unavailable', sequenceAllocation: 'standalone', initializeConnection, activateRuntime, prepare, executeFreshDdl, beforeSeal, afterSeal });
