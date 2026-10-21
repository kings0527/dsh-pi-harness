import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, runChild } from '../index.js'
import { Quest } from '../core/quest.js'
import { hash, projectPath } from '../core/store.js'
import { mock, report } from './helpers.js'

const owner = 'main'
function core(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quest-regression-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = `import fs from 'node:fs';let body='';for await(const c of process.stdin)body+=c;const {id}=JSON.parse(body);const name=id+'.proof';const accepted=fs.existsSync(name);console.log(JSON.stringify({accepted,facts:accepted?[{key:'exit',value:true,evidencePaths:[name]}]:[]}));\n`
  writeFileSync(join(root, 'verify.mjs'), script)
  const config = { routes: [{ id: 'flash', provider: 'p', model: 'flash', tier: 0, reasoningEffort: 'high' }], checks: { exit: { command: process.execPath, args: ['verify.mjs'], pins: { 'verify.mjs': hash(script) } } }, ...overrides }
  const create = (q, id, extra = {}) => q.create({ id, objective: 'Reach exit', entry: 'Known entry', exit: 'Independent witness', check: 'exit', ...extra }, owner)
  const proof = id => writeFileSync(join(root, `${id}.proof`), 'reproducible witness')
  const planned = req => { const plan = { hypothesis: report.hypothesis, discriminatingTest: `${report.discriminatingTest}: ${req.plan.method}`, expectedObservation: report.expectedObservation }; req.commitExperiment(plan); return { ...report, ...plan } }
  return { root, config, create, proof, planned }
}
function adapter(t, policy, overrides) {
  const m = mock(t, policy, overrides); apply(m.ctx, m.config)
  m.invoke = (args, signal = new AbortController().signal) => m.tools.get('quest').execute(args, { agent: m.parent, signal })
  m.create = (id = 'eight') => m.invoke({ action: 'create', id, objective: 'Reach nine', entry: 'Known entry', exit: 'Fixed witness', check: 'exit', blocksMainline: true })
  return m
}
const request = { id: 'eight', number: 1, plan: { provider: 'p', model: 'flash', reasoningEffort: 'high', method: 'forward' }, prompt: 'Capsule', commitExperiment: () => ({ committed: true }) }

test('a quest cannot block a replacement goal or a changed objective', async t => {
  const m = adapter(t); await m.create()
  m.setGoal({ id: 'goal-b', objective: 'Unrelated goal', revision: 1 })
  await assert.rejects(m.invoke({ action: 'run', id: 'eight' }), /binding/)
  assert.equal(m.blocks.length, 0); assert.equal(m.starts.length, 0)
  m.setGoal({ id: 'goal', objective: 'Edited objective', revision: 2 })
  await assert.rejects(m.invoke({ action: 'run', id: 'eight' }), /binding/)
  assert.equal(m.blocks.length, 0)
})

test('a goal changed during a child run is never blocked by the old result', async t => {
  const m = adapter(t); await m.create()
  const start = m.ctx.subagents.startActivation
  m.ctx.subagents.startActivation = async spec => { const activation = await start(spec); m.setGoal({ id: 'new-goal', objective: 'New objective' }); return activation }
  const result = JSON.parse((await m.invoke({ action: 'run', id: 'eight' })).text)
  assert.equal(result.status, 'detached'); assert.equal(m.starts.length, 1); assert.equal(m.blocks.length, 0); assert.equal(m.goal.phase, 'active')
})

test('goal pause and resume can continue a cancelled quest with its original budget', async t => {
  const m = adapter(t); await m.create()
  m.setGoal({ phase: 'paused', revision: 2 })
  const controller = new AbortController(); controller.abort()
  const cancelled = JSON.parse((await m.invoke({ action: 'run', id: 'eight' }, controller.signal)).text)
  assert.equal(cancelled.status, 'cancelled'); assert.equal(m.blocks.length, 0)
  m.setGoal({ phase: 'active', revision: 3 })
  const resumed = JSON.parse((await m.invoke({ action: 'run', id: 'eight' })).text)
  assert.equal(resumed.status, 'blocked'); assert.equal(resumed.attempts, 2); assert.equal(m.starts.length, 2)
})

