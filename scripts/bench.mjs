// Runs the three questions against all three implementations at increasing
// depth limits and prints the table that goes into the README.
//
// Rules the numbers are produced under:
//
//   * Every store is warmed before it is timed, and each individual cell gets
//     its own discarded warm-up runs, so nothing is paying a first-touch cost.
//   * Many runs per cell, reported as median and fastest, never a single run.
//   * All three implementations are asked about the same packages, chosen at
//     seed time and read back from dataset_meta.
//   * Before any timing, the three implementations are run once and their
//     answers compared. A benchmark of implementations that disagree is
//     measuring two different questions.
//   * The widest run-to-run spread in each table is printed underneath it,
//     because hiding variance behind a median is how benchmarks lie.

import os from "node:os";
import { bench as benchConfig } from "../src/config.mjs";
import { markdownTable, median } from "../src/table.mjs";
import * as postgres from "../src/stores/postgres.mjs";
import * as neo4j from "../src/stores/neo4j.mjs";

const TIMEOUT = Symbol("timeout");
const POSTGRES_QUERY_CANCELED = "57014";

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

async function measure(fn) {
  try {
    // Warm this exact query shape: plan cache, page cache, and on the Neo4j
    // side the JIT. These runs are discarded.
    for (let run = 0; run < benchConfig.warmups; run += 1) await fn();
  } catch (error) {
    if (error.code === POSTGRES_QUERY_CANCELED) return { ms: TIMEOUT, value: null };
    throw error;
  }

  const samples = [];
  let value = null;
  for (let run = 0; run < benchConfig.repeats; run += 1) {
    try {
      const result = await timed(fn);
      samples.push(result.ms);
      value = result.value;
    } catch (error) {
      // A cell can be fast enough to survive the warm-up runs and still exceed
      // the timeout on a later one. That is still a timeout, not a crash.
      if (error.code === POSTGRES_QUERY_CANCELED) return { ms: TIMEOUT, value: null };
      throw error;
    }
  }
  samples.sort((a, b) => a - b);
  return { ms: median(samples), min: samples[0], max: samples[samples.length - 1], value };
}

// Each cell reports the median and the fastest of the timed runs.
//
// The median is what the brief for a benchmark normally asks for and it is
// what a reader should quote. The fastest run is reported beside it because
// this is measured on a working laptop, not an isolated benchmark host:
// contention from everything else on the machine can only ever add time, never
// remove it, so the minimum is the closest available estimate of what the query
// itself costs. When the two numbers are far apart, the environment was noisy
// and the median should be read with that in mind.
const showCell = (result) =>
  result.ms === TIMEOUT ? `>${benchConfig.timeoutMs / 1000}s` : `${result.ms.toFixed(1)} / ${result.min.toFixed(1)}`;

// Two shortest paths of equal length are equally correct, so comparing the
// paths themselves would fail for the wrong reason. What has to agree is the
// length, and each path has to actually be a path.
function normalise(kind, value) {
  if (value === null) return "none";
  if (kind === "reachability") return value.map((row) => `${row.id}@${row.depth}`).join(",");
  if (kind === "blastRadius") return String(value);
  return `length ${value.length - 1}`;
}

async function crossCheck(stores, probes, depth) {
  const questions = [
    ["reachability", (store) => store.reachability(probes.reachabilityRoot, depth)],
    ["blastRadius", (store) => store.blastRadius(probes.blastRadiusTarget, depth)],
    ["shortestPath", (store) => store.shortestPath(probes.reachabilityRoot, probes.shortestPathTarget, depth)],
  ];

  for (const [kind, ask] of questions) {
    const answers = [];
    for (const store of stores) {
      try {
        answers.push([store.name, normalise(kind, await ask(store))]);
      } catch (error) {
        if (error.code === POSTGRES_QUERY_CANCELED) {
          answers.push([store.name, "not checked (times out)"]);
          continue;
        }
        throw error;
      }
    }
    const checkable = answers.filter(([, answer]) => !answer.startsWith("not checked"));
    const distinct = new Set(checkable.map(([, answer]) => answer));
    if (distinct.size > 1) {
      console.error(`Stores disagree on ${kind} at depth ${depth}:`);
      for (const [name, answer] of answers) console.error(`  ${name}: ${answer.slice(0, 200)}`);
      process.exit(1);
    }
    console.log(`  ${kind.padEnd(13)} agreed by ${checkable.length}/${answers.length} implementations at depth ${depth}`);
  }
}

async function environment(client, driver) {
  const pgVersion = (await client.query("SHOW server_version")).rows[0].server_version;
  const session = driver.session();
  const components = await session.run("CALL dbms.components() YIELD versions RETURN versions[0] AS version");
  await session.close();
  return {
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    postgres: pgVersion,
    neo4j: components.records[0].get("version"),
  };
}

