// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works
// ------------
// A generated level is a hallway with independent rooms off it: a box can never leave its room
// (the only way out is a push through the door into the hallway, where no goal is reachable), so
// the level's push optimum is the sum of its rooms' optima. This solver finds that structure on
// its own: squares of the player's row from which no box can be pushed to any goal are hallway
// squares; cutting them out of the floor leaves one component per room.
//
// Each room is then solved exactly, with an A* search over pushes (not steps):
//   - a state is the room's box squares plus the lowest square of the player's reachable region,
//     so walks between pushes cost nothing and are never searched;
//   - the estimate is a minimum-cost matching between boxes and goals, costed by true push
//     distances (a pull BFS from each goal over the room), which is admissible;
//   - pushes that land a box on a square no goal is reachable from are pruned as dead, and so
//     are pushes after which some box is frozen (held by an immovable neighbour on one
//     horizontal and one vertical side) away from its goal.
// The player walks to each room's door, the room's pushes are played, and the walks and pushes of
// every room are concatenated into the level's move string. If a level does not decompose into
// rooms, the same push A* runs on the whole level instead.
//
// Everything is budgeted by counted work (states expanded), never by the clock, and every tie is
// broken by a fixed rule, so two runs of the program write byte-identical answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions as index deltas once the board width is known: u, d, l, r (fixed order).
const DIR_LETTERS = ['u', 'd', 'l', 'r'];

// Work budgets, in states expanded: counted work, never time, so runs are reproducible.
const ROOM_EXPANSION_CAP = 600_000;
const LEVEL_EXPANSION_CAP = 250_000;

/** A level in XSB text: width, height, walls (the outer frame forced to wall), goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Push distances to one goal: dist[x] is the fewest pushes that move a box from square x to the
 * goal, ignoring the other boxes (the player may stand on any square of standMask, a box may rest
 * on any square of boxMask). Computed by pulling the box backwards from the goal: a box at x came
 * from x - d by a push along d, with the player standing at x - 2d. -1 where unreachable.
 */
function pushDistancesTo(w, wall, boxMask, standMask, goal) {
  const dist = new Int32Array(wall.length).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  const deltas = [-w, w, -1, 1];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of deltas) {
      const y = x - d;
      const stand = x - 2 * d;
      if (y < 0 || y >= wall.length || stand < 0 || stand >= wall.length) continue;
      if (dist[y] !== -1 || !boxMask[y] || wall[y] || !standMask[stand] || wall[stand]) continue;
      dist[y] = dist[x] + 1;
      queue.push(y);
    }
  }
  return dist;
}

/** The squares from which a box can be pushed to some goal of the whole level (dead-square test). */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const all = new Uint8Array(wall.length).fill(1);
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [];
  for (const g of goals) {
    dist[g] = 0;
    queue.push(g);
  }
  const deltas = [-w, w, -1, 1];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of deltas) {
      const y = x - d;
      const stand = x - 2 * d;
      if (y < 0 || y >= wall.length || stand < 0 || stand >= wall.length) continue;
      if (dist[y] !== -1 || wall[y] || wall[stand]) continue;
      dist[y] = dist[x] + 1;
      queue.push(y);
    }
  }
  return dist;
}

/**
 * The level's rooms, or null when the level is not a set of rooms. The hallway is the player's
 * row: its squares no box can be pushed from to a goal are cut out of the floor, and each
 * component left that holds boxes is a room, with the cut squares beside it as its doors.
 */
function roomsOf(level, live) {
  const { w, wall, goals, boxes, player } = level;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && live[i] < 0) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const comps = [];
  const deltas = [-w, w, -1, 1];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = comps.length;
    for (let i = 0; i < squares.length; i++) {
      for (const d of deltas) {
        const q = squares[i] + d;
        if (q < 0 || q >= wall.length || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = comps.length;
        squares.push(q);
      }
    }
    comps.push({ squares, boxes: [], goals: [], doors: [] });
  }
  for (const b of boxes) comps[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    comps[part[g]].goals.push(g);
  }
  if (comps.some((c) => c.boxes.length !== c.goals.length)) return null;
  const rooms = comps.filter((c) => c.boxes.length > 0);
  for (const room of rooms) {
    const inRoom = new Set(room.squares);
    for (const s of room.squares) {
      for (const d of deltas) {
        const q = s + d;
        if (q >= 0 && q < wall.length && cut[q] && !room.doors.includes(q)) room.doors.push(q);
      }
    }
    if (room.doors.length === 0) return null;
    room.doors.sort((a, b) => a - b);
    void inRoom;
  }
  return rooms;
}

