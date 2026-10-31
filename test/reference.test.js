import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest } from '../lib/board.js'
import { buildDelta, buildReference, boardSnapshot } from '../lib/reference.js'
import { truncateBytes } from '../lib/util.js'
import { fixture } from './fixtures.js'

test('delta repeats the active old plan and new evidence exactly once, then goes quiet', (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'OLD_PLAN', tags: ['plan'] }])
  const before = buildReference(f.root)
  f.post('work', { content: 'NEW_EVIDENCE', kind: 'evidence' })
  const built = buildDelta(f.root, before)
  for (const marker of ['OLD_PLAN', 'NEW_EVIDENCE']) assert.equal(built.text.split(marker).length - 1, 1)
  assert.match(built.text, /Goal for work/)
  assert.equal(buildDelta(f.root, built), null)
})

test('kind=plan is pinned without requiring a redundant tag', (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'TYPED_PLAN', kind: 'plan' }])
  const before = buildReference(f.root)
  f.post('work', { content: 'evidence' })
  assert.match(buildDelta(f.root, before).text, /\[PLAN\].*TYPED_PLAN/)
})

test('long notes are delivered in full immediately and cursor includes the actual tail', (t) => {
  const f = fixture(t)
  f.topic('large', [{ content: 'X'.repeat(180000) }, { content: 'LAST_NOTE' }])
  const built = buildReference(f.root)
  assert.equal(built.board.large, 2)
  assert.ok(built.text.includes('X'.repeat(180000)))
  assert.match(built.text, /LAST_NOTE/)
  assert.equal(buildDelta(f.root, built), null)
})

test('every open topic is complete even with legacy byte limits supplied', (t) => {
  const f = fixture(t)
  for (let i = 0; i < 35; i++) f.topic(`t${i}`, [{ content: `MARKER_${i}_` + 'x'.repeat(1200) }])
  const built = buildReference(f.root, { maxBytes: 4000 })
  assert.ok(Buffer.byteLength(built.text) > 4000)
  for (let i = 0; i < 35; i++) {
    assert.equal(built.board[`t${i}`], 1)
    assert.match(built.text, new RegExp(`MARKER_${i}_`))
  }
  assert.equal(buildDelta(f.root, built), null)
})

test('complete XML-escaped goal, plan and handoff constraints survive without caps', (t) => {
  const f = fixture(t)
  const objective = '<&>😀'.repeat(10000) + 'GOAL_CRITICAL_END'
  f.handoff('handoff detail '.repeat(1000) + 'HANDOFF_CRITICAL_END')
  const goal = { id: 'g', revision: 1, phase: 'active', objective }
  f.topic('work', [{ content: 'PLAN_BEGIN' + 'plan '.repeat(10000) + 'PLAN_END', kind: 'plan' }], { goal: 'topic '.repeat(1000) + 'TOPIC_END' })
  const first = buildReference(f.root, { maxBytes: 4000, goal })
  for (const marker of ['GOAL_CRITICAL_END', 'PLAN_BEGIN', 'PLAN_END', 'HANDOFF_CRITICAL_END', 'TOPIC_END']) assert.ok(first.text.includes(marker), marker)
  assert.ok(first.text.includes('&lt;&amp;&gt;😀'))
  f.post('work', { content: '<&>'.repeat(20000) + 'EVIDENCE_END' })
  const next = buildDelta(f.root, first, { maxBytes: 1, goal })
  for (const marker of ['GOAL_CRITICAL_END', 'PLAN_END', 'HANDOFF_CRITICAL_END', 'TOPIC_END', 'EVIDENCE_END']) assert.ok(next.text.includes(marker), marker)
})

test('legacy zero/tiny budgets cannot silently omit reference content', (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'COMPLETE_NOTE_' + 'x'.repeat(3000) }])
  for (const maxBytes of [0, 1, 20, 80, 400, 600]) {
    const built = buildReference(f.root, { maxBytes })
    assert.match(built.text, /COMPLETE_NOTE_/)
    assert.equal(built.board.work, 1)
    assert.ok(!built.text.includes('omitted="budget"'))
  }
  assert.equal(boardSnapshot(f.root, { totalBytes: 1 }).seqs.work, 1)
})

