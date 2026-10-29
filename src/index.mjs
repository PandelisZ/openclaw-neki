// Plain plugin definitions use the public OpenClaw plugin contract. No core imports.
export default {
  id: 'neki',
  name: 'PlanetScale Neki (experimental)',
  description: 'Experimental single-shard Neki schema lifecycle and compatibility diagnostics; requires the pinned host patch.',
  register(api) {
    api.registerCli(async ({ program }) => {
      program.command('neki')
        .description('Qualify PlanetScale Neki compatibility (experimental)')
        .command('probe')
        .description('Check capabilities; optionally use a disposable test schema')
        .option('--write-probes', 'Run DDL, rollback and trigger checks in a new disposable schema', false)
        .action(async (options) => {
          const [{ connectionFromEnv, errorCode }, { probeNeki }] = await Promise.all([
            import('./connection.mjs'), import('./probe.mjs'),
          ]);
          try {
            const report = await probeNeki(connectionFromEnv(api.pluginConfig?.connectionEnv), options);
            console.log(JSON.stringify(report, null, 2));
            process.exitCode = 2; // A capability probe is never native readiness evidence.
          } catch (error) {
            console.error(`Neki probe failed (${errorCode(error)}). Check the connection environment variable and database availability.`);
            process.exitCode = 1;
          }
        });
    }, {
      descriptors: [{ name: 'neki', description: 'Qualify PlanetScale Neki compatibility (experimental)', hasSubcommands: true }],
    });
  },
};
