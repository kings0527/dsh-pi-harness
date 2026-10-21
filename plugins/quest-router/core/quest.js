import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { METHODS, configuration, nextPlan } from './policy.js'
import { Store, hash, idOf, projectPath } from './store.js'
import { runCheck } from './check.js'

function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
}

export const REPORT_SCHEMA = {
  type: 'object', properties: { hypothesis: { type: 'string' }, discriminatingTest: { type: 'string' }, expectedObservation: { type: 'string' }, conclusion: { type: 'string' }, limitations: { type: 'array', items: { type: 'string' } } },
  required: ['hypothesis', 'discriminatingTest', 'expectedObservation', 'conclusion', 'limitations'], additionalProperties: false,
}

export class Quest {
  constructor(root, config, runner) {
    this.store = new Store(root)
    this.config = configuration(config)
    this.runner = runner
  }

  own(id, owner) {
    const row = this.store.read(id)
    if (row.state.owner !== owner) throw new Error(`Quest ${id} belongs to another session; inspect its journal before taking over`)
    return row
  }

  create(args, owner) {
    idOf(args.id)
    const contract = {
      objective: nonempty(args.objective, 'objective'), entry: nonempty(args.entry, 'entry'), exit: nonempty(args.exit, 'exit'),
      check: nonempty(args.check, 'check'), assumptions: args.assumptions ?? [], dependsOn: args.dependsOn ?? [],
      inputs: (args.inputs ?? []).map(name => this.store.capture(name)),
    }
    if (!Array.isArray(contract.assumptions) || contract.assumptions.some(x => typeof x !== 'string')) throw new Error('assumptions must be strings')
    if (!Array.isArray(contract.dependsOn) || new Set(contract.dependsOn).size !== contract.dependsOn.length) throw new Error('dependsOn must be distinct quest ids')
    if (!this.config.checks[contract.check]) throw new Error(`Configure a pinned verifier named ${contract.check} first`)
    contract.verifierHash = hash(JSON.stringify(this.config.checks[contract.check]))
    for (const id of contract.dependsOn) this.store.read(idOf(id))
    if (args.parent) this.own(args.parent, owner)
    return this.store.write(args.id, 'created', before => {
      if (before) throw new Error(`Quest ${args.id} already exists`)
      return { id: args.id, owner, parent: args.parent ?? null, blocksMainline: args.blocksMainline === true, contract, contractHash: hash(JSON.stringify(contract)), epoch: 1, status: 'open', facts: [], attempts: [], baseline: null, certificate: null, reason: null, lease: null }
    }, 0)
  }

  /** Compare dependencies recursively, so a partial cascade cannot make a stale certificate valid. */
  valid(id, seen = new Set()) {
    if (seen.has(id)) throw new Error('Dependency cycle')
    const state = this.store.read(id).state
    if (state.status !== 'accepted' || !state.certificate) return false
    if (!this.config.checks[state.contract.check] || state.contract.verifierHash !== hash(JSON.stringify(this.config.checks[state.contract.check]))) return false
    const refs = [state.certificate.ref, state.certificate.verification, ...state.certificate.evidence.flatMap(f => f.evidence)]
    for (const ref of refs) {
      const file = projectPath(this.store.root, ref.path)
      if (!existsSync(file) || hash(readFileSync(file)) !== ref.sha256) return false
      if (ref.originalPath) {
        const current = projectPath(this.store.root, ref.originalPath)
        if (!existsSync(current) || hash(readFileSync(current)) !== ref.sha256) return false
      }
    }
    for (const [name, expected] of Object.entries(state.certificate.verifierPins)) {
      const file = projectPath(this.store.root, name)
      if (!existsSync(file) || hash(readFileSync(file)) !== expected) return false
    }
    const next = new Set(seen).add(id)
    return Object.entries(state.certificate.dependencies).every(([dep, digest]) => {
      const upstream = this.store.read(dep).state
      return upstream.certificate?.digest === digest && this.valid(dep, next)
    })
  }

  dependencies(state) {
    return Object.fromEntries(state.contract.dependsOn.map(id => {
      if (!this.valid(id)) throw new Error(`Dependency ${id} is unverified or invalidated`)
      return [id, this.store.read(id).state.certificate.digest]
    }))
  }

  depend(id, dependencies, owner) {
    const row = this.own(id, owner)
    if (row.state.status === 'running') throw new Error('Cannot change dependencies during a run')
    const visit = (dep, seen = new Set()) => {
      if (dep === id) throw new Error('Dependency cycle')
      if (seen.has(dep)) return
      seen.add(dep)
      this.store.read(idOf(dep)).state.contract.dependsOn.forEach(next => visit(next, seen))
    }
    if (!Array.isArray(dependencies) || !dependencies.length) throw new Error('dependsOn must be nonempty')
    dependencies.forEach(dep => visit(dep))
    return this.store.write(id, 'dependencies-revised', state => {
      state.contract.dependsOn = [...new Set([...state.contract.dependsOn, ...dependencies])]
      state.contractHash = hash(JSON.stringify(state.contract))
      state.epoch++; state.status = 'open'; state.certificate = null; state.baseline = null; state.facts = []; state.reason = null
      return state
    }, row.seq)
  }

