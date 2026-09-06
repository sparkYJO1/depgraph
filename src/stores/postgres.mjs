// Postgres side of the comparison.
//
// Two stores come out of this file, sharing one connection:
//
//   postgresCte — the query you would actually write first. A single
//                 WITH RECURSIVE statement per question.
//   postgresBfs — the same three questions answered by a hand-written
//                 breadth-first search: one set-based statement per level,
//                 driven from the application, with a visited set in a
//                 temporary table.
//
// Both are here because reporting only the first would be a rigged benchmark.
// docs/decisions/0003-is-the-benchmark-fair.md explains what separates them.

import { readFileSync } from "node:fs";
import pg from "pg";
import { postgres as pgConfig } from "../config.mjs";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

const PACKAGE_BATCH = 10_000;
const EDGE_BATCH = 25_000;

export async function openPostgres({ statementTimeoutMs } = {}) {
  const client = new pg.Client(pgConfig);
  await client.connect();
  if (statementTimeoutMs) {
    await client.query(`SET statement_timeout = ${Number(statementTimeoutMs)}`);
  }
  return client;
}

export async function resetSchema(client) {
  await client.query("DROP TABLE IF EXISTS depends_on, package, dataset_meta");
  await client.query(SCHEMA);
}

export async function loadGraph(client, graph) {
  for (let start = 0; start < graph.packages; start += PACKAGE_BATCH) {
    const end = Math.min(start + PACKAGE_BATCH, graph.packages);
    const ids = [];
    const names = [];
    const levels = [];
    const vulnerable = [];
    for (let id = start; id < end; id += 1) {
      ids.push(id);
      names.push(graph.names[id]);
      levels.push(graph.level[id]);
      vulnerable.push(graph.vulnerable[id] === 1);
    }
    await client.query(
      `INSERT INTO package (id, name, level, vulnerable)
       SELECT * FROM unnest($1::integer[], $2::text[], $3::smallint[], $4::boolean[])`,
      [ids, names, levels, vulnerable],
    );
  }

  for (let start = 0; start < graph.edgeCount; start += EDGE_BATCH) {
    const end = Math.min(start + EDGE_BATCH, graph.edgeCount);
    await client.query(
      `INSERT INTO depends_on (pkg_id, dep_id)
       SELECT * FROM unnest($1::integer[], $2::integer[])`,
      [Array.from(graph.from.subarray(start, end)), Array.from(graph.to.subarray(start, end))],
    );
  }

  // Without fresh statistics the planner has no idea how big these tables are
  // and picks plans that make the benchmark measure the planner's guess rather
  // than the database.
  await client.query("VACUUM ANALYZE package, depends_on");
}

export async function writeMeta(client, info) {
  await client.query(
    `INSERT INTO dataset_meta (info) VALUES ($1)
     ON CONFLICT (only_row) DO UPDATE SET info = excluded.info`,
    [JSON.stringify(info)],
  );
}

export async function readMeta(client) {
  const { rows } = await client.query("SELECT info FROM dataset_meta");
  if (rows.length === 0) {
    throw new Error("No dataset found. Run `npm run seed` first.");
  }
  return rows[0].info;
}

// Depth limits reach Postgres as bind parameters, never as interpolated text —
// the only strings built into SQL below are the two column names chosen by a
// boolean. This check exists because a depth of zero or a negative depth would
// silently return an empty answer rather than an error, and a caller passing
// one has a bug worth surfacing.
function checkDepth(maxDepth) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) {
    throw new Error(`maxDepth must be an integer in 1..64, got ${maxDepth}`);
  }
  return maxDepth;
}

// ---------------------------------------------------------------------------
// Store 1: the idiomatic recursive CTE.
// ---------------------------------------------------------------------------

