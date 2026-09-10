# Schema mode

Schema mode replaces the free-form agent loop with an executable control loop. The
agent keeps its theory of the task in a program, certifies that program against
everything it has actually observed, plans inside the certified program, and reaches
the world through one gated channel.

The design follows the Schema harness described at <https://schema-harness.github.io/>
(Zeng et al., Impossible Research, 2026). That work reports 98.98% RHAE on the
ARC-AGI-3 public set with the same model pairing that scores 42.83% under a
general-purpose harness. The harness does not change the weights. It changes what the
model must write down and what it must prove before it acts.

Schema mode is on by default in `omps`. Use `--no-schema`, or set
`schema.enabled false`, to run the stock loop instead.

## The loop

Each cycle runs four stages.

1. **Observe.** Read the world. Reads, searches, and inspection are observations, and
   the harness records every one of them.
2. **Deliberate.** Revise `world_model.js` with `schema_model`, certify it with
   `schema_backtest`, and search it with `schema_plan`. None of these touch the world.
3. **Execute.** `schema_commit` runs an ordered queue of actions. Each step carries the
   projection the model expects. The first misprediction discards the rest of the queue.
4. **Record.** Every real transition is appended to `timeline.jsonl`. The agent can
   revise its theory. It can never revise what happened.

## State on disk

State lives under `.omp/schema/` in the project root. Override the location with
`schema.stateDir`.

| File            | Contents                                                         |
| --------------- | ---------------------------------------------------------------- |
| `world_model.js`| The executable theory: state grounding plus mechanism.            |
| `notes.md`      | Working notes the agent maintains for itself.                     |
| `timeline.jsonl`| The append-only record of every real transition.                  |
| `ledger.json`   | Revision history, certification verdicts, and live hypotheses.    |

The state is project-scoped, not session-scoped. A certified model is the expensive
artifact, and the efficiency gain comes from reusing it on later work rather than
rediscovering the same mechanism.

## The world model contract

`world_model.js` declares plain top-level functions. Only `step` is required.

```js
function initialState() { return { /* the smallest state that explains the work */ }; }
function step(state, action) { return { state: next, predict: "exit=0" }; }
function digest(observation) { return observation.text.trim(); }
function isGoal(state) { return state.buildGreen === true; }
function actions(state) { return ["run tests", "apply patch"]; }
function key(state) { return JSON.stringify(state); }
```

- `action` is `{ run, index, tool, args }`. `run` is the session id, so the model can
  compare two complete runs against each other.
- `observation` is `{ ok, text, details }`.
- `predict` is compared verbatim against `digest(observation)`.
- `predict: null` declines a prediction. Declining is honest, and it certifies nothing.

The model runs inside the JS eval VM, which is reset before every replay. A stale
`step` left by an earlier revision can never certify a model the agent no longer has.

## Certification and coverage

`schema_backtest` replays the model over the complete timeline and reports
`matched/checked` exact matches, the number skipped, prediction coverage, and up to
three pointed mismatches.

Coverage is the honest half of the number. ARC-AGI-3 can demand exact matches because
a 64×64 grid is the whole observable. Tool output is not: a model could pass every
check by predicting nothing. `schema.minCoverage` (default `0.5`) is the floor a model
must clear before it may plan or commit, so a green backtest always means something.

Planning and committing both require a green verdict. Search is complete only relative
to the model it runs over. Over the wrong model, exhaustive search returns a confident
wrong answer.

## The commit channel

The tools named in `schema.gatedTools` (`edit`, `write`, `ast_edit` by default) run only
inside `schema_commit`. Calling one directly is rejected with the loop it should follow.

`bash` is not gated by default because it is the main observation channel as well as a
mutation channel. Set `schema.gateBash true` to gate it too.

`eval` is not gated either. Tool calls made from an eval cell still route through the
registry, so `edit` and `write` stay gated even in Code Mode, but raw filesystem calls
inside the cell do not. Add `eval` to `schema.gatedTools` if a session needs that hole
closed.