/** Minimum-cost assignment of boxes to goals from a cost matrix (bitmask DP over goal subsets). */
function matchingCost(cost, nBoxes, nGoals) {
  const INF = Number.POSITIVE_INFINITY;
  let dp = new Float64Array(1 << nGoals).fill(INF);
  dp[0] = 0;
  for (let mask = 0; mask < dp.length; mask++) {
    const b = popcount(mask);
    if (b >= nBoxes || dp[mask] === INF) continue;
    for (let g = 0; g < nGoals; g++) {
      if (mask & (1 << g)) continue;
      const c = cost[b * nGoals + g];
      if (c < 0) continue;
      const next = mask | (1 << g);
      if (dp[mask] + c < dp[next]) dp[next] = dp[mask] + c;
    }
  }
  let best = INF;
  for (let mask = 0; mask < dp.length; mask++) {
    if (popcount(mask) === nBoxes && dp[mask] < best) best = dp[mask];
  }
  return best;
}

function popcount(x) {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

/**
 * A push search over one region of the board: an A* (or, with greedy=true, a best-first search)
 * over box configurations. regionMask bounds where boxes may rest and where the player may stand;
 * boxMask bounds where boxes may rest (a subset of regionMask: boxes never leave through a door).
 * Returns { pushes, sequence: [{from, to, dir}] } or null when the work budget runs out.
 */
function pushSearch(level, regionMask, boxMask, goals, startBoxes, playerStart, cap, greedy) {
  const { w, wall } = level;
  const size = wall.length;
  const deltas = [-w, w, -1, 1];
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  // Push distances from every square to every goal, for the matching estimate and the dead test.
  const dists = goals.map((g) => pushDistancesTo(w, wall, boxMask, regionMask, g));
  const nB = startBoxes.length;
  const nG = goals.length;
  const cost = new Float64Array(nB * nG);
  const estimate = (boxes) => {
    if (nB <= 8) {
      for (let b = 0; b < nB; b++) {
        for (let g = 0; g < nG; g++) cost[b * nG + g] = dists[g][boxes[b]];
      }
      return matchingCost(cost, nB, nG);
    }
    let sum = 0;
    for (let b = 0; b < nB; b++) {
      let m = -1;
      for (let g = 0; g < nG; g++) {
        const d = dists[g][boxes[b]];
        if (d >= 0 && (m < 0 || d < m)) m = d;
      }
      if (m < 0) return Number.POSITIVE_INFINITY;
      sum += m;
    }
    return sum;
  };
  const occupied = new Uint8Array(size);
  // Freeze deadlock: a box with an immovable neighbour (a wall, or a box already known frozen) on
  // one horizontal side and one vertical side can never move again: to move it either way along an
  // axis, the box beside it on that axis would have to move or be stood through. Computed to a
  // fixpoint over the configuration currently in `occupied`; a frozen box off its goal is dead.
  const frozenStamp = new Int32Array(size);
  let frozenCounter = 0;
  const frozenDeadlock = (boxesNow) => {
    frozenCounter++;
    const mark = frozenCounter;
    let changed = true;
    while (changed) {
      changed = false;
      for (const bx of boxesNow) {
        if (frozenStamp[bx] === mark) continue;
        const hBlock =
          wall[bx - 1] || (occupied[bx - 1] && frozenStamp[bx - 1] === mark) ||
          wall[bx + 1] || (occupied[bx + 1] && frozenStamp[bx + 1] === mark);
        if (!hBlock) continue;
        const vBlock =
          wall[bx - w] || (occupied[bx - w] && frozenStamp[bx - w] === mark) ||
          wall[bx + w] || (occupied[bx + w] && frozenStamp[bx + w] === mark);
        if (!vBlock) continue;
        frozenStamp[bx] = mark;
        changed = true;
      }
    }
    return boxesNow.some((bx) => frozenStamp[bx] === mark && !goalSet[bx]);
  };
  // Two stamp fields: one for the region of the state being expanded (its marks must survive
  // while children are generated), one for the regions of the children it makes.
  const seenA = new Int32Array(size);
  const seenB = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;
  const stack = new Int32Array(size);
  // Flood the player's reachable region (inside regionMask, boxes in the way) into a stamp field;
  // returns the region's lowest square.
  const floodInto = (seen, stamp, from) => {
    let low = from;
    let n = 0;
    stack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      for (const d of deltas) {
        const q = p + d;
        if (q < 0 || q >= size || wall[q] || !regionMask[q] || occupied[q] || seen[q] === stamp) continue;
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
    return low;
  };
  const keyOf = (boxes, rep) => rep + '|' + boxes.join(',');
  // Nodes in arrays; the heap orders by (f, then deeper g first, then insertion order).
  const nodeBoxes = [startBoxes.slice()];
  const nodePlayer = [playerStart];
  const nodeG = [0];
  const nodeParent = [-1];
  const nodeFrom = [-1];
  const nodeTo = [-1];
  const nodeDir = [-1];
  const best = new Map();
  const heap = [];
  const lastH = [estimate(startBoxes)];
  const less = (a, b) => {
    const fa = greedy ? lastH[a] : nodeG[a] + lastH[a];
    const fb = greedy ? lastH[b] : nodeG[b] + lastH[b];
    if (fa !== fb) return fa < fb;
    if (nodeG[a] !== nodeG[b]) return nodeG[a] > nodeG[b];
    return a < b;
  };
  if (!Number.isFinite(lastH[0])) return null;
  for (const b of startBoxes) occupied[b] = 1;
  best.set(keyOf(startBoxes, floodInto(seenB, ++stampB, playerStart)), 0);
  for (const b of startBoxes) occupied[b] = 0;
  heap.push(0);
  const heapPush = (v) => {
    let i = heap.length;
    heap.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const cur = heapPop();
    const boxes = nodeBoxes[cur];
    if (boxes.every((b) => goalSet[b])) {
      found = cur;
      break;
    }
    if (++expanded > cap) return null;
    for (const b of boxes) occupied[b] = 1;
    floodInto(seenA, ++stampA, nodePlayer[cur]);
    const here = stampA;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const d = deltas[di];
        const dest = b + d;
        const stand = b - d;
        if (seenA[stand] !== here) continue;
        if (dest < 0 || dest >= size || wall[dest] || !boxMask[dest] || occupied[dest]) continue;
        // Dead push: from dest no goal is reachable at all.
        let dead = true;
        for (let g = 0; g < nG; g++) {
          if (dists[g][dest] >= 0) {
            dead = false;
            break;
          }
        }
        if (dead) continue;
        const next = boxes.slice();
        next[bi] = dest;
        next.sort((a, b2) => a - b2);
        occupied[b] = 0;
        occupied[dest] = 1;
        if (frozenDeadlock(next)) {
          occupied[dest] = 0;
          occupied[b] = 1;
          continue;
        }
        const rep = floodInto(seenB, ++stampB, b);
        occupied[dest] = 0;
        occupied[b] = 1;
        const key = keyOf(next, rep);
        const gNext = nodeG[cur] + 1;
        const seen = best.get(key);
        if (seen !== undefined && seen <= gNext) continue;
        const h = estimate(next);
        if (!Number.isFinite(h)) continue;
        best.set(key, gNext);
        const idx = nodeBoxes.length;
        nodeBoxes.push(next);
        nodePlayer.push(b);
        nodeG.push(gNext);
        nodeParent.push(cur);
        nodeFrom.push(b);
        nodeTo.push(dest);
        nodeDir.push(di);
        lastH.push(h);
        heapPush(idx);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  const sequence = [];
  for (let s = found; s > 0; s = nodeParent[s]) {
    sequence.push({ from: nodeFrom[s], to: nodeTo[s], dir: nodeDir[s] });
  }
  sequence.reverse();
  return { pushes: sequence.length, sequence };
}

/** The shortest walk from `from` to `to` over floor, boxes in the way; '' when already there. */
function walkMoves(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return { moves: '', end: from };
  const deltas = [-w, w, -1, 1];
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let di = 0; di < 4; di++) {
      const q = p + deltas[di];
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = di;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let moves = '';
  for (let p = to; p !== from; p = prev[p]) moves = DIR_LETTERS[how[p]] + moves;
  return { moves, end: to };
}

/** Play a push sequence out into moves, walking between pushes; returns the moves and end state. */
function playSequence(level, boxes, player, sequence) {
  const { w } = level;
  const deltas = [-w, w, -1, 1];
  const occupied = new Uint8Array(level.wall.length);
  const cur = boxes.slice();
  let moves = '';
  let p = player;
  for (const step of sequence) {
    for (const b of cur) occupied[b] = 1;
    const stand = step.from - deltas[step.dir];
    const walk = walkMoves(level, occupied, p, stand);
    for (const b of cur) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk.moves + DIR_LETTERS[step.dir].toUpperCase();
    cur[cur.indexOf(step.from)] = step.to;
    p = step.from;
  }
  return { moves, player: p, boxes: cur };
}

/** Solve one level to a move string ('' when nothing better is found). */
function solveLevel(text) {
  const level = parseLevel(text);
  const { wall, goals, boxes, player } = level;
  if (boxes.length === 0) return '';
  const size = wall.length;
  const occupied = new Uint8Array(size);
  const live = liveSquares(level);
  const rooms = roomsOf(level, live);
  if (rooms !== null) {
    let moves = '';
    let p = player;
    const curBoxes = boxes.slice();
    for (const room of rooms) {
      // Walk to the room's first door square, every box as it stands in the way.
      for (const b of curBoxes) occupied[b] = 1;
      const transit = walkMoves(level, occupied, p, room.doors[0]);
      for (const b of curBoxes) occupied[b] = 0;
      if (transit === null) return solveWholeLevel(level);
      moves += transit.moves;
      p = transit.end;
      // The room's region: its squares, plus its doors (the player may stand in a doorway).
      const regionMask = new Uint8Array(size);
      const boxMask = new Uint8Array(size);
      for (const s of room.squares) {
        regionMask[s] = 1;
        boxMask[s] = 1;
      }
      for (const d of room.doors) regionMask[d] = 1;
      const startBoxes = room.boxes.slice().sort((a, b) => a - b);
      const solved =
        pushSearch(level, regionMask, boxMask, room.goals, startBoxes, p, ROOM_EXPANSION_CAP, false) ??
        pushSearch(level, regionMask, boxMask, room.goals, startBoxes, p, ROOM_EXPANSION_CAP, true);
      if (solved === null) return solveWholeLevel(level);
      const played = playSequence(level, startBoxes, p, solved.sequence);
      if (played === null) return solveWholeLevel(level);
      moves += played.moves;
      p = played.player;
      for (const b of room.boxes) curBoxes[curBoxes.indexOf(b)] = room.goals[room.boxes.indexOf(b)];
      curBoxes.sort((a, b) => a - b);
    }
    return moves;
  }
  return solveWholeLevel(level);
}

/** Fallback: one push search over the whole level. */
function solveWholeLevel(level) {
  const { wall, goals, boxes, player } = level;
  const size = wall.length;
  const regionMask = new Uint8Array(size);
  const boxMask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (!wall[i]) {
      regionMask[i] = 1;
      boxMask[i] = 1;
    }
  }
  const solved =
    pushSearch(level, regionMask, boxMask, goals, boxes, player, LEVEL_EXPANSION_CAP, false) ??
    pushSearch(level, regionMask, boxMask, goals, boxes, player, LEVEL_EXPANSION_CAP, true);
  if (solved === null) return '';
  const played = playSequence(level, boxes, player, solved.sequence);
  return played === null ? '' : played.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
