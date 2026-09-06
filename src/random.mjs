// A seeded PRNG so that `npm run seed` produces the same graph on every machine.
// Reproducibility matters here: the benchmark numbers in the README are only
// meaningful if a reader can regenerate the exact graph they were measured on.

// mulberry32 — small, fast, and good enough for graph shape. Not for crypto.
export function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Draw from a Pareto (power-law) distribution with the given tail exponent.
// Returns a value >= 1; most draws sit near 1 and a few are very large, which
// is the shape real dependency counts have.
export function pareto(random, alpha) {
  return Math.pow(1 - random(), -1 / alpha);
}

// Uniform integer in [0, n).
export function randomInt(random, n) {
  return Math.floor(random() * n);
}
