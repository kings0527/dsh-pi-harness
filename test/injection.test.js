import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createReferenceDelivery } from '../lib/injection.js'
import { fixture, host } from './fixtures.js'

const setup = (f, options = {}, config = {}) => {
  const h = host(f.root, options)
  apply(h.ctx, { doctrine: false, ...config })
  return h
}
const refs = (h) => h.session.messages.filter((entry) => entry.source?.kind === 'pi-harness' && entry.source.form !== 'degraded')
const text = (entry) => entry.content[0].text

test('first reference follows real input and ordinary retries/quiet turns add no duplicates', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  const h = setup(f)
  const user = { id: 'human', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'input' } }
  await h.step({}, [user])
  assert.deepEqual(h.session.messages.map((entry) => entry.source.kind), ['input', 'pi-harness'])
  await h.request()
  await h.request()
  await h.step({ turn: 1, step: 1 })
  await h.step({ turn: 2, step: 0 })
  assert.equal(refs(h).length, 1)
})

test('pressure compaction is checked after next and restores the missing checkpoint', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  f.handoff()
  const h = setup(f)
  await h.step()
  let pressure = true
  h.ctx.on('agent/pre-step', async (_payload, next) => {
    if (pressure) { h.session.compact(); pressure = false }
    return next()
  })
  const restored = await h.step({ turn: 1, step: 1 })
  assert.equal(restored.messages.length, 1)
  assert.equal(restored.messages[0].source.form, 'reference')
  assert.match(text(restored.messages[0]), /PLAN/)
  assert.match(text(restored.messages[0]), /NEXT_ACTION/)
  assert.equal(refs(h).length, 1)
})

test('compaction that retains the checkpoint does not reanchor', async (t) => {
  const f = fixture(t)
  const h = setup(f)
  await h.step()
  h.session.compact((entry) => entry.source.kind !== 'pi-harness')
  assert.equal((await h.step({ turn: 2 })).messages.length, 0)
  assert.equal(refs(h).length, 1)
})

test('compaction after pre-step is repaired in the same request attempt', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'LATEST_PLAN', kind: 'plan' }])
  const h = setup(f)
  await h.step()
  const decision = await h.pre({ turn: 2, step: 0 })
  assert.equal(decision.messages.length, 0)
  await h.request({ turn: 2 }, async () => {
    h.session.compact()
    return { provider: 'test', model: 'test' }
  })
  // This is the exact surface buildRequest will freeze, before another pre-step.
  assert.equal(refs(h).length, 1)
  assert.match(text(refs(h)[0]), /LATEST_PLAN/)
})

test('overflow retry restores an initially admitted then shadowed proposal once', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  const h = setup(f)
  await h.step()
  const first = refs(h)[0].id
  h.session.compact()
  await h.request()
  assert.equal(refs(h).length, 1)
  assert.notEqual(refs(h)[0].id, first)
  await h.request()
  assert.equal(refs(h).length, 1)
  assert.equal(h.session.admitted.length, 2)
})

test('unadmitted or rejected steps never advance delivery receipts', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  const h = setup(f)
  const first = await h.pre()
  const repeated = await h.pre()
  assert.equal(first.messages[0].id, repeated.messages[0].id)
  const rejected = await h.dispatch('agent/pre-step', {}, async () => ({ kind: 'reject', reason: 'test' }))
  assert.equal(rejected.kind, 'reject')
  await assert.rejects(h.request({}, async () => { throw new Error('prepareRequest rejected') }), /rejected/)
  const later = await h.step({ turn: 2 })
  assert.equal(later.messages[0].source.form, 'reference')
  assert.match(text(later.messages[0]), /PLAN/)
})

test('transient failure sends one notice, backs off and recovers without restarting', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'RECOVERED_PLAN', kind: 'plan' }])
  let ready = false
  let calls = 0
  let clock = 0
  const h = host(f.root, { ensure: async () => { calls++; if (!ready) throw new Error('temporary read error'); return f.root } })
  createReferenceDelivery(h.ctx, { injectReference: true, maxReferenceBytes: 48000, checkpointEveryTurns: 12, retryBaseMs: 1000 }, { now: () => clock })
  await h.step()
  assert.equal(h.session.admitted.length, 1)
  assert.equal(h.session.admitted[0].source.form, 'degraded')
  await h.step({ turn: 2 })
  assert.equal(calls, 1)
  clock = 1000
  await h.step({ turn: 3 })
  assert.equal(calls, 2)
  assert.equal(h.session.admitted.length, 1)
  ready = true
  clock = 3000
  await h.step({ turn: 4 })
  assert.equal(calls, 3)
  assert.equal(refs(h).length, 1)
  assert.match(text(refs(h)[0]), /RECOVERED_PLAN/)
  await h.step({ turn: 5 })
  assert.equal(h.session.admitted.length, 2)
  assert.equal(h.warnings.length, 1)
})

