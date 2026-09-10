Read, edit, and inspect the world model — your theory of this task, written as a runnable program in `world_model.js`.

The model is your memory. It survives compaction, it can be diffed, and it can be replayed against everything that has actually happened. Two layers live in it and either may be wrong: the **state grounding** (what the world is made of) and the **mechanism** (how actions change it).

Operations:

- `status` — revision count, last certification verdict, prediction coverage, timeline length, and the epicycle counter.
- `read` — the current `world_model.js` and `notes.md`.
- `write` — replace `world_model.js`. Requires `source` and a one-line `note` saying what changed and why.
- `notes` — read `notes.md`, or replace it by passing `notes`.
- `timeline` — the tail of the append-only record of what really happened.

The contract `world_model.js` must satisfy:

```js
function initialState() { return { /* the smallest state that explains the work */ }; }
function step(state, action) { return { state: next, predict: "..." /* or null */ }; }
function digest(observation) { return "..."; }  // project a real observation into predict-space
function isGoal(state) { return false; }        // what "done" means
function actions(state) { return []; }          // candidate actions for search
function key(state) { return JSON.stringify(state); }
```

`action` is `{ run, index, tool, args }`. `observation` is `{ ok, text, details }`. `predict` is compared verbatim against `digest(observation)`; return `null` to decline. Declining is honest but certifies nothing, and coverage falls.

When a prediction keeps failing, suspect the representation before you patch the rule. A special case bolted on to keep a wrong representation alive is an epicycle; `status` counts them.