export function postgresCte(client) {
  return {
    name: "postgres (recursive CTE)",

    // Which vulnerable packages does `root` pull in, and how deep?
    //
    // The subtlety is in UNION rather than UNION ALL. UNION deduplicates the
    // recursive term against every row produced so far, which is what stops
    // this walking the graph forever. But it deduplicates whole rows, and the
    // row carries `depth` — so a package reachable at depth 3 and again at
    // depth 5 is two distinct rows and gets expanded twice. Dropping `depth`
    // would fix that and also make the question unanswerable. That trade is the
    // heart of this comparison.
    async reachability(root, maxDepth) {
      checkDepth(maxDepth);
      const { rows } = await client.query(
        `WITH RECURSIVE reachable (id, depth) AS (
             SELECT $1::integer, 0
           UNION
             SELECT edge.dep_id, reachable.depth + 1
             FROM reachable
             JOIN depends_on edge ON edge.pkg_id = reachable.id
             WHERE reachable.depth < $2
         )
         SELECT package.id, package.name, min(reachable.depth) AS depth
         FROM reachable
         JOIN package ON package.id = reachable.id
         WHERE package.vulnerable AND reachable.depth > 0
         GROUP BY package.id, package.name
         ORDER BY depth, package.id`,
        [root, maxDepth],
      );
      return rows.map((row) => ({ id: row.id, name: row.name, depth: Number(row.depth) }));
    },

    // If this package is compromised, how many packages transitively depend on
    // it? Same walk, following the edge backwards.
    async blastRadius(target, maxDepth) {
      checkDepth(maxDepth);
      const { rows } = await client.query(
        `WITH RECURSIVE dependents (id, depth) AS (
             SELECT $1::integer, 0
           UNION
             SELECT edge.pkg_id, dependents.depth + 1
             FROM dependents
             JOIN depends_on edge ON edge.dep_id = dependents.id
             WHERE dependents.depth < $2
         )
         SELECT count(DISTINCT id) AS dependents FROM dependents WHERE depth > 0`,
        [target, maxDepth],
      );
      return Number(rows[0].dependents);
    },

    // The minimal dependency chain from root to a given package.
    //
    // This is where the recursive CTE runs out of road. To return a path you
    // have to carry the path, and once the path is in the row no two rows are
    // ever duplicates, so UNION deduplicates nothing: the query enumerates
    // every simple path rather than every reachable node. It is correct and it
    // is exponential. The benchmark runs it under a statement timeout and
    // reports where it stops finishing, because that number is the argument.
    async shortestPath(root, target, maxDepth) {
      checkDepth(maxDepth);
      const { rows } = await client.query(
        `WITH RECURSIVE walk (id, path, depth) AS (
             SELECT $1::integer, ARRAY[$1::integer], 0
           UNION ALL
             SELECT edge.dep_id, walk.path || edge.dep_id, walk.depth + 1
             FROM walk
             JOIN depends_on edge ON edge.pkg_id = walk.id
             WHERE walk.depth < $3 AND NOT edge.dep_id = ANY (walk.path)
         )
         SELECT path FROM walk WHERE id = $2 ORDER BY depth LIMIT 1`,
        [root, target, maxDepth],
      );
      return rows.length === 0 ? null : rows[0].path;
    },
  };
}

// ---------------------------------------------------------------------------
// Store 2: breadth-first search, one statement per level.
// ---------------------------------------------------------------------------

// Every level of the search is a single set-based statement, so the number of
// round trips is the depth limit and not the number of nodes.
//
// The visited set lives in a session temporary table and doubles as the
// frontier: the rows written at depth d-1 are exactly the frontier for depth d,
// so no second table is needed. The statement reads from the same table it
// writes to, which is safe because the SELECT sees the snapshot taken when the
// statement began and cannot see its own inserts.
//
// ON CONFLICT DO NOTHING turns "have I already seen this package" into a
// primary-key probe. That single check is what the recursive CTE cannot
// express, and it is the whole difference between the two Postgres columns.
//
// The table is emptied with TRUNCATE rather than DELETE. The first version used
// DELETE, because DELETE measured at 0.4 ms against TRUNCATE's 4 ms — but that
// measurement was taken against an empty table and was worthless. Temporary
// tables are never autovacuumed, so DELETE leaves dead tuples behind forever:
// over sixty searches the table grew from 960 KB to 31 MB and this store's
// times drifted from 124 ms to 228 ms. TRUNCATE replaces the file and holds it
// flat at 960 KB. The 4 ms is a real fixed cost per search and it is why this
// store never wins at depth 2.
const BFS_SETUP = `
  CREATE TEMP TABLE IF NOT EXISTS bfs_visited (id integer PRIMARY KEY, depth integer NOT NULL);
  CREATE INDEX IF NOT EXISTS bfs_visited_depth_idx ON bfs_visited (depth);
`;

