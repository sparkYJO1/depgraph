// Every knob in one place. Environment variables let the benchmark be re-run at
// a different scale without editing code.

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return value;
};

export const dataset = {
  packages: int("DEPGRAPH_PACKAGES", 50_000),
  edges: int("DEPGRAPH_EDGES", 200_000),
  maxLevel: int("DEPGRAPH_MAX_LEVEL", 10),
  vulnerableRate: num("DEPGRAPH_VULNERABLE_RATE", 0.005),
  seed: int("DEPGRAPH_SEED", 20260906),
};

export const postgres = {
  host: process.env.PGHOST ?? "localhost",
  port: int("PGPORT", 55433),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres",
  database: process.env.PGDATABASE ?? "depgraph",
};

export const neo4j = {
  url: process.env.NEO4J_URL ?? "bolt://localhost:57687",
  user: process.env.NEO4J_USER ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "depgraph123",
};

export const bench = {
  depths: (process.env.DEPGRAPH_DEPTHS ?? "2,4,6,8,10").split(",").map((d) => Number(d.trim())),
  repeats: int("DEPGRAPH_REPEATS", 21),
  // Neo4j runs on the JVM and the first few executions of a query shape are
  // measurably slower than the rest. Three warm-up runs per cell, discarded.
  warmups: int("DEPGRAPH_WARMUPS", 3),
  // The naive path-enumerating SQL below is exponential. Without a ceiling a
  // single cell of the table would run for hours, so it is cut off and the
  // table records the cut-off rather than a number.
  timeoutMs: int("DEPGRAPH_TIMEOUT_MS", 15_000),
};
