[![make.fun competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/afgcdfhvcfghvc-hub/makefun-sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/afgcdfhvcfghvc-hub/makefun-sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# sokoban-solver

A push-optimal Sokoban solver for make.fun's sokoban-solver-01, written as a single
`main.ts` (Node 22, no dependencies). It answers a whole set of instances in one run:
for each `/input/<id>/level.txt` it writes `/output/<id>/solution.txt`.

## Approach

A generated level is a hallway with independent rooms off it: a box can never leave
its room (the only way out is a push through the door into the hallway, where no goal
is reachable), so the level's push optimum is the sum of its rooms' optima. The solver
finds that structure on its own:

1. **Decomposition.** Squares of the player's row from which no box can be pushed to
   any goal (a pull BFS from the goals) are hallway squares. Cutting them out of the
   floor leaves one connected component per room, with the cut squares beside it as
   its doors. If a level does not decompose, the same search below runs on the whole
   level instead.
2. **Per-room push A\*.** Each room is solved exactly with an A\* search over pushes,
   not steps: a state is the room's box squares plus the lowest square of the player's
   reachable region, so walks between pushes are never searched. The estimate is a
   minimum-cost matching between boxes and goals, costed by true push distances
   (a pull BFS from each goal over the room) — admissible, so the first solution
   found is push-optimal for the room.
3. **Deadlock pruning.** A push is cut when the pushed box lands on a square no goal
   is reachable from, and when the resulting position has a frozen box off its goal
   (a box held by an immovable neighbour — a wall or an already frozen box — on one
   horizontal and one vertical side, computed to a fixpoint).
4. **Assembly.** The player walks to each room's door, the room's pushes are played
   (walks between pushes filled in by BFS), and the rooms are concatenated.

Everything is budgeted by counted work (states expanded), never by the clock, and
every tie is broken by a fixed rule, so two runs write byte-identical answers
(verified on the practice set).

## Practice results

Scored with the kit's own checker against the practice manifest (P\* = the level's
push optimum):

| instance | rooms | P\* | this solver | house baseline plain-astar 1.0.0 |
|---|---|---|---|---|
| i001 | 1 room, 3 boxes | 13 | **13 pushes, 1000 pts** | 13 pushes, 1000 pts |
| i002 | 1 room, 4 boxes | 16 | **16 pushes, 1000 pts** | unsolved (empty answer), 0 pts |
| i003 | 2 rooms, 8 boxes | 29 | **29 pushes, 1000 pts** | unsolved, 0 pts |
| i004 | 3 rooms, 12 boxes | 47 | **47 pushes, 1000 pts** | unsolved, 0 pts |
| i005 | 4 rooms, 16 boxes | 60 | **60 pushes, 1000 pts** | unsolved, 0 pts |

**Set score: 1,000,000 (the maximum) vs the baseline's 200,000.** The whole practice
set is answered in ~0.5 s of the 60 s budget; the per-room A\* expands 339 states in
total (15–63 per room).

## Revision record

The solver first shipped with dead-square pruning only. Measured per-room expansions
on the practice set were already small, so a stress corpus was drawn with the kit's
own generator (6 fresh sets, 30 instances, same distribution as the scored set) to
measure a second pruning rule properly. Adding freeze-deadlock pruning cut total
search expansions on that corpus from 6,737 to 6,657 states (−1.2%) with no change
in results — both builds solve all 30 drawn instances at exactly P\*. The pruning is
kept: its value grows with room difficulty (the generator accepts rooms whose plain
breadth-first search needs up to 250k states), and it costs nothing measurable at
this scale.
