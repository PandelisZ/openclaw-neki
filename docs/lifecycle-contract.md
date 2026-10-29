# Proposed lifecycle contract

This describes the existing experimental host patch for [OpenClaw #187149](https://github.com/openclaw/openclaw/issues/187149). It is a proposal for storage-owner review, not an accepted SDK contract. Neki behavior stays in the external extension; core keeps native storage ownership.

## Loading and authority

The operator explicitly enables a plugin and selects its `postgresSchemaLifecycle` artifact through `schemaLifecycleProvider`. Core reads manifest metadata before database workers start, validates the plugin root boundary and artifact identity, and passes a serializable descriptor to workers. The ordinary plugin registry does not execute during native store opening. The artifact must be built JavaScript.

The current scope is PostgreSQL agent stores with SQLite shared and safety stores. Core supplies the namespace, store ID, version, generated DDL, metadata DDL, persistent identity anchor, and live opening-custody assertion. The extension cannot mint a replacement native identity, change the core DDL, or treat successful preparation as storage admission.

| Operation | Extension responsibility | Core responsibility |
| --- | --- | --- |
| `initializeConnection` | Configure the borrowed connection for routed bootstrap; validate and capture its runtime shard | Open the built-in PostgreSQL connection under native admission |
| `prepare` | Execute the exact fresh DDL with durable receipts, or recognize matching native metadata | Mint identities, provide the recipe and creation authority, validate resulting storage |
| `executeFreshDdl` | Execute the same DDL in the caller-owned scratch namespace | Create/clean scratch storage and compare complete catalog fingerprints |
| `beforeSeal` | Durably record sealing intent after all preparation receipts complete | Retain live opening custody before the native transaction |
| Native transaction | Preserve transaction boundaries | Create metadata and initial rows, admit the catalog, and commit under custody |
| `afterSeal` | Record confirmed native commit | Invoke only after a successful commit |
| `activateRuntime` | Select the captured runtime shard and verify its native identity | Invoke after native seal/catalog admission; close a failed opening |

All effects use the current custody assertion. Provider exceptions propagate through opening failure. Ordinary application writes retain their existing domain admission and transaction owner.

## Effect receipts and recovery

The extension owns an owner-only SQLite preparation journal adjacent to the core identity anchor. It records the complete immutable recipe, namespace/store/version identity, recipe and statement hashes, and ordered step receipts. SQLite uses full synchronization.

| Durable observation | Allowed next action |
| --- | --- |
| New core anchor, no native namespace, no prior journal | Initialize the recipe and begin fresh preparation |
| Completed prefix followed by queued steps | Resume only the queued suffix while custody remains current |
| Pending remote effect | Refuse automatic replay; its outcome is unknown |
| Missing/truncated/altered receipt, recipe, or identity | Refuse recovery |
| Namespace disappeared after recorded effects | Refuse recreation from the old receipts |
| All DDL complete, journal active | Recheck the catalog, record sealing intent, then let core seal |
| Journal sealing/sealed, native metadata absent | Refuse reseeding; manual recovery is required |
| Matching authoritative native metadata after a lost local completion callback | Core may reopen after its independent identity and catalog checks |
| Different native identity/version or catalog drift | Refuse admission/migration |

This deliberately has no automatic repair command for ambiguous effects. The supported recovery behavior is a visible refusal while preserving anchors and receipts. Operators must not remove a journal to force initialization.

## Runtime capabilities

The prototype advertises `derivedSearch: "unavailable"` and `sequenceAllocation: "standalone"`. Canonical transcript content remains native. Search consumers receive an unavailable capability; memory search stays disabled.

Standalone sequence allocation is a core query-builder choice for opted-in connections. It runs within the caller's existing native transaction, preserves full bigint precision, and binds allocated IDs into the transcript multi-write CTE. The extension does not rewrite SQL strings.

The runtime hook verifies the selected shard contains the admitted store identity. The operator must supply the approved shard UID and retain the one-shard topology. Bootstrap clears a pooled direct target before routed DDL. This is not a multi-shard atomicity or failover guarantee.

## Qualification and owner decisions

The minimum fresh-store proof is a real Gateway assistant reply, independently observed native persistence, full process shutdown, a new process opening the same state, exact assistant-history retrieval, a second model reply using prior context, and verified disposable-resource cleanup. Recovery tests cover interrupted effects, lost sealing callbacks, altered receipts, stale custody, and missing native storage. Host application verifies the base commit and every affected file hash.

The storage owner still needs to decide whether this seam belongs in the supported API and which responsibilities core should absorb. Migrations, porting, backup restore, topology changes, failover, and multi-shard qualification require separate contracts and evidence. No support for those operations follows from fresh-store success.