  invalidate(id, owner, reason) {
    const row = this.own(id, owner)
    if (row.state.status === 'running') throw new Error('Cancel the active quest tool before invalidating it')
    nonempty(reason, 'reason')
    this.store.write(id, 'invalidated', state => {
      state.epoch++; state.status = 'open'; state.reason = reason; state.certificate = null; state.baseline = null; state.facts = []
      return state
    }, row.seq)
    // The recursive validity check is authoritative even if this cosmetic cascade is interrupted.
    for (const dependent of this.store.list()) {
      if (dependent.status === 'accepted' && !this.valid(dependent.id)) {
        this.store.write(dependent.id, 'dependency-invalidated', state => ({ ...state, status: 'stale', reason: `Upstream ${id}: ${reason}` }))
      }
    }
    return this.store.read(id).state
  }

  card(id) {
    const state = this.store.read(id).state
    const valid = state.status === 'accepted' && this.valid(id)
    return { id, status: state.status === 'accepted' && !valid ? 'stale' : state.status, attempts: state.attempts.length,
      reason: state.reason, journal: `.quest-router/cases/${id}/events.jsonl`,
      ...(valid ? { verifiedBy: state.contract.check, conclusion: state.certificate.conclusion, limitations: state.certificate.limitations, certificate: state.certificate.ref } : {}) }
  }

  capsule(state, plan, dependencies) {
    const capsule = JSON.stringify({
      instruction: 'Solve only this experiment. Choose a falsifiable hypothesis and a discriminating test with a predicted observation before trying a fix; return those fields in the structured report. The exit condition belongs to the pinned verifier. Do not claim the main goal is complete. Use evidence; do not ask to switch models merely because time passed. Do not write Board/knowledge/handoff or message the parent. The shared working directory is not a sandbox; keep changes scoped to this experiment.',
      quest: state.id, contractHash: state.contractHash, contract: state.contract, reportMaxUtf8Bytes: this.config.maxConclusionBytes,
      dependencies: Object.entries(dependencies).map(([id, digest]) => ({ id, digest, certificate: this.store.read(id).state.certificate.ref })),
      method: plan.method, methodInstruction: METHODS[plan.method],
      observations: state.facts,
      attempts: state.attempts.filter(a => a.epoch === state.epoch).map(a => ({ route: a.routeId, method: a.method, experiment: a.experiment ?? null, outcome: a.outcome, newFacts: a.novelFacts, raw: a.raw ?? null, check: a.check ?? null })),
      artifactPolicy: 'Raw prior attempts are references, not injected transcripts. Read them only when needed. A new persona name does not count as a new method.',
    }, null, 2)
    if (Buffer.byteLength(capsule) <= this.config.maxCapsuleBytes) return capsule
    return JSON.stringify({ quest: state.id, contractHash: state.contractHash, method: plan.method,
      methodInstruction: METHODS[plan.method], fullCapsule: this.store.blob(capsule),
      instruction: 'The complete task capsule is preserved at this file reference. Read its contract and relevant evidence progressively. Do not import the whole prior experiment transcript. Return the required structured report.' })
  }

