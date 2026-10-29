import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSqlStatements, quoteIdentifier } from '../src/sql.mjs';

test('SQL functions, nested comments, quoted identifiers and escaped strings retain their bytes', () => {
  const statements = [
    '-- prelude ;\nCREATE TABLE "semi;colon" (value text)',
    "CREATE FUNCTION sample() RETURNS text LANGUAGE sql AS $body$ SELECT ';' /* ; */; $body$",
    "/* a /* b ; */ c */ INSERT INTO t VALUES ('a'';b', E'c\\\';d')",
  ];
  assert.deepEqual(splitSqlStatements(statements.join(';\n') + '; -- tail'), statements);
  assert.deepEqual(splitSqlStatements('SELECT value$tag$ FROM t; SELECT $1;'), ['SELECT value$tag$ FROM t', 'SELECT $1']);
});

test('incomplete SQL is refused before execution', () => {
  for (const sql of ["SELECT 'unclosed", 'SELECT $body$unclosed', 'SELECT "unclosed', '/* /* nested */']) {
    assert.throws(() => splitSqlStatements(sql), /Unterminated/);
  }
});

test('quoted identifiers preserve user names without injecting SQL', () => {
  assert.equal(quoteIdentifier('a";DROP TABLE t'), '"a"";DROP TABLE t"');
  assert.throws(() => quoteIdentifier('a\0b'), /Invalid/);
});

test('nested comment-only fragments do not become executable statements', () => {
  assert.deepEqual(splitSqlStatements('/* a /* b */ c */; -- tail'), []);
});
