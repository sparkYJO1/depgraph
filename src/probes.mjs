// Picks the packages the benchmark asks about.
//
// These are chosen once, at seed time, from the in-memory graph, and written
// into the dataset_meta row. Both stores are then asked about the same three
// packages. Choosing them per-run, or per-store, would let an unlucky draw
// decide the result.
//
// The choices are deliberately the hard cases rather than typical ones: the
// application with the largest dependency closure, the single most depended-on
// package, and the deepest vulnerability under that application. A benchmark
// run against an average package would mostly measure how quickly each store
// can return nothing.

// Compressed adjacency: `offsets[i]` .. `offsets[i+1]` indexes into `targets`.
// Building this once turns every traversal below into an array walk.
function buildAdjacency(count, from, to) {
  const offsets = new Int32Array(count + 1);
  for (let i = 0; i < from.length; i += 1) offsets[from[i] + 1] += 1;
  for (let i = 0; i < count; i += 1) offsets[i + 1] += offsets[i];

  const targets = new Int32Array(from.length);
  const cursor = Int32Array.from(offsets.subarray(0, count));
  for (let i = 0; i < from.length; i += 1) {
    targets[cursor[from[i]]] = to[i];
    cursor[from[i]] += 1;
  }
  return { offsets, targets };
}

// Breadth-first search returning the depth at which each package was first
// seen, or -1 for unreached. `stamp` avoids reallocating the depth array for
// every root when this is called in a loop.
function bfs({ offsets, targets }, root, maxDepth, depths, seenAt, stamp) {
  seenAt[root] = stamp;
  depths[root] = 0;
  let frontier = [root];
  let reached = 1;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next = [];
    for (const node of frontier) {
      for (let i = offsets[node]; i < offsets[node + 1]; i += 1) {
        const neighbour = targets[i];
        if (seenAt[neighbour] === stamp) continue;
        seenAt[neighbour] = stamp;
        depths[neighbour] = depth;
        next.push(neighbour);
        reached += 1;
      }
    }
    frontier = next;
  }
  return reached;
}

export function chooseProbes(graph, maxDepth) {
  const adjacency = buildAdjacency(graph.packages, graph.from, graph.to);
  const depths = new Int32Array(graph.packages);
  const seenAt = new Int32Array(graph.packages).fill(-1);

  // The application with the largest dependency closure.
  let reachabilityRoot = -1;
  let largestClosure = -1;
  let stamp = 0;
  for (let id = 0; id < graph.packages; id += 1) {
    if (graph.level[id] !== graph.maxLevel) continue;
    const reached = bfs(adjacency, id, maxDepth, depths, seenAt, stamp);
    stamp += 1;
    if (reached > largestClosure) {
      largestClosure = reached;
      reachabilityRoot = id;
    }
  }

  // The most depended-on package in the graph.
  const inDegree = new Int32Array(graph.packages);
  for (let i = 0; i < graph.edgeCount; i += 1) inDegree[graph.to[i]] += 1;
  let blastRadiusTarget = 0;
  for (let id = 1; id < graph.packages; id += 1) {
    if (inDegree[id] > inDegree[blastRadiusTarget]) blastRadiusTarget = id;
  }

  // The deepest vulnerability under the chosen application. A shallow target
  // would be found by any strategy and would tell us nothing.
  bfs(adjacency, reachabilityRoot, maxDepth, depths, seenAt, stamp);
  let shortestPathTarget = -1;
  let deepest = -1;
  for (let id = 0; id < graph.packages; id += 1) {
    if (seenAt[id] !== stamp || graph.vulnerable[id] !== 1 || depths[id] === 0) continue;
    if (depths[id] > deepest) {
      deepest = depths[id];
      shortestPathTarget = id;
    }
  }

  return {
    reachabilityRoot,
    reachabilityRootName: graph.names[reachabilityRoot],
    reachabilityRootClosure: largestClosure,
    blastRadiusTarget,
    blastRadiusTargetName: graph.names[blastRadiusTarget],
    blastRadiusTargetInDegree: inDegree[blastRadiusTarget],
    shortestPathTarget,
    shortestPathTargetName: shortestPathTarget === -1 ? null : graph.names[shortestPathTarget],
    shortestPathTargetDepth: deepest,
  };
}
