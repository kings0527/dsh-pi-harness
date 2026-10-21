import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Quest as Engine } from '../core/quest.js'
import { hash, projectPath, Store } from '../core/store.js'
import { configuration, nextPlan } from '../core/policy.js'

const owner = 'main-session'
const report = { hypothesis: 'A missing precondition blocks the exit', discriminatingTest: 'Observe the exit witness', expectedObservation: 'A reproducible exit witness', conclusion: 'Candidate result', limitations: ['Only the configured exit condition was checked.'] }

// Simulated solvers obey the same pre-tool proposal protocol as real DSH workers.
class Quest extends Engine {
  constructor(root, config, runner) {
    super(root, config, runner && (async req => {
      const proposal = { hypothesis: report.hypothesis, discriminatingTest: `${report.discriminatingTest}: ${req.plan.method}`, expectedObservation: report.expectedObservation }
      req.commitExperiment(proposal)
      const result = await runner(req)
      return { ...result, ...(result.structured ? { structured: { ...result.structured, ...proposal } } : {}) }
    }))
  }
}

export function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quest-router-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = `import fs from 'node:fs'; let input=''; for await (const c of process.stdin) input+=c;
const req=JSON.parse(input); const name=req.id+'.proof.json';
const state=fs.existsSync(name)?JSON.parse(fs.readFileSync(name,'utf8')):{accepted:false,facts:[]};
console.log(JSON.stringify({accepted:state.accepted,facts:state.facts.map(f=>({...f,evidencePaths:[name]}))}));\n`
  writeFileSync(join(root, 'verify.mjs'), script)
  const config = {
    routes: [
      { id: 'cheap', provider: 'test', model: 'flash', tier: 0, cost: 1, reasoningEffort: 'high' },
      { id: 'alternate', provider: 'test', model: 'deep', tier: 1, cost: 4, reasoningEffort: 'max' },
    ], checks: { exit: { command: process.execPath, args: ['verify.mjs'], pins: { 'verify.mjs': hash(script) } } },
    ...overrides,
  }
  const proof = (id, accepted, facts = []) => writeFileSync(join(root, `${id}.proof.json`), JSON.stringify({ accepted, facts }))
  const create = (q, id = 'step-eight', extra = {}) => q.create({ id, objective: 'Reach step nine', entry: 'Steps one through seven are conditional premises', exit: 'Pinned verifier accepts the evidence', check: 'exit', ...extra }, owner)
  return { root, config, proof, create }
}

test('verified stagnation tries different methods before escalating and keeps raw output out of mainline', async t => {
  const f = fixture(t), calls = []
  const q = new Quest(f.root, f.config, async req => {
    calls.push(req)
    if (calls.length === 3) f.proof('step-eight', true, [{ key: 'exit-reproduced', value: true }])
    return { stopReason: 'completed', structured: report, output: [{ type: 'text', text: 'RAW-PRIVATE-ATTEMPT '.repeat(10000) }] }
  })
  f.create(q)
  const card = await q.run('step-eight', owner)
  assert.equal(card.status, 'accepted')
  assert.deepEqual(calls.map(r => [r.plan.routeId, r.plan.method]), [['cheap', 'forward'], ['cheap', 'backward'], ['alternate', 'forward']])
  assert.ok(!JSON.stringify(card).includes('RAW-PRIVATE'))
  assert.ok(!calls[2].prompt.includes('RAW-PRIVATE'))
  assert.ok(calls[2].prompt.includes('.quest-router/blobs/'))
  const state = q.store.read('step-eight').state
  assert.ok(readFileSync(projectPath(f.root, state.attempts[0].raw.path), 'utf8').includes('RAW-PRIVATE'))
  assert.ok(q.valid('step-eight'))
})

test('new verifier facts retain the current model; byte changes without facts do not', async t => {
  const f = fixture(t), calls = []
  const q = new Quest(f.root, f.config, async req => {
    calls.push(req)
    if (calls.length === 1) f.proof('step-eight', false, [{ key: 'reachable-edge-17', value: true }])
    if (calls.length === 2) f.proof('step-eight', true, [{ key: 'reachable-edge-17', value: true }, { key: 'exit', value: true }])
    return { stopReason: 'completed', structured: report }
  })
  f.create(q)
  assert.equal((await q.run('step-eight', owner)).status, 'accepted')
  assert.deepEqual(calls.map(r => r.plan.routeId), ['cheap', 'cheap'])
  assert.notEqual(calls[0].plan.evidenceVersion, calls[1].plan.evidenceVersion)
})

