import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, runChild } from '../index.js'
import { configuration } from '../core/policy.js'
import { hash } from '../core/store.js'

function mock(t, policy) {
  const root = mkdtempSync(join(tmpdir(), 'quest-adapter-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tools = new Map(), hooks = new Map(), parentHooks = new Map(), childHooks = new Map(), guards = [], starts = [], resolved = [], blocks = [], registrations = []
  const on = map => (name, fn, options) => { registrations.push({ map, name, options }); map.set(name, fn); return () => map.delete(name) }
  const parent = { id: 'main', session: { header: { delegationDepth: 0 } }, ctx: { on: on(parentHooks) } }
  const child = { id: 'child', ctx: { on: on(childHooks), tools: { guard: fn => { guards.push(fn); return () => {} } } } }
  let disposals = 0, phase = 'active'
  const report = { hypothesis: 'An exit witness can be produced', discriminatingTest: 'Read the witness', expectedObservation: 'Witness matches the fixed requirement', conclusion: 'Worker claims success', limitations: [] }
  const ctx = {
    effect: fn => fn(), on: on(hooks),
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: () => () => {} }, workingDirectory: { ensure: async () => root },
    get: name => name === 'agents' ? new Map([['child', child]]) : name === 'sessionProjections' ? { stateOf: () => policy } : name === 'goals' ? { get: () => ({ id: 'goal', revision: 1, phase }), block: (...args) => { blocks.push(args); phase = 'blocked' } } : undefined,
    llm: { resolveCallConfig: async config => { resolved.push(config) } },
    subagents: {
      getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => {
        starts.push(spec); parentHooks.get('subagent/start')({ id: 'child', local: true })
        return { childId: 'child', result: Promise.resolve({ stopReason: 'completed', structured: report, output: [{ type: 'text', text: 'PRIVATE CHILD OUTPUT' }] }), dispose: async () => { disposals++ } }
      },
    },
  }
  const script = 'console.log(JSON.stringify({accepted:false,facts:[]}))\n'
  writeFileSync(join(root, 'verify.mjs'), script)
  const config = configuration({ maxAttempts: 2, routes: [{ id: 'cheap', provider: 'p', model: 'flash', reasoningEffort: 'high' }], checks: { exit: { command: process.execPath, args: ['verify.mjs'], pins: { 'verify.mjs': hash(script) } } } })
  return { ctx, config, parent, tools, hooks, guards, starts, resolved, blocks, childHooks, registrations, get disposals() { return disposals } }
}

test('fresh child delivery is caller-only; Board injection and worker delegation are gated', async t => {
  const m = mock(t)
  const result = await runChild(m.ctx, m.config, m.parent, { id: 'eight', number: 1, plan: { provider: 'p', model: 'flash', reasoningEffort: 'high', method: 'forward' }, prompt: 'CAPSULE', signal: new AbortController().signal })
  assert.equal(m.starts[0].delivery, 'caller')
  assert.equal(m.starts[0].provider, 'spawn')
  assert.equal(m.starts[0].request.prompt[0].text, 'CAPSULE')
  assert.equal(m.starts[0].request.maxDepth, 1)
  assert.equal(m.disposals, 1)
  assert.equal(m.registrations.find(r => r.map === m.childHooks && r.name === 'agent/pre-step').options.prepend, true)
  assert.equal(result.childId, 'child')
  assert.match(m.guards[0]({ name: 'board' }), /unavailable/)
  assert.match(m.guards[0]({ name: 'subagent' }), /unavailable/)
  assert.equal(m.guards[0]({ name: 'read_file' }), undefined)
  const decision = await m.childHooks.get('agent/pre-step')({}, async () => ({ kind: 'enter', messages: [{ source: { kind: 'pi-harness' }, content: 'GLOBAL BOARD' }, { source: { kind: 'user' }, content: 'CAPSULE' }] }))
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
  m.ctx.subagents.startActivation = async () => ({ childId: 'child', result: Promise.resolve({ stopReason: 'refusal', output: [] }), dispose: async () => {} })
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