test('preflight verifier errors block the bound current goal', async t => {
  const m = adapter(t); await m.create(); m.config.checks.exit.args.push('changed-mode')
  const result = JSON.parse((await m.invoke({ action: 'run', id: 'eight' })).text)
  assert.equal(result.status, 'error'); assert.match(result.reason, /Verifier configuration/)
  assert.equal(m.blocks.length, 1); assert.equal(m.goal.phase, 'blocked')
})

test('failed guard installation aborts startup even with contained lifecycle listeners', async t => {
  const m = mock(t, undefined, { guardThrows: true })
  await assert.rejects(runChild(m.ctx, m.config, m.parent, request), /guard registration failed/)
  assert.equal(m.starts[0].signal.aborted, true)
  assert.equal(m.childTools.size, 0)
})

test('an unavailable first route is filtered before scheduling an available alternate', async t => {
  const m = mock(t, [{ provider: 'p', model: 'glm' }])
  m.config.routes.push({ id: 'deep', provider: 'p', model: 'glm', reasoningEffort: 'high', tier: 1 })
  apply(m.ctx, m.config)
  const tool = m.tools.get('quest'), exec = { agent: m.parent, signal: new AbortController().signal }
  await tool.execute({ action: 'create', id: 'route', objective: 'Reach exit', entry: 'Known entry', exit: 'Witness', check: 'exit' }, exec)
  const result = JSON.parse((await tool.execute({ action: 'run', id: 'route' }, exec)).text)
  assert.equal(result.status, 'blocked'); assert.equal(m.starts.length, 2)
  assert.ok(m.starts.every(s => s.request.agentOptions.model === 'glm'))
})

test('attempt timeout includes capability lookup and host depth zero denies startup', async t => {
  const m = mock(t)
  m.ctx.subagents.resolveMaxDepth = () => 0
  await assert.rejects(runChild(m.ctx, m.config, m.parent, request), /depth/)
  assert.equal(m.starts.length, 0)
  m.ctx.subagents.resolveMaxDepth = () => 1
  m.config.attemptTimeoutMs = 20
  let observed
  m.ctx.llm.resolveCallConfig = async (_config, signal) => { observed = signal; await delay(500, undefined, { signal }) }
  await assert.rejects(runChild(m.ctx, m.config, m.parent, request), /abort/i)
  assert.equal(observed.aborted, true); assert.equal(m.starts.length, 0)
})

test('a damaged historical case is quarantined without resetting the session budget', async t => {
  const f = core(t), q = new Quest(f.root, f.config, async req => { const structured = f.planned(req); f.proof(req.id); return { stopReason: 'completed', structured } })
  f.create(q, 'damaged'); f.create(q, 'healthy')
  const damaged = join(f.root, '.quest-router/cases/damaged/events.jsonl')
  appendFileSync(damaged, '{"partial":')
  const before = readFileSync(damaged, 'utf8')
  assert.equal((await q.run('healthy', owner)).status, 'accepted')
  assert.equal(readFileSync(damaged, 'utf8'), before)
  assert.equal(q.store.scan().damaged[0].id, 'damaged')
  assert.equal(q.store.reserveAttempt(owner, 13, 12), false)
})

test('journal leaf links and dangling links never traverse outside the project', t => {
  const f = core(t), q = new Quest(f.root, f.config, null); f.create(q, 'links')
  const external = mkdtempSync(join(tmpdir(), 'quest-outside-')); t.after(() => rmSync(external, { recursive: true, force: true }))
  const journal = join(f.root, '.quest-router/cases/links/events.jsonl'), outside = join(external, 'journal')
  renameSync(journal, outside); symlinkSync(outside, journal)
  const before = readFileSync(outside, 'utf8')
  assert.throws(() => q.store.read('links'), /Symlink/)
  assert.throws(() => q.store.write('links', 'unsafe', s => s), /Symlink/)
  assert.equal(readFileSync(outside, 'utf8'), before)
  symlinkSync(join(external, 'does-not-exist'), join(f.root, 'dangling'))
  assert.throws(() => projectPath(f.root, 'dangling'), /Symlink/)
})

