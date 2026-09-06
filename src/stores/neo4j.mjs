// Neo4j side of the comparison.
//
// The three questions are the same three questions. What changes is that the
// traversal strategy is something the query language can name — `ANY SHORTEST`
// and `shortestPath` are breadth-first search, requested rather than written.

import neo4jDriver from "neo4j-driver";
import { neo4j as neo4jConfig } from "../config.mjs";

// Batch sizes were measured, not guessed. Relationship creation through Cypher
// runs at roughly 7k/s at 5,000 rows per transaction and 14k/s at 50,000, so
// the larger transaction is worth the memory it holds. See
// docs/decisions/0002-loading-the-graph.md.
const NODE_BATCH = 25_000;
const EDGE_BATCH = 50_000;

export function openNeo4j() {
  return neo4jDriver.driver(
    neo4jConfig.url,
    neo4jDriver.auth.basic(neo4jConfig.user, neo4jConfig.password),
    { disableLosslessIntegers: true },
  );
}

async function run(driver, query, params = {}) {
  const session = driver.session();
  try {
    return await session.run(query, params);
  } finally {
    await session.close();
  }
}

export async function resetSchema(driver) {
  // The dataset is small enough to drop in one statement at the default sizes;
  // batching keeps it from blowing the transaction out at larger ones.
  let deleted;
  do {
    const result = await run(driver, "MATCH (n:Package) WITH n LIMIT 50000 DETACH DELETE n RETURN count(n) AS n");
    deleted = result.records[0].get("n");
  } while (deleted > 0);

  await run(
    driver,
    "CREATE CONSTRAINT package_id IF NOT EXISTS FOR (p:Package) REQUIRE p.id IS UNIQUE",
  );
  await run(driver, "CALL db.awaitIndexes(120)");
}

export async function loadGraph(driver, graph) {
  for (let start = 0; start < graph.packages; start += NODE_BATCH) {
    const end = Math.min(start + NODE_BATCH, graph.packages);
    const rows = [];
    for (let id = start; id < end; id += 1) {
      rows.push({
        id,
        name: graph.names[id],
        level: graph.level[id],
        vulnerable: graph.vulnerable[id] === 1,
      });
    }
    await run(
      driver,
      `UNWIND $rows AS row
       CREATE (:Package {id: row.id, name: row.name, level: row.level, vulnerable: row.vulnerable})`,
      { rows },
    );
  }

  for (let start = 0; start < graph.edgeCount; start += EDGE_BATCH) {
    const end = Math.min(start + EDGE_BATCH, graph.edgeCount);
    const rows = [];
    for (let i = start; i < end; i += 1) {
      rows.push({ from: graph.from[i], to: graph.to[i] });
    }
    // Both endpoint lookups hit the uniqueness constraint's index, so this is
    // two index seeks per relationship rather than a scan.
    await run(
      driver,
      `UNWIND $rows AS row
       MATCH (dependent:Package {id: row.from})
       MATCH (dependency:Package {id: row.to})
       CREATE (dependent)-[:DEPENDS_ON]->(dependency)`,
      { rows },
    );
  }
}

// A variable-length bound cannot be a query parameter in Cypher, so the depth
// is written into the query text. It is validated first and it is an integer,
// and the resulting query strings are what get cached by the planner.
function checkDepth(maxDepth) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) {
    throw new Error(`maxDepth must be an integer in 1..64, got ${maxDepth}`);
  }
  return maxDepth;
}

export function neo4jStore(driver) {
  return {
    name: "neo4j (Cypher)",

    // Pull both stores' data through the page cache before timing anything.
    async warm() {
      await run(driver, "MATCH (p:Package) RETURN count(p) AS n");
      await run(driver, "MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS n");
    },

    // `ANY SHORTEST` picks one shortest path per distinct end node, so a single
    // pattern answers "which vulnerable packages, and at what depth" — the
    // engine runs a breadth-first expansion and the depth falls out of the path
    // length. There is no equivalent to ask for in SQL.
    async reachability(root, maxDepth) {
      checkDepth(maxDepth);
      const result = await run(
        driver,
        `MATCH path = ANY SHORTEST
           (root:Package {id: $root})-[:DEPENDS_ON]->{1,${maxDepth}}(vulnerable:Package WHERE vulnerable.vulnerable)
         RETURN vulnerable.id AS id, vulnerable.name AS name, length(path) AS depth
         ORDER BY depth, id`,
        { root },
      );
      return result.records.map((record) => ({
        id: record.get("id"),
        name: record.get("name"),
        depth: record.get("depth"),
      }));
    },

    // Only the count of distinct end nodes is projected and no path is kept, so
    // the planner is free to use a pruning expansion that visits each package
    // once instead of enumerating routes to it.
    async blastRadius(target, maxDepth) {
      checkDepth(maxDepth);
      const result = await run(
        driver,
        `MATCH (target:Package {id: $target})<-[:DEPENDS_ON*1..${maxDepth}]-(dependent:Package)
         RETURN count(DISTINCT dependent) AS dependents`,
        { target },
      );
      return result.records[0].get("dependents");
    },

    // `shortestPath` between two known endpoints is a bidirectional search in
    // the engine. This is the query the whole comparison is really about.
    async shortestPath(root, target, maxDepth) {
      checkDepth(maxDepth);
      const result = await run(
        driver,
        `MATCH path = shortestPath(
           (root:Package {id: $root})-[:DEPENDS_ON*1..${maxDepth}]->(target:Package {id: $target}))
         RETURN [node IN nodes(path) | node.id] AS path`,
        { root, target },
      );
      return result.records.length === 0 ? null : result.records[0].get("path");
    },
  };
}
