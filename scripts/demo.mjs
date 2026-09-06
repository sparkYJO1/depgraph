// The benchmark answers "how fast". This answers "so what" — it prints the
// chains, because a count of reachable vulnerabilities is not actionable and a
// dependency chain is: it names the direct dependency you would have to change.

import * as postgres from "../src/stores/postgres.mjs";
import * as neo4j from "../src/stores/neo4j.mjs";

const DEPTH = 10;
const CHAINS_TO_SHOW = 5;

const rule = (char = "─") => char.repeat(72);
const hops = (n) => `${n} ${n === 1 ? "hop" : "hops"}`;
const count = (n) => n.toLocaleString("en-US");

async function nameLookup(client) {
  const { rows } = await client.query("SELECT id, name, vulnerable FROM package");
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id) => byId.get(id);
}

function drawChain(path, names) {
  const lines = [];
  path.forEach((id, index) => {
    const node = names(id);
    const marker = node.vulnerable ? " (vulnerable)" : "";
    if (index === 0) lines.push(`    ${node.name}${marker}`);
    else lines.push(`    ${"   ".repeat(index - 1)} └─ ${node.name}${marker}`);
  });
  return lines.join("\n");
}

async function main() {
  const client = await postgres.openPostgres();
  const driver = neo4j.openNeo4j();
  const graph = neo4j.neo4jStore(driver);
  const sql = postgres.postgresBfs(client);
  await sql.prepare();

  const { probes, shape } = await postgres.readMeta(client);
  const names = await nameLookup(client);

  console.log("");
  console.log(rule("═"));
  console.log(" depgraph — which known-vulnerable packages can this application reach?");
  console.log(rule("═"));
  console.log("");
  console.log(`  Application   ${probes.reachabilityRootName}`);
  console.log(`  Registry      ${count(shape.packages)} packages, ${count(shape.edges)} dependency edges`);
  console.log(`  Closure       ${count(probes.reachabilityRootClosure)} packages within ${DEPTH} levels`);

  const reachable = await graph.reachability(probes.reachabilityRoot, DEPTH);
  const alsoFromSql = await sql.reachability(probes.reachabilityRoot, DEPTH);
  const agree = JSON.stringify(reachable.map((r) => [r.id, r.depth])) === JSON.stringify(alsoFromSql.map((r) => [r.id, r.depth]));
  console.log(`  Vulnerable    ${reachable.length} of them are flagged`);
  console.log(`  Cross-checked Postgres and Neo4j ${agree ? "agree" : "DISAGREE"} on that list`);
  console.log("");

  console.log(rule());
  console.log(` Closest first — the chain names the direct dependency you would have to change`);
  console.log(rule());

  for (const hit of reachable.slice(0, CHAINS_TO_SHOW)) {
    const path = await graph.shortestPath(probes.reachabilityRoot, hit.id, DEPTH);
    console.log("");
    console.log(`  ${hops(hit.depth)} away — ${hit.name}`);
    console.log(drawChain(path, names));
  }

  const deepest = reachable[reachable.length - 1];
  if (deepest && deepest.depth > reachable[CHAINS_TO_SHOW - 1]?.depth) {
    const path = await graph.shortestPath(probes.reachabilityRoot, deepest.id, DEPTH);
    console.log("");
    console.log(`  ...and the furthest one, ${hops(deepest.depth)} away — ${deepest.name}`);
    console.log(drawChain(path, names));
  }

  console.log("");
  console.log(rule());
  console.log(` The other direction — if ${probes.blastRadiusTargetName} were compromised, who is exposed?`);
  console.log(rule());
  console.log("");
  console.log(`  It has ${count(probes.blastRadiusTargetInDegree)} direct dependents. Transitively:`);
  console.log("");
  for (const depth of [1, 2, 3, 4, 6, 8, 10]) {
    const affected = await graph.blastRadius(probes.blastRadiusTarget, depth);
    const share = ((affected / shape.packages) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((affected / shape.packages) * 40));
    console.log(`    within ${hops(depth).padStart(7)}   ${count(affected).padStart(6)} packages  ${share.padStart(5)}%  ${bar}`);
  }

  console.log("");
  console.log(`  That is the number an advisory for one package actually means.`);
  console.log("");

  await client.end();
  await driver.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