test('failure recovery also works with no delay and does not double-admit its notice', async (t) => {
  const f = fixture(t)
  let calls = 0
  const h = setup(f, { ensure: async () => { if (++calls === 1) throw new Error('transient'); return f.root } }, { retryBaseMs: 0 })
  const user = { id: 'failure-human', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'input' } }
  await h.step({}, [user])
  assert.equal(h.session.messages[0].id, user.id)
  await h.step({ turn: 2 })
  assert.equal(refs(h).length, 1)
  assert.equal(h.session.admitted.filter((entry) => entry.source.form === 'degraded').length, 1)
})

test('a pending delta is upgraded in place when its baseline disappears during request preparation', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  const h = setup(f)
  await h.step()
  f.post('work', { content: 'FRESH_EVIDENCE' })
  const user = { id: 'delta-human', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'input' } }
  const decision = await h.pre({ turn: 2 }, [user])
  assert.equal(decision.messages[1].source.form, 'delta')
  await h.request({ turn: 2 }, async () => {
    h.session.compact()
    return { provider: 'test', model: 'test' }
  })
  assert.equal(decision.messages[1].source.form, 'reference')
  assert.match(text(decision.messages[1]), /Global knowledge index/)
  for (const entry of decision.messages) h.session.append('user/message', entry, { surfaceOp: 'append' })
  assert.equal(h.session.messages[0].id, user.id)
  assert.equal(refs(h).length, 1)
  assert.match(text(refs(h)[0]), /FRESH_EVIDENCE/)
})

test('goal service is optional, read-only, exact and active-phase only', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'BOARD_PLAN', kind: 'plan' }])
  const without = setup(f)
  await without.step()
  assert.equal(refs(without).length, 1)
  assert.deepEqual(without.optional, [['goals']])
  let current = { id: 'goal-1', revision: 1, phase: 'active', objective: 'Exact user goal <&>\nwith original whitespace' }
  const withGoal = setup(f, { goal: { get: () => current } })
  await withGoal.step()
  assert.ok(text(refs(withGoal)[0]).includes('Exact user goal &lt;&amp;&gt;\nwith original whitespace'))
  for (const phase of ['paused', 'blocked', 'complete']) {
    current = { ...current, phase }
    const fresh = setup(f, { goal: { get: () => current } })
    await fresh.step()
    assert.ok(!text(refs(fresh)[0]).includes('Exact user goal'))
    assert.match(text(refs(fresh)[0]), /BOARD_PLAN/)
  }
  current = { ...current, phase: 'active', revision: 2, objective: 'UPDATED_GOAL' }
  await withGoal.step({ turn: 1, step: 1 })
  assert.match(text(refs(withGoal).at(-1)), /UPDATED_GOAL/)
})

test('an unavailable optional goal projection does not disable Board injection', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  const h = setup(f, { goal: { get: () => { throw new Error('goal projection not ready') } } })
  await h.step()
  assert.match(text(refs(h)[0]), /PLAN/)
  assert.equal(h.warnings.length, 1)
})

test('lost delta coverage is restored even when the original checkpoint survives', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  const h = setup(f)
  await h.step()
  f.post('work', { content: 'EVIDENCE' })
  await h.step({ turn: 2 })
  await h.request({ turn: 2 })
  h.session.compact((entry) => entry.source.form === 'delta')
  await h.step({ turn: 3 })
  assert.equal(refs(h).at(-1).source.form, 'reference')
  assert.match(text(refs(h).at(-1)), /EVIDENCE/)
})

test('periodic checkpoints remain a fallback and cancellation adds no messages', async (t) => {
  const f = fixture(t)
  const h = setup(f, {}, { checkpointEveryTurns: 2 })
  await h.step()
  await h.step({ turn: 2 })
  assert.equal(refs(h).length, 1)
  await h.step({ turn: 3 })
  assert.equal(refs(h).length, 2)
  const controller = new AbortController()
  controller.abort()
  assert.equal((await h.pre({ turn: 4, signal: controller.signal })).messages.length, 0)
  await h.request({ turn: 4, signal: controller.signal })
  assert.equal(refs(h).length, 2)
})

test('tools-only mode does not register injection hooks', (t) => {
  const f = fixture(t)
  const h = host(f.root)
  apply(h.ctx, { injectReference: false, doctrine: false })
  assert.deepEqual(h.optional, [])
})

test('long references preserve their tail across periodic reanchors', async (t) => {
  const f = fixture(t)
  f.topic('work', [{ content: 'x'.repeat(100000), kind: 'plan' }, { content: 'FINAL_TAIL' }])
  const h = setup(f)
  for (let turn = 1; turn <= 20; turn++) await h.step({ turn, step: 0 })
  assert.ok(refs(h).some((entry) => text(entry).includes('FINAL_TAIL')))
})
