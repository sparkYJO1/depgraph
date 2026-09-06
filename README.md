# depgraph

Is a vulnerable package reachable from my application, and through which
dependency chain?

That is a graph reachability question, and it is the question a security
advisory actually leaves you with — knowing that `some-parser` has a CVE is not
useful until you know whether anything you ship can reach it, and what you would
have to change to stop reaching it.

This repository answers it twice: once with a Postgres recursive CTE and once
with Neo4j Cypher, on the same generated 50,000-package dependency graph, with
the timings measured rather than asserted.

**The point is not that a graph database can traverse a graph.** Every tutorial
shows that. The point is whether it is worth a second store, and that is a
question with a number attached.

The answer turned out to be narrower than the premise implied. Postgres wins
reachability outright, at every depth measured. Blast radius is level at depth 4
and Neo4j takes over beyond it, two to four times faster. And shortest path is
not close: Neo4j answers in one to two milliseconds at every depth while the
recursive CTE degrades an order of magnitude per level and gives up entirely at
depth 10, because returning a path puts SQL in a different complexity class. One query out of three is the real
case for the second store — and it happens to be the only one of the three whose
answer you can act on.

It is the analysis half of a pair. The ingest half —
[signalpipe](https://github.com/sparkYJO1/signalpipe) — pulls OSV security
advisories. This is what you do with them once you have them.

## Run it

```bash
docker compose up -d --wait   # Postgres on 55433, Neo4j on 57687 / 57474
npm install
npm run seed                  # generate the graph and load both stores (~40s)
npm run bench                 # the table below
npm run demo                  # the same answers, printed for a human
npm run explain               # the query plans behind the benchmark
```

Size is configurable, so the benchmark can be re-run at a different scale:

```bash
DEPGRAPH_PACKAGES=200000 DEPGRAPH_EDGES=800000 npm run seed && npm run bench
```

Everything is generated from a seed, so the graph is identical on every machine
and these numbers are reproducible rather than anecdotal.

## The three questions

| | question | why it matters |
|---|---|---|
| 1 | **Reachability** — which vulnerable packages does this application pull in, and at what depth? | The advisory triage list. |
| 2 | **Blast radius** — if this package were compromised, how many packages transitively depend on it? | What one advisory actually costs. |
| 3 | **Shortest path** — the minimal dependency chain from the application to a given vulnerability. | The only one that is actionable: it names the direct dependency you would have to change. |

## What it prints

`npm run demo` — the same answers, arranged for a human. A count of reachable
vulnerabilities is not actionable; a chain is, because it names the direct
dependency you would have to change.

```
════════════════════════════════════════════════════════════════════════
 depgraph — which known-vulnerable packages can this application reach?
════════════════════════════════════════════════════════════════════════

  Application   cobalt-guard-49961
  Registry      50,000 packages, 199,981 dependency edges
  Closure       9,868 packages within 10 levels
  Vulnerable    53 of them are flagged
  Cross-checked Postgres and Neo4j agree on that list

────────────────────────────────────────────────────────────────────────
 Closest first — the chain names the direct dependency you would have to change
────────────────────────────────────────────────────────────────────────

  2 hops away — gravel-trace-24318
    cobalt-guard-49961
     └─ indigo-router-48758
        └─ gravel-trace-24318 (vulnerable)

  3 hops away — gravel-cache-13838
    cobalt-guard-49961
     └─ vector-queue-49470
        └─ async-loader-21528
           └─ gravel-cache-13838 (vulnerable)

  (three more at 3 hops, elided)

  ...and the furthest one, 8 hops away — tundra-watch-28175
    cobalt-guard-49961
     └─ umber-stream-49394
        └─ jasper-diff-48706
           └─ bright-trace-47649
              └─ bright-diff-45050
                 └─ mica-schema-42378
                    └─ nimbus-queue-40449
                       └─ slate-pool-36293
                          └─ tundra-watch-28175 (vulnerable)

────────────────────────────────────────────────────────────────────────
 The other direction — if yarrow-core-6689 were compromised, who is exposed?
────────────────────────────────────────────────────────────────────────

  It has 1,097 direct dependents. Transitively:

    within   1 hop    1,097 packages    2.2%  █
    within  2 hops    3,672 packages    7.3%  ███
    within  3 hops    7,967 packages   15.9%  ██████
    within  4 hops   12,225 packages   24.4%  ██████████
    within  6 hops   15,179 packages   30.4%  ████████████
    within  8 hops   15,415 packages   30.8%  ████████████
    within 10 hops   15,422 packages   30.8%  ████████████

  That is the number an advisory for one package actually means.
```

## The numbers

Verbatim output of `npm run bench`. Every cell is `median / fastest` across 21
timed runs; lower is better.

```
### Benchmark

Dataset: 50000 packages, 199981 dependency edges, 251 marked vulnerable, 10 levels deep.
Hardware: Apple M3, 8 cores, 24 GB, darwin 25.5.0. Both stores in Docker.
Versions: Postgres 16.15, Neo4j 5.26.30, Node v22.21.1.
Method: 3 discarded warm-up runs, then 21 timed runs. Each cell is `median / fastest` in milliseconds.
Load average when this run started: 4.0, 4.4, 6.6 on 8 cores.

#### Query 1 — reachability: which vulnerable packages does `cobalt-guard-49961` pull in, and how deep?

| depth | postgres (recursive CTE) | postgres (BFS) | neo4j (Cypher) | result        |
|------:|-------------------------:|---------------:|---------------:|---------------|
|     2 |                0.8 / 0.6 |      5.8 / 4.1 |      4.8 / 3.8 | 1 vulnerable  |
|     4 |                3.1 / 2.9 |    25.9 / 23.5 |    15.7 / 12.3 | 20 vulnerable |
|     6 |              14.4 / 12.4 |    66.6 / 63.7 |    38.3 / 29.9 | 46 vulnerable |
|     8 |              26.4 / 25.2 |    84.2 / 81.6 |   106.4 / 84.8 | 53 vulnerable |
|    10 |              35.3 / 33.5 |    93.2 / 87.3 |  228.8 / 192.1 | 53 vulnerable |

Widest run-to-run spread in this table: neo4j (Cypher) at depth 4, 12.3-64.4 ms across 21 runs (5.2x).

#### Query 2 — blast radius: how many packages transitively depend on `yarrow-core-6689`?

| depth | postgres (recursive CTE) | postgres (BFS) | neo4j (Cypher) | result           |
|------:|-------------------------:|---------------:|---------------:|------------------|
|     2 |                2.7 / 2.4 |    23.3 / 20.9 |      5.1 / 3.7 | 3672 dependents  |
|     4 |              16.4 / 15.1 |    93.2 / 80.6 |    16.5 / 14.7 | 12225 dependents |
|     6 |              34.3 / 31.5 |  123.9 / 117.2 |     14.7 / 9.3 | 15179 dependents |
|     8 |              55.9 / 40.7 |  145.8 / 132.7 |    12.0 / 10.3 | 15415 dependents |
|    10 |              44.3 / 42.6 |  134.5 / 126.5 |    11.7 / 10.8 | 15422 dependents |

Widest run-to-run spread in this table: neo4j (Cypher) at depth 2, 3.7-28.2 ms across 21 runs (7.6x).

#### Query 3 — shortest path: the minimal dependency chain from `cobalt-guard-49961` to `quartz-bridge-4945`

| depth | postgres (recursive CTE) | postgres (BFS) | neo4j (Cypher) | result        |
|------:|-------------------------:|---------------:|---------------:|---------------|
|     2 |                0.6 / 0.5 |      4.2 / 3.4 |      1.7 / 1.2 | not reachable |
|     4 |               12.1 / 7.6 |    27.7 / 24.7 |      1.5 / 1.0 | not reachable |
|     6 |            202.2 / 188.9 |    70.2 / 63.8 |      2.0 / 1.2 | not reachable |
|     8 |          3375.6 / 3101.3 |    88.6 / 82.4 |      1.4 / 1.1 | 8 hops        |
|    10 |                     >15s |    97.9 / 86.6 |      1.5 / 1.2 | 8 hops        |

Widest run-to-run spread in this table: neo4j (Cypher) at depth 4, 1.0-23.8 ms across 21 runs (24.2x).

```

## What the numbers say

**Postgres wins reachability at every depth measured.** This is the opposite of
what "use a graph database for graph problems" predicts, and it is the most
useful thing in this repository. At depth 10, Postgres answers in 35 ms and
Neo4j in 229 ms — a 6.5x gap in favour of the relational store.

**The crossover for blast radius is at depth 4, and it is a genuine tie there.**
Postgres is faster at depth 2 (2.7 ms against 5.1 ms), the two are level at
depth 4 (16.4 against 16.5), and Neo4j pulls away after that — 2.3x at depth 6,
3.8x at depth 10. So the honest form of the claim is: *for counting transitive
dependents, Postgres is fine to depth 3 or 4 and Neo4j wins beyond it* — not
"the graph database always wins".

**Shortest path is the one that actually justifies a second store**, and it
justifies it completely. Neo4j answers in 1.4-2.0 ms at every depth, and the
depth barely moves it. The recursive CTE degrades an order of magnitude per
level past depth 4 — 12 ms, 202 ms, 3.4 s — and stops finishing at depth 10.

### Why the answers differ per query

The three results have one cause between them: **whether the query has to return
a depth or a path, and what that costs each store.**

*Postgres.* A recursive CTE terminates because `UNION` deduplicates the
recursive term against every row produced so far. But it deduplicates whole
rows, and the row has to carry `depth` for the question to be answerable — so a
package reachable at two different depths is two distinct rows and gets expanded
twice. `npm run explain` shows exactly that: the recursive union emits **27,352
rows for a reachable set of 9,868 packages**, a 2.8x over-expansion, and the
plan runs 21,514 index lookups to do it.

Push that one step further and you get the shortest-path result. Returning a
*path* means carrying the path in the row, and once the path is in the row no
two rows are ever duplicates, so `UNION` deduplicates nothing at all. The query
stops enumerating reachable nodes and starts enumerating every simple path.
That is not slow, it is a different complexity class, and it is why that column
says `>15s`.

*Neo4j.* It has the same problem in a milder form. `ANY SHORTEST` returns depth
and costs **333,454 database hits**; the identical traversal written as
`MATCH (root)-[:DEPENDS_ON*1..8]->(v) WHERE v.vulnerable RETURN DISTINCT v.id`,
which cannot return depth, costs **110,122** — because only the second one is
allowed to use `VarLengthExpand(Pruning,BFS)`, the operator that visits each
node once. Blast radius is the query where nobody needs a depth, and it is the
query Neo4j wins comfortably.

So the rule this benchmark actually supports is narrower and more useful than
"graphs are faster":

> Reach for the graph database when the answer you need is a **path**. For
> reachable-set questions a recursive CTE is competitive, and often better.

### The third column, and why the obvious optimisation does not pay

`postgres (BFS)` is a hand-written breadth-first search: one set-based statement
per level, visited set in a temporary table, `ON CONFLICT DO NOTHING` as the
membership check. It exists so the CTE's specific weakness is not mistaken for
Postgres's, because otherwise this whole comparison would be rigged.

It expands every node exactly once, and it is **slower than the naive CTE on
two of the three queries**. Materialising the visited set — index maintenance on
every insert, plus a 4 ms `TRUNCATE` per search — costs more than the redundant
expansion it removes. It earns its place only on shortest path, where it is the
formulation that works at all: it finishes in 253 ms at depth 10 where the CTE
cannot finish in fifteen seconds.

That is worth stating plainly, because it is the kind of result that only shows
up if you build the thing you expect to win and then measure it honestly.


## How it works

Everything is generated. `npm run seed` builds a directed acyclic graph with a
power-law degree distribution, hub packages that a large share of the graph
depends on, a long tail of packages with one or two dependencies, and a depth of
ten levels — then loads the identical graph into both stores.
[ADR 1](docs/decisions/0001-synthetic-graph-shape.md) explains why that shape,
and where it is not realistic.

Three implementations answer all three questions:

| implementation | how it traverses |
|---|---|
| `postgres (recursive CTE)` | One `WITH RECURSIVE` statement per question. |
| `postgres (BFS)` | Breadth-first search, one set-based statement per level, visited set in a temporary table. Included so the CTE's weakness is not mistaken for Postgres's. |
| `neo4j (Cypher)` | `ANY SHORTEST` and `shortestPath` — breadth-first search asked for rather than written. |

`npm run bench` runs all three and compares their answers before it times
anything. If they disagree it prints the disagreement and exits, because a
benchmark of implementations that give different answers is measuring two
different questions. `npm run explain` prints the query plans.

```
src/generate.mjs        the graph, from a seed
src/probes.mjs          picks which packages the benchmark asks about
src/stores/postgres.mjs both Postgres implementations, and the loader
src/stores/neo4j.mjs    the Cypher implementation, and the loader
src/stores/schema.sql   the entire data model: two tables
scripts/                seed, bench, demo, explain
docs/decisions/         why the arguable choices were made that way
```

## What this does not prove

- **It does not prove Neo4j is faster than Postgres.** It shows that on this
  graph, at this size, on this hardware, Postgres answers two of these three
  questions faster and cannot answer the third at all. Change any of those and
  the answer can change.
- **Nothing here touches disk.** The whole graph is roughly 30 MB and both
  stores serve every measured query from memory. A graph large enough to miss
  cache is a different benchmark, and is the one where the storage layout
  differences between the two stores would actually show up.
- **It is single-client and sequential.** One connection, one query at a time.
  Nothing here says anything about concurrency, connection pooling, or how
  either store behaves under a mixed read/write load.
- **The graph is synthetic.** It is shaped to resemble a package registry and it
  is not one. In particular it has no cycles and no version resolution.
- **Neo4j Community only.** The pipelined runtime is an Enterprise feature and
  would change the Neo4j numbers.
- **It was measured on a working laptop, not an isolated benchmark host**, with
  other containers running. That is why every table reports the fastest run
  beside the median and the widest spread underneath: so you can see how much of
  each number is the query and how much is the machine.
- **The comparison is of query formulations, not of products.** A different
  Cypher query or a different SQL formulation moves these numbers. Three
  formulations are shown and
  [ADR 3](docs/decisions/0003-is-the-benchmark-fair.md) records what was tuned,
  what was rejected, and one measurement that was wrong and how it was caught.

## Decisions

- [1. Generate the graph rather than download one, and generate it this shape](docs/decisions/0001-synthetic-graph-shape.md)
- [2. Load both stores through their normal query paths, in tuned batch sizes](docs/decisions/0002-loading-the-graph.md)
- [3. Report three implementations, not two, and say where Postgres was tuned](docs/decisions/0003-is-the-benchmark-fair.md)

## Built with Claude

This repository was built with Claude, working against decisions I made and
reviewed. The design questions — generate the graph rather than download one,
benchmark a hand-written BFS alongside the naive CTE so the comparison is not
rigged, publish the crossover honestly rather than the conclusion I expected —
are mine, and the ADRs record the ones I rejected along with the reasons. I read
every query in this repository and can defend each one.
