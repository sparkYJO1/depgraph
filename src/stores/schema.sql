-- The whole model. Two tables: what a package is, and what depends on what.
--
-- `depends_on` is the entire graph. Direction is "pkg_id depends on dep_id", so
-- following pkg_id -> dep_id walks *down* into dependencies (reachability) and
-- following dep_id -> pkg_id walks *up* into dependents (blast radius). Both
-- directions are traversed by the queries, so both columns are indexed: the
-- primary key serves the downward walk and depends_on_dep_idx serves the
-- upward one. Without the second index the blast-radius query degrades to a
-- sequential scan per level and the comparison stops being about traversal.

CREATE TABLE IF NOT EXISTS package (
  id         integer  PRIMARY KEY,
  name       text     NOT NULL UNIQUE,
  level      smallint NOT NULL,
  vulnerable boolean  NOT NULL
);

CREATE TABLE IF NOT EXISTS depends_on (
  pkg_id integer NOT NULL REFERENCES package (id),
  dep_id integer NOT NULL REFERENCES package (id),
  PRIMARY KEY (pkg_id, dep_id)
);

CREATE INDEX IF NOT EXISTS depends_on_dep_idx ON depends_on (dep_id);

-- Vulnerable packages are a fraction of a percent of the table, so a partial
-- index is small and the reachability queries can look one up without touching
-- the rest.
CREATE INDEX IF NOT EXISTS package_vulnerable_idx ON package (id) WHERE vulnerable;

-- One row, holding the generator settings and the probe nodes the benchmark
-- uses. Written by the seed and read by the benchmark, so both stores are
-- always asked about the same packages and a re-seed at a different scale
-- cannot silently be measured against stale probes.
CREATE TABLE IF NOT EXISTS dataset_meta (
  only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  info     jsonb   NOT NULL
);