async function runQuery({ title, stores, ask, describe }) {
  const rows = [];
  const stalled = new Set();
  // The machine this runs on is a laptop, not an isolated benchmark host, and
  // the JVM adds its own variance. Reporting only a median would hide that, so
  // the widest spread seen in each table is reported underneath it.
  let widest = null;

  for (const depth of benchConfig.depths) {
    const cells = [];
    let answer = null;
    for (const store of stores) {
      if (stalled.has(store.name)) {
        cells.push(`>${benchConfig.timeoutMs / 1000}s`);
        continue;
      }
      const result = await measure(() => ask(store, depth));
      if (result.ms === TIMEOUT) {
        // A deeper limit is strictly more work, so once a store stops
        // finishing there is nothing to learn by waiting for it again.
        stalled.add(store.name);
        cells.push(`>${benchConfig.timeoutMs / 1000}s`);
        continue;
      }
      answer = result.value;
      cells.push(showCell(result));

      const spread = result.max / Math.max(result.min, 0.001);
      if (widest === null || spread > widest.spread) {
        widest = { spread, store: store.name, depth, min: result.min, max: result.max };
      }
    }
    rows.push([String(depth), ...cells, describe(answer)]);
  }

  console.log("");
  console.log(`#### ${title}`);
  console.log("");
  const headers = ["depth", ...stores.map((store) => store.name), "result"];
  console.log(markdownTable(headers, rows, { alignRight: headers.map((_, i) => i).slice(0, -1) }));
  if (widest !== null) {
    console.log("");
    console.log(
      `Widest run-to-run spread in this table: ${widest.store} at depth ${widest.depth}, ` +
        `${widest.min.toFixed(1)}-${widest.max.toFixed(1)} ms across ${benchConfig.repeats} runs (${widest.spread.toFixed(1)}x).`,
    );
  }
}

async function main() {
  const client = await postgres.openPostgres({ statementTimeoutMs: benchConfig.timeoutMs });
  const driver = neo4j.openNeo4j();

  const meta = await postgres.readMeta(client);
  const { probes, shape } = meta;

  const cte = postgres.postgresCte(client);
  const bfs = postgres.postgresBfs(client);
  const graph = neo4j.neo4jStore(driver);
  await bfs.prepare();

  const stores = [cte, bfs, graph];

  console.log("Warming both stores...");
  await graph.warm();
  await client.query("SELECT count(*) FROM depends_on");
  await client.query("SELECT count(*) FROM package");

  console.log("Checking the three implementations agree before timing them:");
  await crossCheck(stores, probes, 4);
  await crossCheck(stores, probes, 6);

  const env = await environment(client, driver);
  console.log("");
  console.log("### Benchmark");
  console.log("");
  console.log(`Dataset: ${shape.packages} packages, ${shape.edges} dependency edges, ${shape.vulnerable} marked vulnerable, ${shape.maxLevel} levels deep.`);
  console.log(`Hardware: ${env.cpu}, ${env.cores} cores, ${env.memoryGb} GB, ${env.platform}. Both stores in Docker.`);
  console.log(`Versions: Postgres ${env.postgres}, Neo4j ${env.neo4j}, Node ${env.node}.`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  console.log(`Method: ${plural(benchConfig.warmups, "discarded warm-up run")}, then ${plural(benchConfig.repeats, "timed run")}. Each cell is \`median / fastest\` in milliseconds.`);
  console.log(`Load average when this run started: ${os.loadavg().map((l) => l.toFixed(1)).join(", ")} on ${env.cores} cores.`);

  await runQuery({
    title: `Query 1 — reachability: which vulnerable packages does \`${probes.reachabilityRootName}\` pull in, and how deep?`,
    stores,
    ask: (store, depth) => store.reachability(probes.reachabilityRoot, depth),
    describe: (value) => (value === null ? "-" : `${value.length} vulnerable`),
  });

  await runQuery({
    title: `Query 2 — blast radius: how many packages transitively depend on \`${probes.blastRadiusTargetName}\`?`,
    stores,
    ask: (store, depth) => store.blastRadius(probes.blastRadiusTarget, depth),
    describe: (value) => (value === null ? "-" : `${value} dependents`),
  });

  await runQuery({
    title: `Query 3 — shortest path: the minimal dependency chain from \`${probes.reachabilityRootName}\` to \`${probes.shortestPathTargetName}\``,
    stores,
    ask: (store, depth) => store.shortestPath(probes.reachabilityRoot, probes.shortestPathTarget, depth),
    describe: (value) => (value === null ? "not reachable" : `${value.length - 1} hops`),
  });

  console.log("");
  await client.end();
  await driver.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
