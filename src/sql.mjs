/** Split SQL without cutting function bodies, quoted values or nested comments. */
export function splitSqlStatements(sql) {
  const result = [];
  let start = 0;
  let quote;
  let dollar;
  let commentDepth = 0;
  let lineComment = false;
  let escapedString = false;
  let content = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
    } else if (commentDepth) {
      if (c === '/' && next === '*') { commentDepth++; i++; }
      else if (c === '*' && next === '/') { commentDepth--; i++; }
    } else if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = undefined; }
    } else if (quote) {
      if (escapedString && c === '\\') i++;
      else if (c === quote) {
        if (next === quote) i++;
        else quote = undefined;
      }
    } else if (c === '-' && next === '-') { lineComment = true; i++; }
    else if (c === '/' && next === '*') { commentDepth = 1; i++; }
    else if (c === '"' || c === "'") {
      content = true;
      quote = c;
      escapedString = c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[a-zA-Z0-9_$]/.test(sql[i - 2] ?? '');
    } else if (c === '$' && !/[a-zA-Z0-9_$]/.test(sql[i - 1] ?? '')) {
      content = true;
      const match = /^(\$[a-zA-Z_][a-zA-Z0-9_]*\$|\$\$)/.exec(sql.slice(i));
      if (match) { dollar = match[0]; i += dollar.length - 1; }
    } else if (c === ';') {
      const statement = sql.slice(start, i).trim();
      if (content) result.push(statement);
      content = false;
      start = i + 1;
    } else if (!/\s/.test(c)) { content = true; }
  }
  if (quote || dollar || commentDepth) throw new Error('Unterminated SQL quote or block comment');
  const tail = sql.slice(start).trim();
  if (content) result.push(tail);
  return result;
}


export function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid SQL identifier');
  return `"${value.replaceAll('"', '""')}"`;
}
