# Verification

Observed on 2026-10-28 against OpenClaw `d7349d9395e2bde0f42882a9f7ef8afab59e19c3`, Node.js 26.12.1, and a dedicated existing Neki test database whose administrative API reported one ready authoritative shard. No credentials, topology, existing application configuration, or production data were changed.

| Check | Observed outcome |
| --- | --- |
| Package recovery/parser/connection tests | 39 passed; rerun with `mise exec -- pnpm test` |
| Host configuration/lifecycle selection and transcript allocation tests | 18 passed |
| Scoped host typecheck, including upstream declaration files | Passed |
| Original generated base agent DDL | 136 autocommit statements succeeded |
| Native agent opening with core identity/catalog admission | Passed on real Neki |
| Gateway process restart and assistant history retrieval | Passed; exact persisted assistant reply required |
| Real model turn through normal routed runtime | Failed: native transcript multi-write CTE rejected with SQLSTATE `XX000`, `logical.OutputClauses` |
| Direct targeted multi-write CTE with default identity allocation | Passed in a minimized reproduction |
| Direct target with `nextval` and table access combined | Rejected with `0A000`; standalone sequence allocation succeeded |
| Final native assistant reply | Passed; exact successful reply independently found in Neki native transcript content (schema version 38) |
| Separate-process restart and model recall | Passed; second real assistant reply exactly recalled the original synthetic marker |
| Shutdown and disposable schema cleanup | Both Gateway processes stopped cleanly; owned schemas removed and absence verified |

The strict live harness completed successfully with `openai/gpt-4.1-mini`. Its report recorded `nativeConversation=true`, `restartHistory=true`, `modelContextAfterProcessRestart=true`, and `cleanup=complete`. An independent PostgreSQL read between turns found the exact first assistant reply in Neki, outside the Gateway process.

The committed live harness requires a successful status and exact non-error assistant text. On restart it requires the saved **assistant** message, then a second assistant reply recalling a marker absent from that second request. Marker text in a request echo, input history, system report, or error payload is insufficient.

Earlier investigation results remain reproducible capability limits: routed snapshot export `NK013 [200]`, dependent trigger DDL within a transaction `NK013 [817]`, custom text-search configuration DDL `NK013 [302]`, and absent `__neki.wait_for_ddl()` (`42883`). The extension explicitly avoids or rejects those paths; it does not claim Neki implements them.

The broad upstream typecheck was stopped due to memory pressure. The successful bounded check covered changed host entry points and their imported source graph with upstream declarations included. No full upstream test suite, packaged build, Bun runtime, migration, port, backup restore, failover, multi-shard, or production qualification is claimed.

Private raw operational evidence remains outside Git. The public harness creates its own evidence directory and prints a compact outcome report. A failed or skipped live check is never reported as a working backend.
