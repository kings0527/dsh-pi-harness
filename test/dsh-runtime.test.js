// Optional contracts against an installed DSH, without touching live sessions.
// Set DSH_INSTALL_ANCHOR to its package.json. An asar install needs Electron's
// ELECTRON_RUN_AS_NODE=1 mode so its archive paths resolve normally.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import * as bridge from '../index.js'
import { fixture, host } from './fixtures.js'

const anchor = process.env.DSH_INSTALL_ANCHOR
const runtime = anchor ? createRequire(anchor) : null
const installed = { skip: !runtime && 'set DSH_INSTALL_ANCHOR to run installed DSH contracts' }

test('installed DSH Session accepts reference messages and replayed compaction recovery', installed, async (t) => {
  const { Session } = runtime('@deepseek-ai/dsh-session')
  const f = fixture(t)
  f.topic('work', [{ content: 'REAL_SESSION_PLAN', kind: 'plan' }])
  f.handoff()
  let session = Session.create('bridge-contract')
  const h = host(f.root, { session })
  bridge.apply(h.ctx, { doctrine: false })
  await h.step()
  let messages = session.deriveMessages()
  assert.equal(messages.length, 1)
  assert.match(messages[0].content[0].text, /REAL_SESSION_PLAN/)
  const seqs = [...session.surface.nodes]
  session.append('user/message', {
    id: 'compact-contract', role: 'user', time: Date.now(),
    content: [{ type: 'text', text: 'Compacted background' }], source: { kind: 'compact', form: 'checkpoint' },
  }, { surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs.at(-1) }, sourceEventSeqs: seqs })
  await h.request()
  messages = session.deriveMessages()
  assert.equal(messages.filter((entry) => entry.source.kind === 'pi-harness').length, 1)
  assert.match(messages.at(-1).content[0].text, /NEXT_ACTION/)
  // Construct the same canonical surface from the durable seed, then reload
  // the bridge. Recovered message IDs and ordering survive DSH's own fold.
  session = Session.fromRestore('bridge-contract', session.snapshotEvents(), session.header, session.inheritedEventCount)
  const resumed = host(f.root, { session })
  bridge.apply(resumed.ctx, { doctrine: false })
  await resumed.step({ turn: 2 })
  assert.match(session.deriveMessages().at(-1).content[0].text, /REAL_SESSION_PLAN/)
})

test('installed Cordis keeps bridge mounted while optional goals appear and disappear', installed, async (t) => {
  const { Context } = runtime('@deepseek-ai/cordis')
  const { Session } = runtime('@deepseek-ai/dsh-session')
  const f = fixture(t)
  f.topic('work', [{ content: 'PLAN', kind: 'plan' }])
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('workingDirectory', { get: () => f.root, ensure: async () => f.root })
  ctx.provide('systemPrompt', { section: () => () => {} })
  const mounted = ctx.plugin(bridge, { doctrine: false })
  const fiber = await mounted
  t.after(() => fiber.dispose())
  assert.equal(fiber.state, 2)
  const agent = { id: 'cordis-contract', session: Session.create('cordis-contract') }
  async function pre(turn) {
    return ctx.waterfall('agent/pre-step', { agent, turn, step: 0 }, async () => ({ kind: 'enter', messages: [] }))
  }
  const first = await pre(1)
  assert.equal(first.messages.length, 1)
  agent.session.append('user/message', first.messages[0], { surfaceOp: 'append' })
  const disposeGoal = ctx.provide('goals', { get: () => ({ id: 'g', phase: 'active', revision: 1, objective: 'INSTALLED_GOAL' }) })
  await new Promise(setImmediate)
  const anchored = await pre(2)
  assert.match(anchored.messages[0].content[0].text, /INSTALLED_GOAL/)
  agent.session.append('user/message', anchored.messages[0], { surfaceOp: 'append' })
  await disposeGoal()
  const without = await pre(3)
  assert.equal(fiber.state, 2)
  assert.ok(!without.messages[0].content[0].text.includes('INSTALLED_GOAL'))
})

test('installed prompt registry actually renders the autonomous Board and knowledge workflow', installed, async (t) => {
  const { Context } = runtime('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = runtime('@deepseek-ai/dsh-system-prompt')
  const f = fixture(t)
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('workingDirectory', { get: () => f.root, ensure: async () => f.root })
  const registry = await ctx.plugin(SystemPrompt, {})
  const mounted = await ctx.plugin(bridge, { injectReference: false })
  t.after(async () => { await mounted.dispose(); await registry.dispose() })
  const prompt = renderPrompt(await ctx.systemPrompt.assemble())
  assert.match(prompt, /Use Board and knowledge proactively/)
  assert.match(prompt, /post a `plan` before proceeding/)
  assert.match(prompt, /knowledge action=add/)
  assert.match(prompt, /Respect plan mode and read-only restrictions/)
  assert.equal(prompt.split('# Board and Knowledge Workflow').length - 1, 1)
})
