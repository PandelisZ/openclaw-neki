# Issue research

Searches refreshed on 2026-10-28:

- `Neki repo:openclaw/openclaw` in issues and pull requests: no matches.
- `"pg_export_snapshot" repo:openclaw/openclaw` in issues and pull requests: no matches.
- `"Neki" "OpenClaw"` in global issues: no matches.

These are bounded search results, not proof that no related report exists. OpenClaw's current main was also inspected at `386510139adaf2f7cef620de6f8ad4468fbd9294`; its database engine input still exposes only the built-in engines without a schema provider descriptor. The prototype is pinned to the original reproduced runtime, not that later commit.

Related work: [Rika-Labs/akter#487](https://github.com/Rika-Labs/akter/issues/487) and [its fix, PR #553](https://github.com/Rika-Labs/akter/pull/553). The fix uses autocommit DDL with durable step receipts and a propagation barrier, but explicitly says its real Neki tests were skipped. The current test cluster returned SQLSTATE `42883` for `__neki.wait_for_ddl()`, so this extension does not assume that function exists.

A potential upstream report should include only synthetic SQL and minimized errors:

1. Shared PostgreSQL state discovery requires `pg_export_snapshot()`, which the routed connection rejected with `NK013 [200]`.
2. Native agent bootstrap inside a transaction rejected the dependent trigger DDL with `NK013 [817]`. Splitting statements while retaining that transaction did not fix it.
3. Autocommit of the generated base agent schema succeeded, but native derived search setup then failed with `NK013 [302]` for `CREATE TEXT SEARCH CONFIGURATION`.
4. The native transcript multi-write CTE failed normal routed execution with `XX000`, `unhandled logical plan operator in cost estimation: *logical.OutputClauses`. Direct targeting executes ordinary multi-write CTEs, but a direct query combining `nextval` and table access returns `0A000`. A standalone sequence query succeeds. The experimental host exposes that allocation choice explicitly inside the existing native transaction.

Single-shard direct routing allowed snapshot export in a separate probe, but schema creation and text-search configuration DDL were rejected while a direct target was set. The alpha therefore uses normal routing for bootstrap and a verified, explicit shard target after native admission for runtime data. It is limited to the approved one-shard topology. See [documented shard targeting restrictions](https://planetscale.com/docs/neki/shard-targeting-fanout).

No upstream issue, comment or pull request has been posted.