test('missing verifier logs revoke receipts and CLI never labels unchecked configuration accepted', async t => {
  const f = core(t), q = new Quest(f.root, f.config, null); f.create(q, 'receipt'); f.proof('receipt')
  assert.equal((await q.run('receipt', owner)).status, 'accepted')
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url))
  const cliStatus = () => JSON.parse(execFileSync(process.execPath, [cli, 'status', f.root], { encoding: 'utf8' })).cases[0].status
  assert.equal(cliStatus(), 'unverified')
  const certificate = q.store.read('receipt').state.certificate
  const verification = JSON.parse(readFileSync(join(f.root, certificate.verification.path), 'utf8'))
  unlinkSync(join(f.root, verification.logs.stdout.path))
  assert.equal(q.valid('receipt'), false); assert.equal(cliStatus(), 'stale')
})

test('large output is archived intact while oversized verifier JSON is rejected', async t => {
  const f = core(t, { maxCheckBytes: 1024 })
  const script = "process.stdout.write('x'.repeat(8*1024*1024))\n"
  writeFileSync(join(f.root, 'verify.mjs'), script); f.config.checks.exit.pins['verify.mjs'] = hash(script)
  const q = new Quest(f.root, f.config, null); f.create(q, 'large')
  const result = await q.run('large', owner)
  assert.equal(result.status, 'error'); assert.match(result.reason, /maxCheckBytes/)
  const stdout = result.reason.match(/full log: (.*)$/)[1]
  assert.equal(statSync(join(f.root, stdout)).size, 8 * 1024 * 1024)
  const archived = q.store.capture(stdout)
  assert.equal(archived.bytes, 8 * 1024 * 1024); assert.equal(archived.sha256, hash(Buffer.alloc(8 * 1024 * 1024, 'x')))
})

