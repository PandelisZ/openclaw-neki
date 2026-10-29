#!/usr/bin/env node
import { connectionFromEnv, errorCode } from '../src/connection.mjs';
import { probeNeki } from '../src/probe.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log('Usage: openclaw-neki probe [--write-probes]\nReads NEKI_DATABASE_URL from the environment. Exit 2 means native support is unproven.');
} else if (args[0] !== 'probe' || args.slice(1).some(arg => arg !== '--write-probes')) {
  console.error('Unknown command or option. Run openclaw-neki --help.');
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await probeNeki(connectionFromEnv(), { writeProbes: args.includes('--write-probes') }), null, 2));
    process.exitCode = 2;
  } catch (error) {
    console.error(`Neki probe failed (${errorCode(error)}). Check NEKI_DATABASE_URL and database availability.`);
    process.exitCode = 1;
  }
}