Each step may carry its own `predict`. When it disagrees with what `world_model.js`
predicts for that step, the plan stops: the belief being acted on was never written
down, and an unwritten belief cannot be certified.

Inside a commit, each step runs, is appended to the timeline, and is checked against the
live model in the same VM. The first mismatch voids the remaining queue and returns the
counterexample. A voided plan is evidence, not a retry.

The queue re-certifies when it finishes, so the next plan starts from a verdict that
accounts for everything that just happened.

## Discriminating experiments

`schema_experiment` takes the hypotheses still standing and the candidate actions being
weighed, then ranks candidates by how many hypothesis pairs each one separates. A
candidate every hypothesis predicts identically teaches nothing and ranks last.

Hypotheses persist in `ledger.json`, so a rule killed by evidence stays killed.

## Epicycles

`schema_model status` counts the consecutive revisions that changed rules while the
state representation stayed the same and the backtest stayed red. Past
`schema.epicycleThreshold` (default `3`), it advises changing what the state is made
of instead of patching the rule again.

This is the Lorentz signature. When Michelson and Morley found no aether, Lorentz kept
the state and patched the law. Einstein changed what the state was. Both moves fit the
data; only one of them generalised.

## Limitations

- **Built-in tools only.** The loop wraps the built-in tool set. MCP and extension
  tools are neither gated nor recorded, so a mechanism reached only through one of
  them stays outside the timeline.
- **`eval` can still touch the filesystem directly.** Tool calls from an eval cell
  route through the gate, but raw `fs` calls inside the cell do not.
- **Sequence numbers are per process.** Two `omps` processes writing the same
  timeline can mint the same `seq`. Replay position, not `seq`, is what the world
  model sees as `action.index`, so this is cosmetic.
- **Exact-match projections are strict by design.** Predicting whole tool output will
  fail constantly. Predict the one observable that decides the step.

## Settings

| Setting                     | Default                       | Effect                                                        |
| --------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `schema.enabled`            | `true`                        | Run the Schema loop.                                          |
| `schema.gatedTools`         | `["edit","write","ast_edit"]` | Tools reachable only inside `schema_commit`.                   |
| `schema.gateBash`           | `false`                       | Also gate `bash`.                                             |
| `schema.minCoverage`        | `0.5`                         | Prediction coverage required before planning or committing.    |
| `schema.maxSearchNodes`     | `20000`                       | Node budget for in-model search.                              |
| `schema.maxPlanDepth`       | `64`                          | Longest plan `schema_plan` may return.                        |
| `schema.timeoutMs`          | `15000`                       | Budget for one replay or search.                              |
| `schema.epicycleThreshold`  | `3`                           | Revisions before the representation warning appears.          |
| `schema.stateDir`           | unset                         | Where schema state lives, relative to the project root.       |

## Tools

| Tool                | Approval | Purpose                                                    |
| ------------------- | -------- | ---------------------------------------------------------- |
| `schema_model`      | read/write | Read, revise, and inspect the world model and its ledger. |
| `schema_backtest`   | read     | Certify the model against the complete timeline.            |
| `schema_plan`       | read     | Breadth-first search inside the certified model.            |
| `schema_commit`     | write    | The only channel to the world.                              |
| `schema_experiment` | read     | Rank candidate actions by the hypotheses they separate.     |

## Citation

```bibtex
@misc{schema2026,
	title = {{[schema]: Frontier Models with the Right Harness Achieve $\sim$99\% on ARC-AGI-3 Public}},
	author = {Zeng, Guanning and Wang, Jiani and Ma, Wenjie and Yin, Shaofeng and
	          Wang, Chenyang and Liu, Shichen and Kanazawa, Angjoo and Ni, Wode and
	          Li, Xiuyu and Zanette, Andrea and Feng, Haiwen},
	year = {2026},
	howpublished = {Impossible Research. \url{https://schema-harness.github.io/}},
	url = {https://schema-harness.github.io/}
}
```
