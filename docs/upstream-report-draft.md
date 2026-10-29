# PlanetScale Neki native agent storage — upstream proposal

Published as [OpenClaw feature request #187149](https://github.com/openclaw/openclaw/issues/187149) on 2026-10-28. The [implementation repository](https://github.com/PandelisZ/openclaw-neki) is public. This file retains the supporting research; the issue contains the submitted feature-request form.

## Working prototype and evidence

An experimental extension and version-pinned host patch are implemented in `PandelisZ/openclaw-neki`. The tested first milestone keeps shared state on SQLite and native agent data on one explicitly approved Neki shard. Stock OpenClaw requires the included patch.

A real isolated Gateway completed an assistant turn on Neki, stopped, restarted in a new OS process, retrieved the exact saved assistant reply, and completed a second model turn recalling a synthetic marker from the original context. An independent PostgreSQL read also found the first assistant reply in Neki. Both processes stopped cleanly, and disposable schemas were removed with absence verified.

Validation: 39 extension tests, 18 focused host tests, scoped host typecheck, touched-source lint/format, guarded patch application, and fresh independent review passed. The live test used Node.js 26.12.1 and `openai/gpt-4.1-mini`. Full upstream tests and a packaged build were not run.

This is limited to fresh stores and matching sealed-store reopen. Derived full-text/vector search, migrations, database porting, topology changes, multi-shard use, and production qualification remain unsupported.

Implementation and evidence:

- Implementation: https://github.com/PandelisZ/openclaw-neki
- Setup: https://github.com/PandelisZ/openclaw-neki/blob/master/docs/host-integration.md
- Verification: https://github.com/PandelisZ/openclaw-neki/blob/master/docs/verification.md

## Problem

On OpenClaw `d7349d9395e2bde0f42882a9f7ef8afab59e19c3`, native PostgreSQL agent initialization cannot complete through the tested PlanetScale Neki router. The public plugin API lets plugin-owned stores consume built-in adapters but does not let a provider customize native database bootstrap or advertise these missing capabilities.

Keep shared state on SQLite to avoid the separately unsupported routed `pg_export_snapshot()` path. Native agent bootstrap then fails because dependent DDL is planned before the router can see objects created earlier in the same transaction. Splitting statements without ending the transaction does not resolve that failure. Autocommit base DDL succeeds, but custom text-search configuration DDL is unsupported.

Minimized errors observed on a disposable test database:

```text
NK013 [200]: pg_export_snapshot unavailable in the evaluation engine
NK013 [817]: earlier DDL in this transaction is not reflected in router schema view
NK013 [302]: CREATE TEXT SEARCH CONFIGURATION unsupported by the router
42883: __neki.wait_for_ddl() does not exist
XX000: unhandled logical plan operator in cost estimation: *logical.OutputClauses
```

The last error arises in the native transcript multi-write CTE. Direct shard targeting avoids that planner path but rejects a query combining router-managed `nextval` with table access (`0A000`). A standalone sequence call and subsequent bound IDs work within the existing native transaction. This is constrained to an explicitly approved single shard.

## Reproduce safely

Use a dedicated Neki development database and a fresh OpenClaw state directory. No existing application's configuration or data is needed. Supply a connection through `NEKI_DATABASE_URL`, never an issue body or command argument.

The repository's `pnpm probe --write-probes` creates and cleans up a random schema for DDL, rollback, savepoint, and dependent-trigger checks. It prints capability codes and deliberately cannot report native conversation readiness. The pinned host's unmodified native agent path demonstrates the bootstrap/search failures. The included opt-in Gateway harness exercises the experimental path with real model replies and a separate-process restart.

## Proposed extension

A serialized, explicitly enabled, manifest-owned schema lifecycle artifact selected before database workers start. The host should preserve responsibility for identities, generated DDL, complete catalog comparison, seed rows, schema sealing, transaction boundaries, and custody. Providers need durable effect receipts for autocommit bootstrap and explicit unavailable search capabilities. Unknown effects must stop recovery rather than authorize replay.

The prototype includes that hook, a post-admission runtime connection hook, and standalone sequence allocation for opted-in transcript writers. It rejects migrations and database porting instead of claiming a v1 hook can safely implement them. The patch is pinned and experimental; upstream review is needed before treating this as an installation API or stable contract.

## Questions for upstream

- Would a generic pre-boot schema lifecycle capability fit the database engine boundary?
- How should unavailable derived search be represented while canonical content remains native?
- What migration, port, backup, and recovery receipts would be required before extending fresh-store support?

Related prior work is recorded in [issue research](issues.md); bounded searches found no exact OpenClaw/Neki issue or PR.