export function postgresBfs(client) {
  // `forward` walks pkg_id -> dep_id (into dependencies); the reverse walks
  // dep_id -> pkg_id (into dependents). Only the join columns differ, so the
  // two directions share one implementation.
  async function search(root, maxDepth, { forward, stopAt = null }) {
    checkDepth(maxDepth);
    const [from, to] = forward ? ["pkg_id", "dep_id"] : ["dep_id", "pkg_id"];

    await client.query("TRUNCATE bfs_visited");
    await client.query("INSERT INTO bfs_visited (id, depth) VALUES ($1, 0)", [root]);

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      // RETURNING is only asked for when there is a target to watch out for;
      // otherwise the newly discovered ids would be shipped to the client for
      // nothing.
      const discovered = await client.query(
        `INSERT INTO bfs_visited (id, depth)
         SELECT DISTINCT edge.${to}, $1::integer
         FROM bfs_visited frontier
         JOIN depends_on edge ON edge.${from} = frontier.id
         WHERE frontier.depth = $1::integer - 1
         ON CONFLICT (id) DO NOTHING
         ${stopAt === null ? "" : "RETURNING id"}`,
        [depth],
      );
      if (discovered.rowCount === 0) return; // the walk is exhausted
      if (stopAt !== null && discovered.rows.some((row) => row.id === stopAt)) return;
    }
  }

  return {
    name: "postgres (BFS)",

    async prepare() {
      await client.query(BFS_SETUP);
    },

    async reachability(root, maxDepth) {
      await search(root, maxDepth, { forward: true });
      const { rows } = await client.query(
        `SELECT package.id, package.name, bfs_visited.depth
         FROM bfs_visited
         JOIN package ON package.id = bfs_visited.id
         WHERE package.vulnerable AND bfs_visited.depth > 0
         ORDER BY bfs_visited.depth, package.id`,
      );
      return rows.map((row) => ({ id: row.id, name: row.name, depth: Number(row.depth) }));
    },

    async blastRadius(target, maxDepth) {
      await search(target, maxDepth, { forward: false });
      const { rows } = await client.query("SELECT count(*) AS dependents FROM bfs_visited WHERE depth > 0");
      return Number(rows[0].dependents);
    },

    // Breadth-first search reaches the target at its minimum depth, so the
    // search can stop the moment it appears. The path is then read back by
    // stepping from the target to any predecessor one level shallower — the
    // visited table already holds every level, so this is `depth` index lookups
    // and no further traversal.
    async shortestPath(root, target, maxDepth) {
      if (root === target) return [root];
      await search(root, maxDepth, { forward: true, stopAt: target });
      const found = await client.query("SELECT depth FROM bfs_visited WHERE id = $1", [target]);
      if (found.rowCount === 0) return null;

      const path = [target];
      for (let depth = Number(found.rows[0].depth); depth > 0; depth -= 1) {
        const { rows } = await client.query(
          `SELECT edge.pkg_id
           FROM depends_on edge
           JOIN bfs_visited ON bfs_visited.id = edge.pkg_id
           WHERE edge.dep_id = $1 AND bfs_visited.depth = $2
           LIMIT 1`,
          [path[0], depth - 1],
        );
        if (rows.length === 0) throw new Error(`No predecessor for ${path[0]} at depth ${depth - 1}`);
        path.unshift(rows[0].pkg_id);
      }
      return path;
    },
  };
}
