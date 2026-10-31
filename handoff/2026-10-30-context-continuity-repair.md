# Goal
Review and repair the dsh-pi-harness goal/reference continuity gaps without changing DSH core or adding a permanent theory-heavy prompt.

## Implementation status — 2026-10-31
- Implemented locally as plugin version `0.3.0`: latest active-plan anchoring; visible-surface delivery receipts; pressure/overflow compaction recovery; one notice per failure episode with bounded retry; optional read-only active DSH goal anchoring. The user explicitly prioritizes accuracy over token budgets: automatic references now preserve complete selected notes, metadata, goals, catalogs and handoff pointers. Legacy byte limits are ignored.
- All open topics still participate. Retraction semantics include retracted retractions and topic-qualified targets; prototype-like IDs retain their own coverage records. No partial-note offsets or lossy fallback references are needed.
- Added `lib/injection.js`, a reproducible `scripts/prepare-core.mjs` adapter, and focused tests under `test/`; the package test script includes them. The prior 51-test suite was insufficient: new regressions cover complete long goals/evidence/catalogs, real project/global read-write round trips, validation errors leaving files unchanged, and WSL home resolver parity. No live session or installed DSH core was changed.
- Follow-up for missing autonomous Board/KB behavior: restored project/workspace root `KNOWLEDGE.md` navigation and file-access activation of directory knowledge; added an explicit resident Board -> verification -> close -> sourced knowledge workflow. This verifies context activation and rendered instructions, not a same-model behavioral A/B or guaranteed model compliance. The current shipped cordis preset does not use a complete persona, so complete-persona suppression was investigated and ruled out for the present default.
- The bundled pi core's scoped knowledge resolver delegates to the same DSH resolver as readers; unscoped behavior is preserved. Always run `node scripts/prepare-core.mjs` after rebuilding `dist/core.js`. Clarified that verification targets existing claims, observations use evidence, a failed write saved nothing, and a successful post is not a closed/archive operation.
- Final 0.3.0 verification: all 64 tests passed under the installed Windows DSH runtime, zero failures/skips. This includes full long-content tails, retractions, target validation before writes, concurrent root scopes, real project/global round trips, WSL resolver parity, actual Session replacement/replay, actual prompt assembly, and the actual translator provider. Automatic knowledge scope boundary checks and ordinary section headings now follow pi's source behavior. WSL parity here checks resolver equality, not a live write to a running distro.
- Remaining parity boundaries: no same-model long-task A/B has established pi-equivalent stability; all open topics are included rather than pi's selective participation feed. DSH/model context-window limits and the host's compaction still exist. Do not present unit/contract test counts as proof of long-term behavioral equivalence.
- Desktop profile's `node_modules/@local/dsh-pi-harness` is a junction to `C:\Users\KK\git\dsh-pi-harness`. Restart DSH to load the changed modules. The user will do the restart; do not interrupt their running work.
- Changes remain local, uncommitted and unpushed. No same-model/same-task A/B or post-restart live-session observation establishes a broader behavioral improvement yet.

## Next
Restart desktop DSH, verify `handoff action=status`, and exercise a long session with Board plan/evidence, compaction, and transient reference failure. The automated compatibility checks have passed; observe the user-facing behavior after reload. The original audit below is retained as historical evidence; its line numbers refer to `645d300`.

# Audit findings before repair
1. `lib/board.js:464-486`: `digest(..., {sinceSeq})` drops the latest old plan unless it is in the newly selected notes. Minimal call with PLAN #1 then evidence #2 returned only #2.
2. `index.js:29-49,118-145`: checkpoint cursors are process-local; full reanchor defaults to every 12 turns and is not tied to actual post-compaction visibility. Bridge references are ordinary user messages, so DSH compaction may replace them with a model summary.
3. `index.js:51-65,103-105,146-150`: the first reference-injection failure permanently disables subsequent injection for that agent. There is no recovery or model-visible degradation notice.
4. `lib/reference.js:21-47,66-90` + `lib/util.js:104-116`: all open-topic bodies are expanded; the combined reference is truncated at its tail, where the handoff pointer lives. An observed initial reference withheld 7180 bytes.
5. DSH goal state is durable but does not itself produce a model message on every ordinary turn. Goal tools, todo, and exact-repeat tool reminders already exist; do not recreate them.
6. `lib/reference.js:28-47`: `boardSnapshot()` advances `seqs` to `notes.at(-1)` before per-topic/total truncation. Withheld or truncated notes can therefore be treated as delivered and omitted from later deltas. A cursor must represent actually rendered coverage, not the latest stored note.
7. `index.js:20`: the bridge injects only `tools`, `workingDirectory`, and `systemPrompt`; `ctx.goals` is not guaranteed. Goal anchoring needs an explicit optional dependency and an absence fallback.

