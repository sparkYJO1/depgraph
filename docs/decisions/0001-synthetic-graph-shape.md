# 1. Generate the graph rather than download one, and generate it this shape

Status: accepted

## Context

The benchmark needs a dependency graph. There are two ways to get one: pull a
real registry, or generate one.

A real registry is more convincing on its face. It is also unusable as a
benchmark input for three reasons. It changes, so the numbers in the README stop
being reproducible the week after they are measured. It cannot be resized, so
"re-run this at 500k packages" stops being a thing anyone can do. And it drags
in a licence and a multi-gigabyte download for a repository whose point is a
timing table.

So: generated. That moves the entire argument onto the shape of what is
generated, because a benchmark run against an unrealistic graph measures nothing
about a real one.

## Decision

`src/generate.mjs` produces a directed acyclic graph with these properties, each
chosen because it changes the answer:

**Levels, with more packages low down than high up.** Every package sits on a
level; a package on level k depends only on packages below it, and its first
dependency always comes from level k-1. Level sizes decay geometrically, so
there are roughly 14,500 leaf utilities and roughly 500 top-level applications.

This is what makes "reachability to depth 8" a meaningful question. If depth
were left to chance, the deepest chain in the graph would be whatever the random
draw happened to produce, and the depth axis of the benchmark table would be
measuring the generator instead of the stores.

**Out-degree drawn from a power law.** Most packages declare one or two
dependencies; about one in ten declares ten or more; the cap is 64. The tail
exponent is 1.1, and the draws are scaled by a multiplier found by binary search
so that the totals land on whatever edge budget the caller configured. That
keeps the *shape* fixed while the *size* stays a knob.

**In-degree grown by preferential attachment, not assigned.** When a package
picks a dependency, 85% of the time it draws from a pool weighted by how many
dependents the candidate already has, and otherwise uniformly. Hubs emerge from
that rather than being placed by hand: at the default size the most depended-on
package has about 1,100 direct dependents and about 300 packages have more than
100.

The 85% is not arbitrary. The first version used a single pool in which every
package appeared once to begin with and once more per dependent acquired. Those
initial appearances swamped the popularity signal: across 200,000 edges the most
depended-on package in the entire graph reached only 52 dependents, which is not
a hub. Splitting the pools and taking most draws from the popularity-weighted
one is what produced a heavy enough tail.

Hubs are the entire reason this benchmark is interesting. A graph with a
Poisson degree distribution — which is what uniform random target selection
produces — has no package whose compromise matters more than any other, and
"blast radius" becomes a question with a boring answer everywhere.

**Acyclic by construction.** Package ids are handed out level by level, so every
edge points from a higher id to a lower one. `scripts/seed.mjs` asserts this on
every edge rather than trusting the generator, because every query in this
repository depends on it and the property is emergent rather than enforced by
the schema.

**Vulnerabilities marked uniformly at random**, about 0.5% of packages.

## Considered and rejected

**Placing hubs by hand.** Pick fifty packages, declare them hubs, wire a large
fraction of the graph to them. Simpler code, and it would have produced a graph
that looks right in a summary table. Rejected because the hub set would then be
an input rather than a result, and the interesting question — does the store
still perform when popularity is distributed rather than concentrated — would
have been assumed away. Preferential attachment costs about fifteen lines and
produces a continuum instead of a cliff.

**Marking hubs as vulnerable deliberately** so the demo has a dramatic blast
radius. Rejected: it would have been rigging the demo. Uniform marking at 0.5%
already puts 53 vulnerable packages inside the closure of the probe application,
because the closure is 9,868 packages. The dramatic number came out on its own.

## Where this is not realistic

Listed because a benchmark that only advertises its strengths is an
advertisement.

- **Real dependency graphs are not perfectly acyclic.** npm permits cycles and
  they occur. Both stores here would need a visited-set guard to survive one;
  the Postgres BFS and Neo4j's shortest-path search already have it, and the
  recursive CTE's `UNION` provides it. So the missing cycles make the numbers
  slightly optimistic for all three equally, rather than favouring one.
- **Real versions exist.** A real registry has a package-version node, and
  resolution picks one version per package. Modelling that roughly triples the
  node count and adds an edge type. It would make every number here larger and
  would not change which store wins.
- **Level structure is stricter than reality.** A real package can depend on
  something at any depth including something very deep; here the first
  dependency is always exactly one level down. That makes depth well-behaved,
  which is the point, but it means the depth distribution is tidier than a real
  one.
- **The vulnerability rate is a guess.** 0.5% is plausible for "packages with an
  open advisory" and is not measured against anything. It affects only the size
  of the result set, not the traversal.
