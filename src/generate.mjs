// Generates a synthetic dependency graph. Nothing is downloaded; the shape is
// produced from a seed so it is identical everywhere.
//
// The shape it aims for, and why:
//
//   * It is a DAG. Real package managers permit cycles in a few corner cases,
//     but a dependency resolution that cycles is a bug, and modelling one would
//     only test the stores' cycle guards rather than their traversal.
//   * Packages sit on levels. Level 0 packages have no dependencies (leaf
//     utilities); a package on level k depends only on packages below it. This
//     is what bounds the depth at a known number instead of leaving it to
//     chance, so "reachability to depth 8" means something.
//   * There are far more low-level packages than high-level ones. Registries
//     have a small number of applications sitting on a very large base.
//   * Dependency targets are chosen by preferential attachment: a package that
//     is already depended on is more likely to be depended on again. That is
//     what produces hubs — the handful of packages that almost everything
//     reaches — without hand-placing them.
//   * Out-degree is drawn from a power law, so most packages declare one or two
//     dependencies and a few declare dozens.
//
// docs/decisions/0001-synthetic-graph-shape.md records where this is not
// realistic.

import { makeRandom, pareto, randomInt } from "./random.mjs";

// No real package declares hundreds of direct dependencies; the tail is long
// but not unbounded.
const MAX_OUT_DEGREE = 64;

// Tail exponent of the out-degree power law. Chosen so that, once scaled to the
// requested edge budget, the most common dependency counts are one and two and
// roughly a tenth of packages declare ten or more — close to what the npm
// registry looks like.
const OUT_DEGREE_TAIL = 1.1;

// Share of dependency picks made by popularity rather than uniformly.
//
// The first version of this generator drew from a single pool in which every
// package appeared once to begin with and once more per dependent it acquired.
// The initial appearances swamped the popularity signal and the most
// depended-on package in the whole graph ended up with 52 dependents — no hubs
// at all. Separating the two pools and taking 85% of draws from the
// popularity-weighted one raised that to roughly 1,100.
const PREFERENTIAL_SHARE = 0.85;

// A duplicate draw wastes a dependency slot. Retrying a bounded number of times
// keeps the realised edge count near the requested one without risking a spin
// when a level is nearly exhausted.
const MAX_DRAW_RETRIES = 8;

const NAME_HEADS = [
  "async", "bright", "cobalt", "delta", "ember", "flux", "gravel", "helix",
  "indigo", "jasper", "kilo", "lumen", "mica", "nimbus", "onyx", "prism",
  "quartz", "raster", "slate", "tundra", "umber", "vector", "willow", "xenon",
  "yarrow", "zephyr",
];

const NAME_TAILS = [
  "core", "utils", "kit", "parse", "stream", "cache", "codec", "fmt", "loader",
  "router", "schema", "queue", "pool", "diff", "trace", "guard", "shim",
  "bridge", "store", "watch",
];

// Level sizes decay geometrically: many leaves, few applications.
function levelSizes(packages, maxLevel) {
  const weights = [];
  for (let level = 0; level <= maxLevel; level += 1) {
    weights.push(Math.exp(-level / 3));
  }
  const total = weights.reduce((a, b) => a + b, 0);

  const sizes = weights.map((w) => Math.max(1, Math.floor((w / total) * packages)));
  // Hand any rounding remainder to level 0; it is the largest bucket and least
  // sensitive to a few extra members.
  const assigned = sizes.reduce((a, b) => a + b, 0);
  sizes[0] += packages - assigned;
  return sizes;
}

function buildNames(count, random) {
  const names = new Array(count);
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const head = NAME_HEADS[randomInt(random, NAME_HEADS.length)];
    const tail = NAME_TAILS[randomInt(random, NAME_TAILS.length)];
    let name = `${head}-${tail}`;
    // Names must be unique because they are the human-facing handle in the demo
    // output, and a unique index enforces it in Postgres.
    if (seen.has(name)) name = `${name}-${i}`;
    seen.add(name);
    names[i] = name;
  }
  return names;
}

