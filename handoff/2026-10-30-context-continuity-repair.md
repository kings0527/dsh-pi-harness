# Goal
Review and repair the dsh-pi-harness goal/reference continuity gaps without changing DSH core or adding a permanent theory-heavy prompt. No runtime fix has been implemented yet.

# Verified findings
1. `lib/board.js:464-486`: `digest(..., {sinceSeq})` drops the latest old plan unless it is in the newly selected notes. Minimal call with PLAN #1 then evidence #2 returned only #2.
2. `index.js:29-49,118-145`: checkpoint cursors are process-local; full reanchor defaults to every 12 turns and is not tied to actual post-compaction visibility. Bridge references are ordinary user messages, so DSH compaction may replace them with a model summary.
3. `index.js:51-65,103-105,146-150`: the first reference-injection failure permanently disables subsequent injection for that agent. There is no recovery or model-visible degradation notice.
4. `lib/reference.js:21-47,66-90` + `lib/util.js:104-116`: all open-topic bodies are expanded; the combined reference is truncated at its tail, where the handoff pointer lives. An observed initial reference withheld 7180 bytes.
5. DSH goal state is durable but does not itself produce a model message on every ordinary turn. Goal tools, todo, and exact-repeat tool reminders already exist; do not recreate them.

# Evidence boundaries
- Source audit and one minimal function reproduction are complete. Two independent read-only agents checked pi and DSH lifecycle semantics.
- No same-model/same-task DSH-vs-pi A/B establishes the dominant cause of every perceived drift or repeated error.
- No evidence of tool-name collision, bridge message-order inversion, silent ordinary tool errors, or a DSH storage failure.
- A pre-commit `state.turn` update may skip a reference after an early rejected step; this is a code-path inference, not an observed failure.
- Do not claim runtime fixes, tests, or user-experience improvement until implemented and measured.

# Recommended scope (review before implementation)
1. Derive recovery from the actual visible session surface, not event counts or every compaction: after `next()` in `agent/pre-step`, check whether the relevant `source.kind=pi-harness` checkpoint is still visible (automatic pressure compaction has already run at that point). Rebuild only when the required reference is absent; keep periodic checkpoints as a fallback. Also cover overflow compaction during `prepareRequest`/`buildRequest`, after pre-step: an admitted old reference may be shadowed in the same step, so do not claim all recovery is deferred to the next step. If an existing DSH active goal is used, reanchor that exact objective without creating/mirroring a second goal authority from Board text; Board remains the task evidence/plan owner.
2. Always include the latest plan alongside new Board evidence, deduplicated by seq. Quiet turns remain quiet.
3. Replace permanent failure latch with bounded retry and recovery; send at most one degradation notice per failure episode.
4. Give goal/plan/handoff priority in reference budgets; catalog unrelated topics rather than injecting every body. Preserve raw evidence on disk.
5. Keep feedback semantic and lightweight: failed hypothesis -> observed result -> excluded conclusion -> discriminating next experiment. No N-step gates or long systems/control-theory SOP.

# Acceptance criteria
- Regression: old PLAN #1 + new evidence #2 produces both in delta, once each.
- Regression: pressure compaction that removes the visible checkpoint causes a complete reference at the next pre-step; no intact-checkpoint compaction causes a duplicate. Cover overflow recovery after pre-step separately and assert the exact admitted/request-visible messages rather than assuming a next-step boundary. If an active goal is anchored, its text matches `ctx.goals` exactly and no Board-derived goal is created.
- Regression: transient read failure recovers on a later successful attempt; notification is not repeated every step.
- Regression: unchanged Board/KB does not inject another delta.
- Regression: over-budget input preserves goal/latest plan/handoff pointer and declares omitted material.
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
