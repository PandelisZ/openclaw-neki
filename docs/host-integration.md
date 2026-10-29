# Experimental host integration

This repository contains a Neki schema lifecycle extension and a version-pinned OpenClaw host patch. Stock OpenClaw cannot install a replacement for native conversation storage through its current plugin API. The patch adds an early, worker-compatible lifecycle capability; it is not an upstream release.

## First milestone

- One approved Neki shard. Bootstrap uses `__neki.tx_mode = 'single'` and `__neki.fanout = 'single'`; admitted runtime data queries pin that shard explicitly.
- Native agent data on Neki. Shared state and safety stores stay on SQLite.
- Fresh agent stores only. Existing sealed stores reopen with core identity/catalog checks.
- Canonical conversation content remains in the native agent schema. Derived full-text and vector search are unavailable and return a capability error. Memory search must remain disabled (`plugins.slots.memory = "none"`).
- No database porting or schema upgrades. The host rejects those paths for this profile.
- Node.js 26.12.1 is the tested runtime. Bun has not been qualified.

This milestone does not support distributing a conversation across shards, changing shard topology underneath a running instance, or claiming equivalent search behavior. Normal data transactions, rollback, savepoints, owner checks, and metadata sealing stay with OpenClaw.

## How initialization works

OpenClaw resolves the explicitly enabled plugin's `postgresSchemaLifecycle` manifest artifact before selecting database workers. The descriptor contains only a vetted module location and root boundary. Workers load the dedicated built JavaScript artifact, without loading the ordinary plugin registry during store opening.

For a freshly minted native identity anchor, the extension records an immutable DDL recipe and every step in an owner-only SQLite journal adjacent to the anchor. Each remote DDL effect has a durable pending receipt before execution and a completed receipt afterward. It does not rewrite SQL or strip runtime transactions.

After core admits the seal and catalog, the extension sets the captured `NEKI_RUNTIME_SHARD_UID` and rechecks the target's native store identity. Bootstrap resets a reused connection's target before routed DDL. The host's explicit standalone-sequence capability allocates transcript IDs inside the existing transaction, then binds them into the native multi-write CTE structure. A router-managed `nextval` cannot be combined with table access on a direct connection. See [Neki shard targeting](https://planetscale.com/docs/neki/shard-targeting-fanout).

Core independently builds a scratch schema from its generated DDL and compares the complete catalogs before admitting the result. The extension records `sealing` before core begins the native metadata/initial-row transaction, then `sealed` after a confirmed commit. Core owns the schema seal, application identity, initial rows, and native transaction.

Unknown DDL outcomes and interrupted sealing require manual recovery. They are refused rather than replayed or treated as completed. An already sealed native store can reopen after a lost local completion callback because core verifies its authoritative identity and catalog. A missing namespace with an existing anchor cannot silently recreate storage without its matching preparation receipts.

## Configuration for a disposable test instance

Use the exact upstream commit recorded in `patches/host.json` in a separate, task-owned checkout. Install its dependencies using upstream instructions, apply the patch with `scripts/apply-host-patch.mjs`, and install this package's dependencies with `mise exec -- pnpm install --frozen-lockfile`.

The configured Neki role needs DDL permissions in the test database. Supply the connection as `NEKI_DATABASE_URL` and the approved SQL shard UID as `NEKI_RUNTIME_SHARD_UID`; do not put credentials or provider identifiers in committed configuration. Use a fresh, isolated OpenClaw state directory and workspace. The extension does not create databases, provision paid infrastructure, alter credentials, or change topology. Selecting a shard UID is an operator decision; `NEKI_SINGLE_SHARD=1` acknowledges it for the harness and does not inspect physical topology.

```json
{
  "database": {
    "engine": "sqlite",
    "families": { "agent": { "engine": "postgres" } },
    "postgres": {
      "connection": { "source": "env", "provider": "default", "id": "NEKI_DATABASE_URL" },
      "schemaPrefix": "neki_experiment",
      "schemaLifecycleProvider": "neki"
    }
  },
  "plugins": {
    "load": { "paths": ["/absolute/path/to/openclaw-neki"] },
    "slots": { "memory": "none" },
    "entries": { "neki": { "enabled": true } }
  }
}
```

Run upstream's normal OpenClaw command from its checkout. A new schema takes substantially longer to initialize because both the destination and independent scratch schema execute real DDL. Keep the Gateway's state directory, native anchors, and preparation journals together. Never delete or edit a journal to bypass a refusal.

## Qualification

`pnpm test` exercises recipe/identity custody, interrupted effects, sealing, and parsing. `pnpm probe --write-probes` tests selected capabilities in a fresh disposable schema; it always reports native readiness as unproven and exits 2. Those checks alone cannot establish a working conversation backend.

The live native test must start the patched Gateway, complete a real model turn, shut it down, restart with the same state, read the saved history, and complete a second turn using context from the first. Record bootstrap, model, restart and cleanup outcomes separately. See `verification.md` for observed results and remaining gaps.

Run `mise exec -- pnpm test:live` with `OPENCLAW_SOURCE_DIR`, `NEKI_DATABASE_URL`, `NEKI_RUNTIME_SHARD_UID`, `NEKI_SINGLE_SHARD=1`, and `OPENAI_API_KEY` supplied through your environment. The default model is `openai/gpt-4.1-mini`; `NEKI_PROOF_MODEL` can select another available model. The harness verifies patched file hashes before starting, uses a fresh owner-only temporary state directory and random schema prefix, joins its child processes, and verifies schema cleanup. It keeps raw Gateway logs and responses in that private directory, never in source control. Review those files locally before sharing evidence.

## Upstream direction

The patch is a prototype of a generic pre-boot schema lifecycle capability. Further work needs upstream review of the early loading boundary, authority propagation, migration and port receipts, optional search capabilities, and backup/recovery. Do not present this package as stock-host support or publish an upstream issue/PR without the user's authorization.
