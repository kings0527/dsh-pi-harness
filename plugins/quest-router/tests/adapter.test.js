import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, runChild } from '../index.js'
import { configuration } from '../core/policy.js'
import { hash } from '../core/store.js'
import { mock } from './helpers.js'

test('fresh child delivery is caller-only; Board injection and worker delegation are gated', async t => {
  const m = mock(t)
  const result = await runChild(m.ctx, m.config, m.parent, { id: 'eight', number: 1, plan: { provider: 'p', model: 'flash', reasoningEffort: 'high', method: 'forward' }, prompt: 'CAPSULE', commitExperiment: () => ({ committed: true }), signal: new AbortController().signal })
  assert.equal(m.starts[0].delivery, 'caller')
  assert.equal(m.starts[0].provider, 'spawn')
  assert.ok(m.starts[0].request.prompt[0].text.startsWith('CAPSULE'))
  assert.equal(m.starts[0].request.maxDepth, 1)
  assert.equal(m.disposals, 1)
  assert.equal(m.registrations.find(r => r.map === m.childHooks && r.name === 'agent/pre-step').options.prepend, true)
  assert.equal(result.childId, m.starts[0].childId)
  assert.match(m.guards[0]({ name: 'board' }), /unavailable/)
  assert.match(m.guards[0]({ name: 'subagent' }), /unavailable/)
  assert.equal(m.guards[0]({ name: 'read_file' }), undefined)
  const decision = await m.registrations.find(r => r.map === m.childHooks && r.name === 'agent/pre-step').fn({}, async () => ({ kind: 'enter', messages: [{ source: { kind: 'pi-harness' }, content: 'GLOBAL BOARD' }, { source: { kind: 'user' }, content: 'CAPSULE' }] }))
  assert.deepEqual(decision.messages.map(x => x.content), ['CAPSULE'])
})

test('a narrower session model allowlist wins over plugin route configuration', async t => {
  const m = mock(t, [{ provider: 'p', model: 'other' }])
  await assert.rejects(runChild(m.ctx, m.config, m.parent, { plan: { provider: 'p', model: 'flash', reasoningEffort: 'high' } }), /Session policy/)
  assert.equal(m.starts.length, 0)
  assert.equal(m.resolved.length, 0)
})

test('critical exhausted cases block goal continuation without claiming main-goal completion', async t => {
  const m = mock(t)
  apply(m.ctx, m.config)
  const tool = m.tools.get('quest'), exec = { agent: m.parent, signal: new AbortController().signal }
  await tool.execute({ action: 'create', id: 'eight', objective: 'Reach nine', entry: 'Seven was reached', exit: 'Exit witness exists', check: 'exit', blocksMainline: true }, exec)
  const result = await tool.execute({ action: 'run', id: 'eight' }, exec)
  assert.equal(JSON.parse(result.text).status, 'blocked')
  assert.equal(m.blocks.length, 1)
  assert.equal(m.blocks[0][2].code, 'quest-blocked')
  assert.ok(!result.text.includes('PRIVATE CHILD OUTPUT'))
  const starts = m.starts.length
  await tool.execute({ action: 'run', id: 'eight' }, exec)
  assert.equal(m.starts.length, starts)
  assert.equal(m.blocks.length, 1)
})

test('a failed optional side case does not block unrelated mainline work', async t => {
  const m = mock(t); apply(m.ctx, m.config)
  const tool = m.tools.get('quest'), exec = { agent: m.parent, signal: new AbortController().signal }
  await tool.execute({ action: 'create', id: 'optional', objective: 'Inspect an alternative', entry: 'Unknown', exit: 'Witness exists', check: 'exit' }, exec)
  await tool.execute({ action: 'run', id: 'optional' }, exec)
  assert.equal(m.blocks.length, 0)
})

test('refusals are not retried as alternate-model capability failures', async t => {
  const m = mock(t)
  m.result = { stopReason: 'refusal', output: [] }
  apply(m.ctx, m.config)
  const tool = m.tools.get('quest'), exec = { agent: m.parent, signal: new AbortController().signal }
  await tool.execute({ action: 'create', id: 'declined', objective: 'A declined task', entry: 'Unknown', exit: 'Witness exists', check: 'exit' }, exec)
  const result = JSON.parse((await tool.execute({ action: 'run', id: 'declined' }, exec)).text)
  assert.equal(result.status, 'error'); assert.equal(result.attempts, 1)
  assert.match(result.reason, /refusal/)
})

test('identical observations produce a logged advisory, never an automatic model switch', async t => {
  const m = mock(t); apply(m.ctx, m.config)
  const exec = { agent: m.parent, name: 'read_file', arguments: { path: 'same.txt' } }, result = { content: [{ type: 'text', text: 'unchanged' }] }
  for (let i = 0; i < 3; i++) m.hooks.get('tools/result')(exec, result)
  const decision = await m.hooks.get('agent/pre-step')({ agent: m.parent }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages[0].source.kind, 'quest-router')
  assert.match(decision.messages[0].content[0].text, /not proof/)
  assert.equal(m.starts.length, 0)
})
