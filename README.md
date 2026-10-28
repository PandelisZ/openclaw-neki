# OpenClaw + PlanetScale Neki

Research and compatibility work toward running OpenClaw's native conversation storage on PlanetScale Neki.

**Status: investigation. No working conversation backend or successful model conversation on Neki has been demonstrated. This repository does not yet contain a plugin implementation.**

## Starting evidence

The following findings come from a research handoff dated 2026-10-28, against upstream OpenClaw commit `d7349d9395e2bde0f42882a9f7ef8afab59e19c3`. Recheck them against current upstream before implementation.

- Native shared-state discovery calls `pg_export_snapshot()`. The recorded Neki error reports that this built-in function is unavailable in its evaluation engine.
- OpenClaw's supported mixed mode (`database.engine=postgres`, `database.families.state.engine=sqlite`) bypasses that snapshot path, but native agent initialization encounters Neki error `NK013`: queries cannot plan against a relation created earlier in the same transaction because the router schema view does not reflect that DDL.
- Schema initialization, bootstrap probes and database porting include DDL and queries in one transaction. No supported option to disable those transactions was found.
- Offline state porting to SQLite succeeded in the handoff's test, but both ported and fresh mixed-mode gateways still failed native agent bootstrap. That result does not establish conversation support.

## Extension boundary

The pinned source exposes only the built-in SQLite and PostgreSQL database engines. Its public plugin API did not expose a hook to replace core conversation storage, register a database adapter or change migration transaction behavior.

Storage-provider, external-import migration and configuration-migration APIs serve other purposes. A tool or archive plugin would not provide native conversation storage.

A viable approach needs an upstream extension point or improved Neki compatibility. Do not silently strip transaction boundaries or present a fork as an upstream-supported plugin.

## Research and implementation steps

1. Refresh issue and pull-request searches in OpenClaw and relevant PlanetScale trackers.
2. Inspect the related closed issue [Rika-Labs/akter#487](https://github.com/Rika-Labs/akter/issues/487) and its linked fix for Neki DDL handling, including `__neki.wait_for_ddl()`. Applicability to OpenClaw remains unverified.
3. Build a minimal reproduction with disposable test resources and no private configuration.
4. Assess a narrow boot-selected compatibility provider loaded before state discovery, with explicit snapshot and bootstrap/migration/port capabilities.
5. Preserve consistency, migration receipts, custody and recovery guarantees. Unsupported capabilities should fail closed.
6. Qualify any implementation with real Neki native readiness and a successful model conversation, including restart/recovery evidence. Unit tests and a running supervisor alone are insufficient.

The handoff's searches found no exact OpenClaw/Neki issue. This is a historical search result, not a current or exhaustive absence claim. Draft a minimal, secret-free upstream report before requesting authorization to post it.

## Isolation

Use dedicated development and test resources. Do not change any existing application's production configuration, deployments, tenants, database credentials, volumes or feature flags.

Keep private logs, provider account identifiers, database identifiers, credentials and raw operational evidence out of this repository. Document only minimized errors and reproducible, secret-free examples.
