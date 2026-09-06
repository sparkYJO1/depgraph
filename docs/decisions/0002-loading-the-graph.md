# 2. Load both stores through their normal query paths, in tuned batch sizes

Status: accepted

## Context

`npm run seed` has to put 50,000 packages and 200,000 dependency edges into two
stores. The first version took 166 seconds, almost all of it Neo4j, and the
whole repository is supposed to be runnable end to end in a couple of minutes.

## Decision

Both stores are loaded through their ordinary client protocol — parameterised
`INSERT ... SELECT unnest(...)` for Postgres, `UNWIND $rows ... CREATE` for
Neo4j — in batches whose size was measured rather than guessed.

Measurements, relationship creation into Neo4j on the machine described in the
README:

| rows per transaction | throughput   |
|---------------------:|-------------:|
|                5,000 |  7,152 rel/s |
|               20,000 | 11,530 rel/s |
|               50,000 | 14,198 rel/s |

Combined with raising the Neo4j heap from 1 GB to 2 GB, the Neo4j load went from
142 s to 23 s and the whole seed from 166 s to 38 s. The heap mattered more than
the batch size: at 1 GB the same work ran at roughly 1,400 relationships per
second, because the load was spending its time in garbage collection rather than
in the store.

Postgres is `VACUUM ANALYZE`d immediately after loading. Without it the planner
has no statistics for either table and picks plans based on a default row
estimate, which would make the benchmark a measurement of the planner's guess.

## Considered and rejected

**Loading relationships from several connections in parallel.** Four concurrent
transactions of 5,000 rows each, to use more than the one core that Neo4j
Community's slotted runtime saturates. Tried, and it fails:

```
Neo4jError: ForsetiClient[transactionId=76, clientId=1] can't acquire
ExclusiveLock{owner=ForsetiClient[transactionId=75, clientId=2]} on
RELATIONSHIP(32960)
  code: 'Neo.TransientError.Transaction.DeadlockDetected'
```

The graph has hub packages with over a thousand dependents. Two transactions
creating relationships into the same hub contend on that node's relationship
chain, and with batches that each touch many hubs, a deadlock is not unlikely,
it is close to certain. The error is marked retriable and the driver's managed
transactions would retry it, so this could have been made to work. It was
rejected anyway: a seed step that sometimes takes twice as long because it
deadlocked and retried is a seed step that makes the timing numbers underneath
it harder to trust, and the sequential version is already fast enough.

**`neo4j-admin database import`.** This is the correct way to bulk load Neo4j
and it is roughly two orders of magnitude faster than Cypher. It also requires
writing CSVs, stopping the database, running a command inside the container, and
starting it again — and it can only create a database, not add to one, so
re-seeding at a different size means tearing the store down. Rejected because
`docker compose up -d --wait && npm run seed` has to keep working as one line,
and 23 seconds does not justify that machinery. Worth knowing it exists if the
default size is ever raised by an order of magnitude.

**`TRUNCATE` for clearing the BFS working table.** See
`0003-is-the-benchmark-fair.md`; that one was rejected, then reinstated when the
first measurement turned out to have been taken against an empty table.