test('a worker success claim cannot complete the quest and a blocked quest does not restart', async t => {
  const f = fixture(t, { maxAttempts: 2 }), calls = []
  const q = new Quest(f.root, f.config, async req => { calls.push(req); return { stopReason: 'completed', structured: { ...report, conclusion: 'SUCCESS! Everything is done.', limitations: [] } } })
  f.create(q)
  assert.equal((await q.run('step-eight', owner)).status, 'blocked')
  await q.run('step-eight', owner)
  assert.equal(calls.length, 2)
  assert.equal(q.store.read('step-eight').state.certificate, null)
})

test('baseline success is identified without crediting a model', async t => {
  const f = fixture(t), q = new Quest(f.root, f.config, async () => assert.fail('baseline should not spawn'))
  f.create(q); f.proof('step-eight', true, [{ key: 'already-satisfied', value: true }])
  const card = await q.run('step-eight', owner)
  assert.equal(card.status, 'accepted'); assert.equal(card.attempts, 0)
  assert.match(card.conclusion, /already satisfied/)
})

test('transport failures stop the run without capability escalation', async t => {
  const f = fixture(t), q = new Quest(f.root, f.config, async () => ({ stopReason: 'error', diagnostic: 'Connection failed' }))
  f.create(q)
  const card = await q.run('step-eight', owner)
  assert.equal(card.status, 'error'); assert.equal(card.attempts, 1)
  assert.equal(q.store.read('step-eight').state.attempts[0].outcome, 'infrastructure-error')
})

test('a modified verifier cannot launder a claimed success; raw result remains reachable', async t => {
  const f = fixture(t), q = new Quest(f.root, f.config, async () => {
    writeFileSync(join(f.root, 'verify.mjs'), 'console.log(JSON.stringify({accepted:true,facts:[]}))')
    return { stopReason: 'completed', structured: report }
  })
  f.create(q)
  const card = await q.run('step-eight', owner)
  assert.equal(card.status, 'error'); assert.match(card.reason, /pin changed/)
  assert.ok(q.store.read('step-eight').state.attempts[0].raw)
})

test('upstream invalidation and changed evidence revoke dependent certificates', async t => {
  const f = fixture(t), q = new Quest(f.root, f.config, async () => assert.fail())
  f.create(q, 'upstream'); f.proof('upstream', true, [{ key: 'upstream-ok', value: true }]); await q.run('upstream', owner)
  f.create(q, 'downstream', { dependsOn: ['upstream'] }); f.proof('downstream', true, [{ key: 'downstream-ok', value: true }]); await q.run('downstream', owner)
  assert.ok(q.valid('downstream'))
  f.proof('upstream', false)
  assert.equal(q.valid('upstream'), false); assert.equal(q.card('downstream').status, 'stale')
  q.invalidate('upstream', owner, 'The upstream premise was falsified')
  assert.equal(q.card('downstream').status, 'stale')
})

test('dependency changes while a child runs prevent promotion', async t => {
  const f = fixture(t)
  const q = new Quest(f.root, f.config, async () => {
    q.invalidate('upstream', owner, 'New counterevidence')
    f.proof('downstream', true, [{ key: 'downstream-ok', value: true }])
    return { stopReason: 'completed', structured: report }
  })
  f.create(q, 'upstream'); f.proof('upstream', true, [{ key: 'upstream-ok', value: true }]); await q.run('upstream', owner)
  f.create(q, 'downstream', { dependsOn: ['upstream'] })
  const card = await q.run('downstream', owner)
  assert.equal(card.status, 'error'); assert.match(card.reason, /Dependency/)
  assert.equal(q.store.read('downstream').state.certificate, null)
})

test('nested logical cases can use one scheduler and dependency cycles are rejected', t => {
  const f = fixture(t), q = new Quest(f.root, f.config, null)
  f.create(q, 'parent'); f.create(q, 'child', { parent: 'parent' })
  q.depend('parent', ['child'], owner)
  assert.throws(() => q.depend('child', ['parent'], owner), /cycle/)
  assert.throws(() => q.invalidate('parent', 'other-session', 'guess'), /another session/)
})

test('project execution is serialized across cases and locks release after cancellation', async t => {
  const f = fixture(t), controller = new AbortController()
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  const q = new Quest(f.root, f.config, async () => { entered(); await wait; return { stopReason: 'aborted' } })
  f.create(q, 'one'); f.create(q, 'two')
  const running = q.run('one', owner, controller.signal)
  await started
  await assert.rejects(q.run('two', owner), /owns this project workspace/)
  controller.abort(); release()
  assert.equal((await running).status, 'cancelled')
  assert.equal(existsSync(join(f.root, '.quest-router/runner.lock')), false)
})

