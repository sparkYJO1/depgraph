// Prints the query plans behind the benchmark.
//
// This exists so the fairness claim in docs/decisions/0003-is-the-benchmark-fair.md
// can be re-checked in seconds rather than re-argued. If someone thinks the
// Postgres side is being handicapped, this is where to look: the plans show
// which indexes are used, how many rows each operator actually produced, and
// how many times a node was expanded.

import * as postgres from "../src/stores/postgres.mjs";
import * as neo4j from "../src/stores/neo4j.mjs";

const DEPTH = Number(process.env.DEPGRAPH_EXPLAIN_DEPTH ?? 8);

function heading(text) {
  console.log("");
  console.log(`=== ${text} ${"=".repeat(Math.max(0, 68 - text.length))}`);
  console.log("");
}

async function explainPostgres(client, label, sql, params) {
  heading(label);
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`, params);
  for (const row of rows) console.log(row["QUERY PLAN"]);
}

async function profileNeo4j(driver, label, query, params) {
  heading(label);
  const session = driver.session();
  try {
    const result = await session.run(`PROFILE ${query}`, params);
    // Walking the plan tree rather than printing it whole: the numbers that
    // matter are the operator names and the database hits per operator.
    const walk = (plan, indent = 0) => {
      const args = plan.arguments ?? {};
      const hits = args.DbHits ?? 0;
      const rows = args.Rows ?? 0;
      console.log(`${" ".repeat(indent)}${plan.operatorType}  rows=${rows}  dbHits=${hits}`);
      for (const child of plan.children ?? []) walk(child, indent + 2);
    };
    walk(result.summary.profile);
  } finally {
    await session.close();
  }
}

async function main() {
  const client = await postgres.openPostgres();
  const driver = neo4j.openNeo4j();
  const { probes } = await postgres.readMeta(client);
  const bfs = postgres.postgresBfs(client);
  await bfs.prepare();

  console.log(`Plans at depth ${DEPTH}. Root #${probes.reachabilityRoot}, hub #${probes.blastRadiusTarget}.`);

  await explainPostgres(
    client,
    "Postgres: recursive CTE reachability",
    `WITH RECURSIVE reachable (id, depth) AS (
         SELECT $1::integer, 0
       UNION
         SELECT edge.dep_id, reachable.depth + 1
         FROM reachable JOIN depends_on edge ON edge.pkg_id = reachable.id
         WHERE reachable.depth < $2
     )
     SELECT package.id, min(reachable.depth)
     FROM reachable JOIN package ON package.id = reachable.id
     WHERE package.vulnerable AND reachable.depth > 0
     GROUP BY package.id`,
    [probes.reachabilityRoot, DEPTH],
  );

  // Put a realistic frontier in place so the per-level plan below is measured
  // against real data rather than an empty table.
  await bfs.reachability(probes.reachabilityRoot, DEPTH - 1);
  await explainPostgres(
    client,
    `Postgres: one BFS level (expanding everything found at depth ${DEPTH - 1})`,
    `INSERT INTO bfs_visited (id, depth)
     SELECT DISTINCT edge.dep_id, $1::integer
     FROM bfs_visited frontier JOIN depends_on edge ON edge.pkg_id = frontier.id
     WHERE frontier.depth = $1::integer - 1
     ON CONFLICT (id) DO NOTHING`,
    [DEPTH],
  );

  await profileNeo4j(
    driver,
    "Neo4j: ANY SHORTEST reachability (returns depth)",
    `MATCH path = ANY SHORTEST
       (root:Package {id: $root})-[:DEPENDS_ON]->{1,${DEPTH}}(v:Package WHERE v.vulnerable)
     RETURN v.id, length(path)`,
    { root: probes.reachabilityRoot },
  );

  await profileNeo4j(
    driver,
    "Neo4j: the same traversal without asking for depth",
    `MATCH (root:Package {id: $root})-[:DEPENDS_ON*1..${DEPTH}]->(v:Package)
     WHERE v.vulnerable
     RETURN DISTINCT v.id`,
    { root: probes.reachabilityRoot },
  );

  await profileNeo4j(
    driver,
    "Neo4j: blast radius",
    `MATCH (target:Package {id: $target})<-[:DEPENDS_ON*1..${DEPTH}]-(dependent:Package)
     RETURN count(DISTINCT dependent)`,
    { target: probes.blastRadiusTarget },
  );

  console.log("");
  await client.end();
  await driver.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