test('timeout cleanup kills descendants before releasing the workspace', { skip: process.platform === 'win32' }, async t => {
  const f = core(t, { checkTimeoutMs: 500, killGraceMs: 100 })
  const child = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('grandchild.pid',String(process.pid));setTimeout(()=>fs.writeFileSync('late-write','escaped'),1000);setInterval(()=>{},1000)"
  const script = `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)\n`
  writeFileSync(join(f.root, 'verify.mjs'), script); f.config.checks.exit.pins['verify.mjs'] = hash(script)
  const q = new Quest(f.root, f.config, null); f.create(q, 'timeout')
  let pid
  try {
    const result = await q.run('timeout', owner)
    assert.match(result.reason, /timeout=true/)
    assert.ok(existsSync(join(f.root, 'grandchild.pid')), 'descendant reached its signal handler before timeout')
    pid = Number(readFileSync(join(f.root, 'grandchild.pid'), 'utf8'))
    assert.equal(existsSync(join(f.root, '.quest-router/runner.lock')), false)
    await delay(1100)
    assert.equal(existsSync(join(f.root, 'late-write')), false)
  } finally { if (pid) try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
})

test('uncommitted or retrospectively changed experiments cannot be promoted', async t => {
  const f = core(t)
  const q = new Quest(f.root, f.config, async req => { f.proof(req.id); return { stopReason: 'completed', structured: report } })
  f.create(q, 'uncommitted')
  assert.match((await q.run('uncommitted', owner)).reason, /did not commit/)
  const changed = new Quest(f.root, f.config, async req => { const structured = f.planned(req); f.proof(req.id); return { stopReason: 'completed', structured: { ...structured, hypothesis: 'An explanation invented after observing the result' } } })
  f.create(changed, 'changed')
  assert.match((await changed.run('changed', owner)).reason, /changed the committed/)
  assert.equal(changed.store.read('changed').state.certificate, null)
})

test('outer whitespace is not a fresh experiment on the same route and evidence', async t => {
  const f = core(t, { maxAttempts: 2 })
  const q = new Quest(f.root, f.config, async req => {
    const plan = { hypothesis: 'Same hypothesis', discriminatingTest: 'Same test', expectedObservation: 'Same observation' }
    req.commitExperiment(req.number === 1 ? plan : { ...plan, hypothesis: '  Same hypothesis ' })
    return { stopReason: 'completed', structured: { ...report, ...plan } }
  })
  f.create(q, 'duplicate')
  assert.match((await q.run('duplicate', owner)).reason, /Duplicate experiment/)
})

test('custom task strategies run with an experiment recorded before filesystem changes', async t => {
  const f = core(t, { strategies: { 'call-graph': 'Trace the exact caller and callee constraints before testing.' }, methods: ['call-graph'] })
  const q = new Quest(f.root, f.config, async req => {
    assert.match(req.prompt, /caller and callee constraints/)
    const structured = f.planned(req)
    assert.ok(q.store.read(req.id).state.attempts.at(-1).experiment)
    f.proof(req.id)
    return { stopReason: 'completed', structured }
  })
  f.create(q, 'strategy'); assert.equal((await q.run('strategy', owner)).status, 'accepted')
})

test('automatic repeat entry starts scoped experiments and blocks exhausted goal without transcript leakage', async t => {
  const m = adapter(t, undefined, { config: { autoQuest: { check: 'exit', onGoalRound: false } } })
  const exec = { agent: m.parent, name: 'read_file', arguments: { path: 'same' } }, result = { content: [{ type: 'text', text: 'unchanged' }] }
  for (let n = 0; n < 3; n++) m.hooks.get('tools/result')(exec, result)
  const decision = await m.hooks.get('agent/pre-step')({ agent: m.parent, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(m.starts.length, 2); assert.equal(m.goal.phase, 'blocked')
  assert.match(decision.messages[0].content[0].text, /automaticQuest/)
  assert.ok(!JSON.stringify(decision).includes('PRIVATE CHILD OUTPUT'))
})

test('automatic goal entry rejects stale rounds and runs the configured blocker for a current round', async t => {
  const m = adapter(t, undefined, { config: { autoQuest: { check: 'exit' } } })
  const enter = async source => m.hooks.get('agent/pre-step')({ agent: m.parent, signal: new AbortController().signal, messages: [{ source }] }, async () => ({ kind: 'enter', messages: [] }))
  await enter({ kind: 'goal', goalId: 'old-goal', revision: 1, round: 1 }); assert.equal(m.starts.length, 0)
  await enter({ kind: 'goal', goalId: m.goal.id, revision: m.goal.revision, round: 1 }); assert.equal(m.starts.length, 2)
})

test('automatic configuration errors block only the captured goal and start no worker', async t => {
  const m = adapter(t, undefined, { config: { autoQuest: { check: 'exit', inputs: ['missing-input'] } } })
  const goal = m.goal
  await m.hooks.get('agent/pre-step')({ agent: m.parent, signal: new AbortController().signal, messages: [{ source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 } }] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(m.starts.length, 0); assert.equal(m.goal.phase, 'blocked')
})

test('a large capsule can be read progressively before the experiment is committed', async t => {
  const f = core(t, { maxCapsuleBytes: 1024 })
  const q = new Quest(f.root, f.config, async req => {
    assert.ok(JSON.parse(req.prompt).fullCapsule)
    let offset = 0, text = ''
    do { const part = req.readContext({ offset, length: 1000 }); text += part.text; offset = part.nextOffset } while (offset !== null)
    assert.equal(JSON.parse(text).contract.entry, 'LONG ENTRY '.repeat(2000))
    assert.throws(() => req.readContext({ length: 100000 }), /Invalid context range/)
    const structured = f.planned(req); f.proof(req.id)
    return { stopReason: 'completed', structured }
  })
  f.create(q, 'capsule', { entry: 'LONG ENTRY '.repeat(2000) })
  assert.equal((await q.run('capsule', owner)).status, 'accepted')
})

test('the worker can read its capsule but cannot use workspace tools before committing', async t => {
  const m = mock(t), on = m.parent.ctx.on
  m.parent.ctx.on = (name, fn, options) => on(name, info => {
    fn(info)
    assert.match(m.guards.at(-1)({ name: 'read_file' }), /commit/)
    assert.equal(m.guards.at(-1)({ name: 'quest_context' }), undefined)
    assert.equal(m.guards.at(-1)({ name: 'quest_experiment' }), undefined)
  }, options)
  await runChild(m.ctx, m.config, m.parent, request)
})

test('cancellation after dispatch preserves spent leases on resume and across case IDs', async t => {
  const f = core(t, { maxSessionAttempts: 2 }), controller = new AbortController()
  const q = new Quest(f.root, f.config, async req => {
    const structured = f.planned(req)
    if (req.number === 1) controller.abort()
    else f.proof(req.id)
    return { stopReason: 'completed', structured }
  })
  f.create(q, 'resumable')
  assert.equal((await q.run('resumable', owner, controller.signal)).status, 'cancelled')
  assert.equal((await q.run('resumable', owner)).status, 'accepted')
  assert.equal(q.store.read('resumable').state.attempts.length, 2)
  f.create(q, 'new-case')
  const blocked = await q.run('new-case', owner)
  assert.equal(blocked.reason, 'session-attempt-budget'); assert.equal(blocked.attempts, 0)
})

test('resuming an exhausted automatic goal keeps its case ID and spent budget', async t => {
  const m = adapter(t, undefined, { config: { autoQuest: { check: 'exit' } } })
  const step = () => m.hooks.get('agent/pre-step')({ agent: m.parent, signal: new AbortController().signal, messages: [{ source: { kind: 'goal', goalId: m.goal.id, revision: m.goal.revision, round: 1 } }] }, async () => ({ kind: 'enter', messages: [] }))
  await step(); assert.equal(m.starts.length, 2)
  m.setGoal({ phase: 'active', revision: m.goal.revision + 1 })
  await step(); assert.equal(m.starts.length, 2); assert.equal(m.goal.phase, 'blocked')
  const status = JSON.parse((await m.invoke({ action: 'status' })).text)
  assert.equal(status.cases.length, 1); assert.equal(status.cases[0].attempts, 2)
})

test('new evidence retains a productive alternate even when a cheaper route shares its tier', async t => {
  const { configuration, evidenceVersion, nextPlan } = await import('../core/policy.js')
  const config = configuration({ routes: [{ id: 'cheap', provider: 'p', model: 'flash', cost: 1 }, { id: 'alternate', provider: 'p', model: 'deep', cost: 4 }] })
  const state = { epoch: 1, contractHash: 'contract', facts: [], attempts: [] }
  for (let n = 0; n < 3; n++) {
    const plan = nextPlan(state, config)
    state.attempts.push({ ...plan, epoch: 1, outcome: 'rejected', novelFacts: n === 2 ? 1 : 0 })
  }
  assert.equal(state.attempts[2].routeId, 'alternate')
  state.facts.push({ key: 'new-observation', value: true })
  assert.notEqual(evidenceVersion(state), state.attempts[2].evidenceVersion)
  assert.equal(nextPlan(state, config).routeId, 'alternate')
})

test('a verified result for an old goal is archived without promoting it to a replacement goal', async t => {
  const m = adapter(t)
  const script = "import fs from 'node:fs';const accepted=fs.existsSync('witness');console.log(JSON.stringify({accepted,facts:accepted?[{key:'exit',value:true,evidencePaths:['witness']}]:[]}))\n"
  writeFileSync(join(m.root, 'verify.mjs'), script); m.config.checks.exit.pins['verify.mjs'] = hash(script)
  await m.create()
  const start = m.ctx.subagents.startActivation
  m.ctx.subagents.startActivation = async spec => {
    const activation = await start(spec)
    writeFileSync(join(m.root, 'witness'), 'old goal result')
    m.setGoal({ id: 'replacement', objective: 'Unrelated new objective' })
    return activation
  }
  const result = JSON.parse((await m.invoke({ action: 'run', id: 'eight' })).text)
  assert.equal(result.status, 'detached'); assert.equal(result.storedStatus, 'accepted')
  assert.equal(result.certificate, undefined); assert.equal(result.conclusion, undefined)
  assert.equal(m.blocks.length, 0); assert.equal(m.goal.phase, 'active')
  const archived = JSON.parse((await m.invoke({ action: 'status', id: 'eight' })).text)
  assert.equal(archived.status, 'accepted'); assert.equal(archived.goalRef.id, 'goal')
})