test('truncated journals and path escapes fail visibly', t => {
  const f = fixture(t), q = new Quest(f.root, f.config, null)
  f.create(q)
  appendFileSync(join(f.root, '.quest-router/cases/step-eight/events.jsonl'), '{"partial":')
  assert.throws(() => q.card('step-eight'), /Incomplete journal/)
  assert.throws(() => q.store.capture('../outside'), /escapes/)
  assert.throws(() => q.store.read('../bad'), /id must/)
})

test('route exhaustion describes only configured search space, never all model capability', t => {
  const config = configuration({ routes: [{ id:'a',provider:'p',model:'m' }], methods: ['forward'] })
  const state = { contractHash:'x', epoch:1, facts:[], attempts:[] }
  const plan = nextPlan(state, config)
  state.attempts.push({ ...plan, epoch:1, outcome:'rejected', novelFacts:0 })
  assert.equal(nextPlan(state, config).blocked, 'configured-routing-policy-exhausted')
})

test('stagnation can choose a complementary model in the same tier', async t => {
  const f = fixture(t), calls = []
  f.config.routes[1].tier = 0
  const q = new Quest(f.root, f.config, async req => {
    calls.push(req.plan.routeId)
    if (req.plan.routeId === 'alternate') f.proof('step-eight', true, [{ key:'exit', value:true }])
    return { stopReason:'completed', structured:report }
  })
  f.create(q)
  assert.equal((await q.run('step-eight', owner)).status, 'accepted')
  assert.deepEqual(calls, ['cheap','cheap','alternate'])
})

test('large capsules preserve the complete contract through an explicit file reference', t => {
  const f = fixture(t, { maxCapsuleBytes:1024 }), q = new Quest(f.root, f.config, null)
  f.create(q, 'step-eight', { entry:'LONG-ENTRY '.repeat(2000) })
  const state = q.store.read('step-eight').state
  const prompt = JSON.parse(q.capsule(state, nextPlan(state, q.config), {}))
  assert.ok(prompt.fullCapsule)
  const original = readFileSync(projectPath(f.root, prompt.fullCapsule.path), 'utf8')
  assert.equal(JSON.parse(original).contract.entry, 'LONG-ENTRY '.repeat(2000))
  assert.equal(hash(original), prompt.fullCapsule.sha256)
})

test('changing verifier configuration cannot reuse the old contract', async t => {
  const f = fixture(t), q = new Quest(f.root, f.config, async () => assert.fail())
  f.create(q)
  q.config.checks.exit.args.push('changed-mode')
  const result = await q.run('step-eight', owner)
  assert.equal(result.status, 'error'); assert.match(result.reason, /Verifier configuration changed/)
})

test('an accepted verdict with no evidence cannot enter the mainline', async t => {
  const f = fixture(t)
  const script = 'console.log(JSON.stringify({accepted:true,facts:[]}))\n'
  writeFileSync(join(f.root,'verify.mjs'),script)
  f.config.checks.exit.pins['verify.mjs'] = hash(script)
  const q = new Quest(f.root, f.config, async () => assert.fail())
  f.create(q)
  const card = await q.run('step-eight', owner)
  assert.equal(card.status,'error'); assert.match(card.reason,/Acceptance needs/)
})

test('verifier timeout is an execution failure, not evidence to upgrade the model', async t => {
  const f = fixture(t, { checkTimeoutMs:50 })
  const script = 'setInterval(()=>{},1000)\n'
  writeFileSync(join(f.root,'verify.mjs'),script)
  f.config.checks.exit.pins['verify.mjs'] = hash(script)
  const q = new Quest(f.root, f.config, async () => assert.fail())
  f.create(q)
  const card = await q.run('step-eight', owner)
  assert.equal(card.status,'error'); assert.match(card.reason,/timeout=true/)
  assert.equal(card.attempts,0)
})

test('corrupt certificate bytes revoke an otherwise accepted result', async t => {
  const f = fixture(t), q = new Quest(f.root, f.config, async () => assert.fail())
  f.create(q); f.proof('step-eight',true,[{key:'exit',value:true}])
  await q.run('step-eight',owner)
  const ref = q.store.read('step-eight').state.certificate.ref
  writeFileSync(projectPath(f.root,ref.path),'corrupt')
  assert.equal(q.card('step-eight').status,'stale')
})

test('creating a new case id cannot reset the shared session attempt budget', async t => {
  const f = fixture(t, { maxAttempts:2, maxSessionAttempts:2 }), calls = []
  const q = new Quest(f.root, f.config, async req => { calls.push(req); return { stopReason:'completed', structured:report } })
  f.create(q,'first'); await q.run('first',owner)
  f.create(q,'renamed-copy')
  const card = await q.run('renamed-copy',owner)
  assert.equal(card.status,'blocked'); assert.equal(card.reason,'session-attempt-budget')
  assert.equal(calls.length,2)
})