test('structured targets, verdicts, actor identity and unknowns remain visible', (t) => {
  const f = fixture(t)
  f.topic('work', [
    { content: 'Claim', kind: 'claim', actor: { id: 'actor-exact' }, material: true },
    { content: 'Verified', kind: 'verification', targets: [{ topic: 'work', seq: 1 }] },
    { content: 'Settled', kind: 'convergence', verdict: 'EXACT_VERDICT', unresolved: [{ topic: 'work', seq: 1 }] },
  ])
  const built = buildReference(f.root)
  for (const marker of ['actor-exact', 'EXACT_VERDICT', 'targets', 'unresolved', 'material']) assert.ok(built.text.includes(marker), marker)
})

test('large indexed and free-form knowledge catalogs retain their complete tails', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'knowledge'))
  const path = join(f.root, 'knowledge', 'index.md')
  writeFileSync(path, Array.from({ length: 500 }, (_, i) => `row-${i}.md | description ${i} ` + 'd'.repeat(500)).join('\n'))
  const indexed = buildReference(f.root)
  assert.match(indexed.text, /row-499\.md/)
  assert.ok(indexed.text.includes('d'.repeat(500)))
  writeFileSync(path, Array.from({ length: 180 }, (_, i) => `Free form line ${i}`).join('\n'))
  const free = buildDelta(f.root, indexed)
  assert.match(free.text, /Free form line 179/)
  assert.equal(buildDelta(f.root, free), null)
})

test('a replaced topic and a new handoff are detected without new sequence numbers', (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'OLD' }])
  const before = buildReference(f.root)
  f.topic('work', [{ content: 'REPLACED' }], { createdAt: 2000 })
  const replaced = buildDelta(f.root, before)
  assert.match(replaced.text, /REPLACED/)
  f.handoff('NEW_HANDOFF')
  assert.match(buildDelta(f.root, replaced).text, /NEW_HANDOFF/)
})

test('withdrawn plans are not repinned; historical records keep their retraction metadata', (t) => {
  const f = fixture(t)
  const notes = f.topic('work', [
    { content: 'WITHDRAWN_PLAN', kind: 'plan' },
    { content: 'Withdraw', kind: 'retraction', targets: [{ topic: 'work', seq: 1 }] },
  ])
  const before = buildReference(f.root)
  assert.match(before.text, /\[RETRACTED\]\[PLAN\]/)
  f.post('work', { content: 'NEW_EVIDENCE' })
  const next = buildDelta(f.root, before)
  assert.ok(!next.text.includes('WITHDRAWN_PLAN'))
  assert.ok(!digest({ id: 'work' }, notes, { sinceSeq: 2 }).text.includes('WITHDRAWN_PLAN'))
})

test('retracting a retraction restores the plan, cross-topic seqs do not retract local plans', (t) => {
  const f = fixture(t)
  f.topic('work', [
    { content: 'RESTORED_PLAN', kind: 'plan' },
    { content: 'Withdraw', kind: 'retraction', targets: [{ topic: 'work', seq: 1 }] },
    { content: 'Undo withdrawal', kind: 'retraction', targets: [{ topic: 'work', seq: 2 }] },
    { content: 'Withdraw remote', kind: 'retraction', targets: [{ topic: 'other', seq: 1 }] },
  ])
  const first = buildReference(f.root)
  f.post('work', { content: 'NEW_EVIDENCE' })
  assert.match(buildDelta(f.root, first).text, /RESTORED_PLAN/)
})

test('valid prototype-like topic IDs retain own receipts and do not repeat forever', (t) => {
  const f = fixture(t)
  for (const id of ['__proto__', 'constructor', 'toString']) f.topic(id, [{ content: `${id}_NOTE` }])
  const before = buildReference(f.root)
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.ok(Object.hasOwn(before.board, id))
    assert.equal(before.board[id], 1)
  }
  assert.equal(buildDelta(f.root, before), null)
})

test('UTF-8 utility truncation still counts markers for explicit non-reference uses', () => {
  for (let cap = 0; cap < 100; cap++) {
    const clipped = truncateBytes('😀<&>中'.repeat(100), cap)
    assert.ok(Buffer.byteLength(clipped) <= cap)
    assert.ok(!/[\uD800-\uDBFF]$/.test(clipped))
  }
})
