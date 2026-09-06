// Generates the dependency graph and loads the identical graph into both
// stores. Safe to re-run: it drops and rebuilds both.

import { dataset } from "../src/config.mjs";
import { generateGraph } from "../src/generate.mjs";
import { chooseProbes } from "../src/probes.mjs";
import * as postgres from "../src/stores/postgres.mjs";
import * as neo4j from "../src/stores/neo4j.mjs";

const since = (start) => `${((performance.now() - start) / 1000).toFixed(1)}s`;

// The DAG property is the one invariant every query below depends on, and it is
// an emergent property of the generator rather than something the schema
// enforces. So it is checked rather than assumed.
function assertAcyclic(graph) {
  for (let i = 0; i < graph.edgeCount; i += 1) {
    if (graph.to[i] >= graph.from[i]) {
      throw new Error(`Generator produced a non-descending edge ${graph.from[i]} -> ${graph.to[i]}`);
    }
  }
}

function describe(graph) {
  const outDegree = new Int32Array(graph.packages);
  const inDegree = new Int32Array(graph.packages);
  for (let i = 0; i < graph.edgeCount; i += 1) {
    outDegree[graph.from[i]] += 1;
    inDegree[graph.to[i]] += 1;
  }
  let maxInDegree = 0;
  let hubs = 0;
  for (let id = 0; id < graph.packages; id += 1) {
    if (inDegree[id] > maxInDegree) maxInDegree = inDegree[id];
    if (inDegree[id] >= 100) hubs += 1;
  }
  return {
    packages: graph.packages,
    edges: graph.edgeCount,
    vulnerable: graph.vulnerableCount,
    maxLevel: graph.maxLevel,
    maxDependencies: Math.max(...outDegree),
    maxDependents: maxInDegree,
    hubsOver100Dependents: hubs,
  };
}

async function main() {
  const started = performance.now();

  console.log(`Generating ${dataset.packages} packages / ~${dataset.edges} edges (seed ${dataset.seed})...`);
  const graph = generateGraph(dataset);
  assertAcyclic(graph);
  const shape = describe(graph);
  const probes = chooseProbes(graph, dataset.maxLevel);
  console.log(`  ${JSON.stringify(shape)}`);
  console.log(`  generated and profiled in ${since(started)}`);

  const pgStart = performance.now();
  const client = await postgres.openPostgres();
  await postgres.resetSchema(client);
  await postgres.loadGraph(client, graph);
  await postgres.writeMeta(client, { dataset, shape, probes, seededAt: new Date().toISOString() });
  console.log(`Postgres loaded in ${since(pgStart)}`);

  const neoStart = performance.now();
  const driver = neo4j.openNeo4j();
  await neo4j.resetSchema(driver);
  await neo4j.loadGraph(driver, graph);
  console.log(`Neo4j loaded in ${since(neoStart)}`);

  await client.end();
  await driver.close();

  console.log("");
  console.log("Probe packages the benchmark will use:");
  console.log(`  reachability root : ${probes.reachabilityRootName} (#${probes.reachabilityRoot}), reaches ${probes.reachabilityRootClosure} packages`);
  console.log(`  blast radius hub  : ${probes.blastRadiusTargetName} (#${probes.blastRadiusTarget}), ${probes.blastRadiusTargetInDegree} direct dependents`);
  console.log(`  shortest path to  : ${probes.shortestPathTargetName} (#${probes.shortestPathTarget}), ${probes.shortestPathTargetDepth} hops down`);
  console.log("");
  console.log(`Done in ${since(started)}. Next: npm run bench`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
