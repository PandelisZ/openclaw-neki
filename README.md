# OpenClaw + PlanetScale Neki

Experimental OpenClaw extension for native agent storage on **one PlanetScale Neki shard**.

The repository includes the extension, a version-pinned host patch, capability probes, recovery tests, and a real Gateway qualification harness. **Stock OpenClaw does not expose the required storage lifecycle hooks. This requires the included host patch and is not production-ready.**

The verified milestone is native agent data on Neki with local SQLite shared state: an isolated Gateway completed a real model turn, stopped, restarted in a new process, retrieved the saved assistant reply, and completed a second model turn recalling the original context. See [verification](docs/verification.md) for the evidence and limits.

## Design

- Bootstrap uses routed autocommit DDL with durable receipts for every effect. Unknown outcomes stop initialization for manual recovery.
- OpenClaw retains native identities, catalog verification, initial-row transactions, ownership checks, and schema sealing.
- After admission, runtime data queries target an explicitly configured shard and verify that shard's native store identity. Runtime transactions remain intact.
- Sequence allocation runs separately inside the caller's transaction where Neki cannot forward sequence functions with table access.
- Derived full-text/vector search, migrations, database porting, multi-shard use, and topology changes are unsupported. Canonical conversation content remains in native tables.

## Try it

Use a dedicated test database with one shard, a DDL-capable role, and a fresh OpenClaw state directory. Keep credentials in environment variables.

```sh
mise trust
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm test
mise exec -- node scripts/apply-host-patch.mjs /absolute/path/to/pinned/openclaw
```

The patch applies only to upstream commit `d7349d9395e2bde0f42882a9f7ef8afab59e19c3`. It checks the original file hashes and refuses a different or modified base. Install the host's dependencies using its own instructions.

Configure `NEKI_DATABASE_URL`, `NEKI_RUNTIME_SHARD_UID`, and an isolated instance as described in [host integration](docs/host-integration.md). The shard UID is the provider's SQL shard name, not its API resource ID. Obtain and confirm it through your authorized administrative tooling; the extension does not guess or create it.

For an opt-in live test, also supply `OPENAI_API_KEY`, `OPENCLAW_SOURCE_DIR` pointing to that patched checkout, and `NEKI_SINGLE_SHARD=1` after confirming topology:

```sh
mise exec -- pnpm test:live
```

This creates disposable schemas, makes paid model requests, stops the Gateway process, restarts it, checks the saved assistant reply, and asks the model to recall a synthetic marker. It drops its schemas afterward and retains private local evidence for inspection. Missing credentials or a failed assistant turn cannot count as a pass.

`pnpm probe --write-probes` runs smaller compatibility probes. It deliberately exits 2 because those probes cannot establish conversation readiness.

## Background

[Issue research](docs/issues.md) records the original snapshot, transactional DDL, and search-configuration failures. No upstream report has been posted. The host patch is an experimental proposal, not released upstream functionality.

Keep private logs, database/account identifiers, configuration, and credentials out of this repository. Existing application deployments and data are outside this experiment's scope.
