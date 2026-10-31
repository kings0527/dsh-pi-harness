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

test('a long active plan is delivered in full and its receipt includes the tail', (t) => {
  const f = fixture(t)
  f.topic('large', [{ content: 'X'.repeat(180000), kind: 'plan' }, { content: 'LAST_NOTE' }])
  const built = buildReference(f.root)
  assert.equal(built.board.large, 2)
  assert.ok(built.text.includes('X'.repeat(180000)))
  assert.match(built.text, /LAST_NOTE/)
  assert.equal(buildDelta(f.root, built), null)
})

test('unrendered topics never advance receipts and later deltas deliver the backlog', (t) => {
  const f = fixture(t)
  for (let i = 0; i < 200; i++) f.topic(`t${String(i).padStart(3, '0')}`, [{ content: `MARKER_${i}_` }])
  let built = buildReference(f.root)
  assert.equal(Object.hasOwn(built.board, 't199'), false)
  assert.equal(buildDelta(f.root, built) === null, false)
  const delivered = new Set()
  for (let page = 0; built && page < 30; page++) {
    const board = built.omitted.find((group) => group.key === 'board')
    assert.equal(built.text.split('MARKER_').length - 1, board.shown)
    for (const id of Object.keys(built.board)) delivered.add(id)
    built = buildDelta(f.root, built)
  }
  assert.equal(built, null)
  assert.equal(delivered.size, 200)
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

test('legacy byte limits are ignored but fallback rows do not advance boardSnapshot receipts', (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'COMPLETE_NOTE_' + 'x'.repeat(3000) }])
  const built = buildReference(f.root, { maxBytes: 0 })
  assert.match(built.text, /board read topic="work"/)
  assert.equal(built.board.work, undefined)
  assert.equal(boardSnapshot(f.root, { totalBytes: 1, budgetTokens: 2048 }).seqs.work, undefined)
  const delivered = buildDelta(f.root, built, { budgetTokens: 10000 })
  assert.equal(delivered.board.work, 1)
  assert.equal(buildDelta(f.root, delivered, { budgetTokens: 10000 }), null)
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

test('knowledge indexes page without clipping rows and invalidate when rewritten', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'knowledge'))
  const path = join(f.root, 'knowledge', 'index.md')
  writeFileSync(path, Array.from({ length: 500 }, (_, i) => `row-${i}.md | description ${i} ` + 'd'.repeat(500)).join('\n'))
  const indexed = buildReference(f.root)
  assert.match(indexed.text, /knowledge list scope=project offset=/)
  assert.ok(indexed.text.includes('496 whole row(s) remain'))
  writeFileSync(path, Array.from({ length: 180 }, (_, i) => `Free form line ${i}`).join('\n'))
  const free = buildDelta(f.root, indexed)
  assert.match(free.text, /Project knowledge index/)
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

test('unreadable topics degrade to an index warning without receipts or exceptions', (t) => {
  const f = fixture(t)
  const path = join(f.root, '.pi-board', 'topics', 'broken.jsonl')
  mkdirSync(join(f.root, '.pi-board', 'topics'), { recursive: true })
  writeFileSync(path, '#META#{"id":"broken","goal":"recover later","status":"open","createdAt":1000}\nnot-json\n')
  const before = buildReference(f.root)
  assert.match(before.text, /Board topic broken is unreadable/)
  assert.equal(before.board.broken, undefined)
  const next = buildDelta(f.root, before)
  assert.match(next.text, /Board topic broken is unreadable/)
  assert.equal(next.board.broken, undefined)
  mkdirSync(join(f.root, '.pi-board', 'topics', 'archive'), { recursive: true })
  writeFileSync(join(f.root, '.pi-board', 'topics', 'archive', 'old.jsonl'), '#META#{"id":"old","goal":"old","status":"closed","createdAt":1000}\nnot-json\n')
  const archived = buildDelta(f.root, next)
  assert.match(archived.text, /Board topic old is unreadable/)
  assert.equal(archived.archived.old, undefined)
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