# Evidence boundaries
- Source audit and one minimal function reproduction are complete. Two independent read-only agents checked pi and DSH lifecycle semantics.
- No same-model/same-task DSH-vs-pi A/B establishes the dominant cause of every perceived drift or repeated error.
- No evidence of tool-name collision, bridge message-order inversion, silent ordinary tool errors, or a DSH storage failure.
- A pre-commit `state.turn` update may skip a reference after an early rejected step; this is a code-path inference, not an observed failure.
- Do not claim runtime fixes, tests, or user-experience improvement until implemented and measured.

# Recommended scope (review before implementation)
1. Derive recovery lazily from the actual visible session surface, not event counts or every compaction: after `next()` in `agent/pre-step`, check whether the relevant `source.kind=pi-harness` checkpoint is still visible (automatic pressure compaction has already run at that point). Rebuild only when the required reference is absent; keep periodic checkpoints as a fallback. `session/event` is fire-and-forget, not a commit barrier. Also cover overflow compaction during `prepareRequest`/`buildRequest`, after pre-step: an admitted old reference may be shadowed in the same step, so do not claim all recovery is deferred to the next step. If an existing DSH active goal is used, reanchor that exact objective without creating/mirroring a second goal authority from Board text; Board remains the task evidence/plan owner. Declare `goals` as an optional dependency, define fallback when absent, and anchor only `phase=active` goals.
2. Fix delivery cursors before/while fixing budgets: track actual rendered coverage separately from latest stored seq, so withheld/truncated notes are retried rather than skipped. On a topic with fresh notes, include its latest plan alongside fresh evidence, deduplicated by seq. A topic with no fresh notes stays quiet.
3. Replace permanent failure latch with bounded retry and recovery; send at most one degradation notice per failure episode.
4. Give goal/plan/handoff priority in reference budgets. Do not switch directly to hiding all topic bodies: first define current/participating/deferred semantics and a critical-note channel, preserving raw evidence on disk.
5. Keep feedback semantic and lightweight: failed hypothesis -> observed result -> excluded conclusion -> discriminating next experiment. No N-step gates or long systems/control-theory SOP.

# Acceptance criteria
- Regression: old PLAN #1 + new evidence #2 produces both in delta, once each.
- Regression: pressure compaction that removes the visible checkpoint causes a complete reference at the next pre-step; no intact-checkpoint compaction causes a duplicate. Cover overflow recovery after pre-step separately and assert the exact admitted/request-visible messages rather than assuming a next-step boundary. If an active goal is anchored, its text matches the optional `goals` service exactly, only `phase=active` is used, absence degrades without breaking Board injection, and no Board-derived goal is created.
- Regression: a topic body withheld or shortened by either budget does not advance delivered coverage past what was rendered; a later reference retries the missing notes.
- Regression: transient read failure recovers on a later successful attempt; notification is not repeated every step.
- Regression: unchanged Board/KB does not inject another delta.
- Regression: measure the complete XML-escaped output, including checkpoint and delta. Over-budget input preserves goal/latest plan/handoff pointer and declares omitted material; under tiny budgets the preserved fields and omission markers remain bounded too.
- Verify normal tool retries do not duplicate reference messages, and real-user/goal-round authorization semantics are unchanged.
- Run `npm test` and add focused reference/injection tests; current package test script covers only the translator, so new tests must be wired explicitly.

# Review and delivery
- Independent reviewer should challenge the proposed DSH integration point, replay/compaction correctness, duplicate delivery, retry recovery, and test sufficiency.
- DSH runtime evidence was from `/Users/kk/.npm/_npx/1e7f6d9597241db0/` (reported 0.2.1-rc.2); pi comparison was `/Users/kk/git/pi-harness`.
- Audit archive: `.pi-board/topics/archive/harness-goal-continuity-audit.{jsonl,summary.md,decisions.md}`; material verification is #5.
- Global knowledge: `knowledge(global:harness/dsh-pi-context-feedback-audit.md)`.
- Repository was clean at `1c16096` (`main`, same as `origin/main`) before this handoff. Keep the handoff directory ignored and add only the specific dated handoff with `git add -f`; do not add Board/knowledge/runtime artifacts or weaken ignore rules.
- GitHub remote: `origin git@github.com:kings0527/dsh-pi-harness.git`. Also a `gitlab` remote exists; user asked for GitHub, so push `origin` only.
- Existing root `HANDOFF.md` documents another-machine setup and remains valid; this dated handoff covers the new audit.
