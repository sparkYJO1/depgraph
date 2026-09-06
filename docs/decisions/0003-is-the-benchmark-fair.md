# 3. Report three implementations, not two, and say where Postgres was tuned

Status: accepted

## Context

The obvious version of this project measures one recursive CTE against one
Cypher query and concludes that the graph database wins. That result would be
worthless, and worse than worthless if anyone acted on it, because the two
queries would not be doing comparable amounts of work.

The specific problem is `UNION` in a recursive CTE. It deduplicates the
recursive term against every row generated so far, which is what stops the walk
running forever — but it deduplicates *whole rows*, and the row has to carry
`depth` for the question to be answerable. So a package reachable at depth 3 and
again at depth 5 is two distinct rows and gets expanded twice. Postgres has no
way to say "dedupe on this column but keep that one".

That is a real limitation of SQL, and reporting it is fair. Reporting it while
implying it is the best Postgres can do is not, because it is not: you can write
the breadth-first search yourself.

## Decision

Three columns, not two.

1. **`postgres (recursive CTE)`** — one statement per question. What you write
   first, and what most comparisons of this kind measure.
2. **`postgres (BFS)`** — the same three questions as a level-synchronous
   breadth-first search: one set-based statement per level, driven from the
   application, with the visited set in a session temporary table and
   `ON CONFLICT (id) DO NOTHING` as the "have I seen this" check. Round trips
   scale with the depth limit, not with the number of nodes.
3. **`neo4j (Cypher)`** — `ANY SHORTEST` and `shortestPath`.

All three are asked about the same packages, chosen once at seed time and stored
in `dataset_meta`. Before any timing, `scripts/bench.mjs` runs all three and
compares their answers; if they disagree the benchmark exits rather than
printing a table. Shortest paths are compared by length, not by identity,
because two paths of equal length are equally correct.

## What was tuned on the Postgres side, and how it was checked

`npm run explain` prints the plans, so none of the below has to be taken on
trust.

- `depends_on` is indexed on both columns. The primary key `(pkg_id, dep_id)`
  serves the downward walk; `depends_on_dep_idx` serves the upward one. Without
  the second index the blast-radius query is a sequential scan per level and the
  comparison stops being about traversal.
- `VACUUM ANALYZE` runs at the end of the seed. Without statistics the planner
  works from a default row estimate.
- The BFS working table's clearing strategy was measured, got it wrong, and was
  corrected. See below.
- Four configurations of the BFS working table were measured against each other:

  | configuration                        | blast radius, depth 4 | reachability, depth 10 |
  |--------------------------------------|----------------------:|-----------------------:|
  | TEMP table, index on depth, DISTINCT |             149 ms    |              162 ms    |
  | TEMP table, no index on depth        |             126 ms    |              399 ms    |
  | TEMP table, no `SELECT DISTINCT`     |             476 ms    |              411 ms    |
  | UNLOGGED ordinary table              |             221 ms    |              243 ms    |

  The first is what ships. Dropping `SELECT DISTINCT` and letting
  `ON CONFLICT DO NOTHING` absorb the duplicates is correct — it tolerates
  duplicates within a single statement — and it is three times slower, because
  the conflict machinery runs per row where the hash aggregate collapses them
  first.

## The measurement that was wrong, and how it was caught

The BFS store originally cleared its working table with `DELETE`, on the
strength of a measurement: `DELETE` 0.4 ms, `TRUNCATE` 4 ms. The measurement was
taken against an empty table, which made it meaningless.

Temporary tables are never autovacuumed. Across sixty searches the table grew
from 960 KB to 31 MB of dead tuples and the store's times drifted from 124 ms to
228 ms — so the first full benchmark run reported a "tuned" Postgres column that
was mostly measuring its own garbage. The check that caught it, and that can be
re-run in seconds, is to print `pg_total_relation_size` alongside the timing on
every tenth call:

```
--- clearing with DELETE ---            --- clearing with TRUNCATE ---
  call  0  124.5 ms   table   960 KB      call  0  148.8 ms   table 960 KB
  call 20  226.1 ms   table 11128 KB      call 20  124.7 ms   table 960 KB
  call 59  227.6 ms   table 30984 KB      call 59  118.9 ms   table 960 KB
```

`TRUNCATE` costs a real fixed 4 ms per search, which is why the BFS store never
wins at depth 2. That is a cost the single-statement CTE genuinely does not pay,
and it belongs in the table rather than being tuned away.

## Considered and rejected

**Keeping the visited set in the application instead of a temporary table.**
Send the frontier down as an `integer[]` parameter, get the next frontier back,
track visited in a JavaScript `Set`. Simpler code, no temporary table, no
`TRUNCATE` cost, no bloat, and it would almost certainly have been the fastest
Postgres column in the table.

Rejected because it would have stopped being a comparison of the two stores.
Postgres would have been reduced to an index-lookup service with the graph
algorithm living in Node, and "Postgres beats Neo4j at traversal" would have
meant "Node beats Neo4j at traversal, using Postgres as a hash index". That is a
legitimate architecture and it is not the question this repository asks. It is
worth knowing as a real option: if the graph fits in application memory, neither
store's traversal is the thing to optimise.

**Reporting only the recursive CTE.** Rejected for the reason at the top of this
document.

**Tuning the Neo4j side no further.** Not rejected so much as bounded. The
Cypher queries here are the idiomatic ones and the plans confirm they use the
expected operators, but two things were found and are disclosed rather than
fixed:

- Asking Cypher for the *depth* is expensive. `ANY SHORTEST` returns depth and
  costs roughly ten times the same traversal expressed as
  `MATCH (root)-[:DEPENDS_ON*1..10]->(v) WHERE v.vulnerable RETURN DISTINCT v.id`,
  which cannot return depth: 89 ms against roughly 550-1100 ms at depth 10. The
  pruning expansion that makes graph traversal fast is only available when no
  path is projected. Both stores here are asked for depth, so the comparison is
  like for like, but a reader who does not need depth should know that the
  Neo4j number falls by an order of magnitude.
- Neo4j Community only has the slotted runtime. The pipelined runtime is an
  Enterprise feature and would change these numbers. Everything here is
  Community.

## What would change the answer

- Enterprise Neo4j, for the pipelined runtime.
- A graph large enough that neither store's working set fits in memory. At the
  default size the entire graph is roughly 30 MB and both stores serve every
  measured query from cache, so this benchmark says nothing about I/O.
- A workload of many concurrent small queries rather than one large one.
  Everything here is single-client and sequential.