  async run(id, owner, signal) {
    this.own(id, owner)
    const lock = projectPath(this.store.root, '.quest-router/runner.lock')
    mkdirSync(this.store.base, { recursive: true })
    try { mkdirSync(lock) } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another quest owns this project workspace; wait or inspect runner.lock after a crash')
      throw error
    }
    writeFileSync(`${lock}/owner.json`, JSON.stringify({ id, owner, pid: process.pid, started: Date.now() }))
    try { return await this.execute(id, owner, signal) } finally {
      // Keep the lock directory empty so rmdir cannot remove an unrelated replacement.
      unlinkSync(`${lock}/owner.json`); rmdirSync(lock)
    }
  }

  async execute(id, owner, signal) {
    let row = this.own(id, owner)
    if (row.state.status === 'accepted' && this.valid(id)) return this.card(id)
    if (row.state.status === 'running') throw new Error('Previous run outcome is unknown; inspect the child and journal before recovery')
    if (row.state.status !== 'open') return this.card(id)
    const dependencies = this.dependencies(row.state)
    const check = this.config.checks[row.state.contract.check]
    if (!check || row.state.contract.verifierHash !== hash(JSON.stringify(check))) throw new Error('Verifier configuration changed; create a new quest with the revised acceptance condition')
    const lease = hash(`${Date.now()}-${Math.random()}`)
    this.store.write(id, 'run-start', state => ({ ...state, status: 'running', lease }), row.seq)
    try {
      let state = this.store.read(id).state
      if (!state.baseline) {
        const baseline = await runCheck(this.store, check, this.config, { id, epoch: state.epoch, number: 0, contract: state.contract, candidate: null }, signal)
        state = this.store.write(id, 'baseline', s => ({ ...s, baseline, facts: baseline.facts }))
        if (baseline.accepted) return this.accept(id, lease, dependencies, { conclusion: 'Exit condition was already satisfied at baseline; no model attempt was needed.', limitations: [] }, baseline)
      }
      while (true) {
        if (signal?.aborted) throw new Error('Quest cancelled')
        state = this.store.read(id).state
        const used = this.store.list().filter(s => s.owner === owner).reduce((n, s) => n + s.attempts.length, 0)
        const plan = used >= this.config.maxSessionAttempts ? { blocked: 'session-attempt-budget' } : nextPlan(state, this.config)
        if (plan.blocked) {
          this.store.write(id, 'blocked', s => ({ ...s, status: 'blocked', reason: plan.blocked, lease: null }))
          return this.card(id)
        }
        const number = state.attempts.length + 1
        const attempt = { number, epoch: state.epoch, key: plan.key, routeId: plan.routeId, tier: plan.tier, method: plan.method, evidenceVersion: plan.evidenceVersion, outcome: 'running', novelFacts: 0 }
        this.store.write(id, 'attempt-start', s => ({ ...s, attempts: [...s.attempts, attempt] }))
        const prompt = this.capsule(state, plan, dependencies)
        const promptRef = this.store.blob(prompt)
        const child = await this.runner({ id, number, plan, prompt, promptRef, signal })
        const raw = this.store.blob(child)
        this.store.write(id, 'child-result', s => { Object.assign(s.attempts.at(-1), { raw, promptRef, childId: child.childId ?? null }); return s })
        if (signal?.aborted) throw new Error('Quest cancelled; partial output retained')
        if (child.stopReason !== 'completed') {
          this.store.write(id, 'child-unfinished', s => {
            Object.assign(s.attempts.at(-1), { outcome: child.stopReason === 'error' ? 'infrastructure-error' : 'unfinished', raw, childId: child.childId ?? null, promptRef })
            return s
          })
          if (['error', 'aborted', 'refusal'].includes(child.stopReason)) throw new Error(`Child ended with ${child.stopReason}; revise the execution or task scope before continuing`)
          continue
        }
        const report = child.structured
        if (!report || !['hypothesis', 'discriminatingTest', 'expectedObservation', 'conclusion'].every(key => typeof report[key] === 'string' && report[key].trim()) || !Array.isArray(report.limitations) || report.limitations.some(x => typeof x !== 'string') || Buffer.byteLength(JSON.stringify(report)) > this.config.maxConclusionBytes) {
          this.store.write(id, 'invalid-report', s => { Object.assign(s.attempts.at(-1), { outcome: 'invalid-report', raw, promptRef }); return s })
          continue
        }
        this.store.write(id, 'experiment-report', s => {
          s.attempts.at(-1).experiment = { hypothesis: report.hypothesis, discriminatingTest: report.discriminatingTest, expectedObservation: report.expectedObservation }
          return s
        })
        const checked = await runCheck(this.store, check, this.config, { id, epoch: state.epoch, number, contract: state.contract, candidate: report }, signal)
        const novel = checked.facts.filter(f => !state.facts.some(old => old.key === f.key && old.value === f.value))
        const checkRef = this.store.blob(checked)
        this.store.write(id, 'attempt-verified', s => {
          // Preserve first observations and add new key/value pairs; never count changed log bytes as progress.
          for (const fact of novel) if (!s.facts.some(old => old.key === fact.key && old.value === fact.value)) s.facts.push(fact)
          Object.assign(s.attempts.at(-1), { outcome: checked.accepted ? 'candidate' : 'rejected', novelFacts: novel.length, raw, promptRef, check: checkRef, childId: child.childId ?? null })
          return s
        })
        if (checked.accepted) return this.accept(id, lease, dependencies, report, checked)
      }
    } catch (error) {
      this.store.write(id, 'execution-error', state => {
        if (state.attempts.at(-1)?.outcome === 'running') Object.assign(state.attempts.at(-1), { outcome: 'infrastructure-error' })
        return { ...state, status: signal?.aborted ? 'cancelled' : 'error', reason: error.message, lease: null }
      })
      return this.card(id)
    }
  }

  accept(id, lease, dependencies, report, checked) {
    const state = this.store.read(id).state
    if (state.lease !== lease || hash(JSON.stringify(this.dependencies(state))) !== hash(JSON.stringify(dependencies))) throw new Error('Dependency or run lease changed; candidate cannot be promoted')
    const certificate = {
      id, epoch: state.epoch, contractHash: state.contractHash, dependencies,
      conclusion: report.conclusion, limitations: report.limitations, check: state.contract.check,
      interpretation: { hypothesis: report.hypothesis ?? null, discriminatingTest: report.discriminatingTest ?? null, expectedObservation: report.expectedObservation ?? null },
      verifierPins: this.config.checks[state.contract.check].pins,
      evidence: checked.facts, verification: this.store.blob(checked),
    }
    const ref = this.store.blob(certificate)
    this.store.write(id, 'accepted', s => ({ ...s, status: 'accepted', lease: null, reason: null, certificate: { ...certificate, digest: ref.sha256, ref } }))
    return this.card(id)
  }
}
