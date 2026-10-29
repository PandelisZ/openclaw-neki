import pg from 'pg';

export function connectionFromEnv(name = 'NEKI_DATABASE_URL', env = process.env) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid connection environment variable name');
  const value = env[name];
  if (!value) throw new Error(`Set ${name} to a dedicated Neki test connection`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must contain a PostgreSQL connection URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${name} must contain a PostgreSQL connection URL`);
  // Some existing operator URLs include a Rails adapter selector, not a libpq parameter.
  url.searchParams.delete('neki');
  // pg 8 treats require as verify-full today. Make that guarantee explicit.
  if (url.searchParams.get('sslmode') === 'require') url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

export function createClient(connectionString) {
  const client = new pg.Client({
    connectionString,
    application_name: 'openclaw-neki-qualification',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  });
  // Callers report a fixed failure and code; connection errors must never print the DSN.
  client.on('error', () => {});
  return client;
}

export function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN';
}

export async function inRollbackTransaction(client, operation) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try { return await operation(); }
  finally { await client.query('ROLLBACK'); }
}