// Out-degrees for every package that has dependencies at all.
//
// A raw Pareto draw has the right shape but the wrong scale: its mean depends
// on the tail exponent, not on the edge budget the caller asked for. So the
// draws are scaled by a single multiplier, and that multiplier is found by
// binary search over the realised total after flooring and capping. This keeps
// the distribution's shape (most packages declare one or two dependencies)
// while landing on the requested edge count for any configured size.
function drawOutDegrees(firstWithDeps, packages, edges, random) {
  const raw = new Float64Array(packages);
  for (let id = firstWithDeps; id < packages; id += 1) {
    raw[id] = pareto(random, OUT_DEGREE_TAIL);
  }

  const totalAt = (scale) => {
    let total = 0;
    for (let id = firstWithDeps; id < packages; id += 1) {
      total += Math.min(MAX_OUT_DEGREE, Math.max(1, Math.floor(raw[id] * scale)));
    }
    return total;
  };

  let low = 0;
  let high = 64;
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (totalAt(mid) < edges) low = mid;
    else high = mid;
  }
  const scale = (low + high) / 2;

  const degrees = new Int32Array(packages);
  for (let id = firstWithDeps; id < packages; id += 1) {
    degrees[id] = Math.min(MAX_OUT_DEGREE, Math.max(1, Math.floor(raw[id] * scale)));
  }
  return degrees;
}

export function generateGraph({ packages, edges, maxLevel, vulnerableRate, seed }) {
  const random = makeRandom(seed);

  const sizes = levelSizes(packages, maxLevel);

  // Ids are handed out level by level, so a package's id is always greater than
  // every id it depends on. That invariant is what makes the graph acyclic, and
  // seed.mjs asserts it rather than trusting this comment.
  const level = new Int8Array(packages);
  const levelStart = [];
  let cursor = 0;
  for (let l = 0; l <= maxLevel; l += 1) {
    levelStart.push(cursor);
    level.fill(l, cursor, cursor + sizes[l]);
    cursor += sizes[l];
  }
  levelStart.push(cursor);

  // Two pools per level drive dependency target selection.
  //
  //   members[l]   — every package on level l, exactly once. Drawing from this
  //                  is a uniform pick.
  //   popular[l]   — a package appended once for every dependent it has picked
  //                  up so far. Drawing from this is a pick weighted by current
  //                  in-degree, which is what grows hubs.
  //
  // Mixing the two (PREFERENTIAL_SHARE of draws from `popular`) gives a
  // power-law in-degree with a heavy enough tail to contain genuine hubs.
  // Drawing only from `popular` would need seeding and produces a steeper tail;
  // drawing only from `members` gives a Poisson degree distribution with no
  // hubs at all, which is the shape this benchmark exists to avoid.
  const members = [];
  const popular = [];
  for (let l = 0; l <= maxLevel; l += 1) {
    const bucket = new Array(sizes[l]);
    for (let i = 0; i < sizes[l]; i += 1) bucket[i] = levelStart[l] + i;
    members.push(bucket);
    popular.push([]);
  }

  const firstWithDeps = levelStart[1];
  const degrees = drawOutDegrees(firstWithDeps, packages, edges, random);

  const from = [];
  const to = [];
  const chosen = new Set();

  for (let id = firstWithDeps; id < packages; id += 1) {
    const myLevel = level[id];
    const wanted = Math.min(degrees[id], levelStart[myLevel]);
    chosen.clear();

    for (let slot = 0; slot < wanted; slot += 1) {
      for (let attempt = 0; attempt < MAX_DRAW_RETRIES; attempt += 1) {
        // The first dependency always comes from the level immediately below,
        // so every package genuinely sits one level deeper than something.
        // Without this, high-level packages could shortcut straight to leaves
        // and the graph's real depth would fall well short of maxLevel.
        // After that, favour the level just below but allow a jump anywhere.
        let targetLevel;
        if (slot === 0 || random() < 0.6) targetLevel = myLevel - 1;
        else targetLevel = randomInt(random, myLevel);

        const pool = popular[targetLevel];
        const target =
          pool.length > 0 && random() < PREFERENTIAL_SHARE
            ? pool[randomInt(random, pool.length)]
            : members[targetLevel][randomInt(random, members[targetLevel].length)];

        if (chosen.has(target)) continue; // a package depends on another at most once

        chosen.add(target);
        from.push(id);
        to.push(target);
        pool.push(target); // one more appearance => more likely to be picked next time
        break;
      }
    }
  }

  const vulnerable = new Uint8Array(packages);
  let vulnerableCount = 0;
  for (let id = 0; id < packages; id += 1) {
    if (random() < vulnerableRate) {
      vulnerable[id] = 1;
      vulnerableCount += 1;
    }
  }

  return {
    packages,
    maxLevel,
    names: buildNames(packages, random),
    level,
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    vulnerable,
    vulnerableCount,
    edgeCount: from.length,
  };
}
