import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configuration } from '../core/policy.js'
import { hash } from '../core/store.js'

export const report = { hypothesis: 'An exit witness can be produced', discriminatingTest: 'Read the witness', expectedObservation: 'Witness matches the fixed requirement', conclusion: 'Worker claims success', limitations: [] }
export function mock(t, policy, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quest-adapter-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tools = new Map(), hooks = new Map(), parentHooks = new Map(), childHooks = new Map(), childTools = new Map(), guards = [], starts = [], resolved = [], blocks = [], registrations = [], warnings = [], agents = new Map()
  const on = map => (name, fn, options) => { registrations.push({ map, name, options, fn }); map.set(name, fn); return () => map.delete(name) }
  const parent = { id: 'main', options: {}, session: { header: { delegationDepth: 0 } }, ctx: { on: on(parentHooks) } }
  let disposals = 0, goal = { id: 'goal', revision: 1, objective: 'Reach a fixed exit', phase: 'active', activation: 'armed' }, result
  const ctx = {
    effect: fn => fn(), on: on(hooks), tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: () => () => {} }, workingDirectory: { ensure: async () => root },
    get: name => name === 'agents' ? agents : name === 'sessionProjections' ? { stateOf: () => policy } : name === 'goals' ? { get: () => goal && ({ ...goal }), block: (...args) => {
      if (args[1].id !== goal.id || args[1].revision !== goal.revision) throw new Error('Stale goal CAS')
      blocks.push(args); goal = { ...goal, phase: 'blocked', revision: goal.revision + 1 }
    } } : undefined,
    llm: { resolveCallConfig: async (config, signal) => { signal?.throwIfAborted(); resolved.push(config); return config } },
    subagents: {
      resolveMaxDepth: () => 1,
      getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      startActivation: async spec => {
        starts.push(spec)
        const child = { id: spec.childId, ctx: { on: on(childHooks), tools: {
          guard: fn => { if (overrides.guardThrows) throw Error('guard registration failed'); guards.push(fn); return () => {} },
          presentAs: mode => { if (mode !== 'native') throw Error('Unexpected tool presentation'); return () => {} },
          register: definition => { childTools.set(definition.name, definition); return () => childTools.delete(definition.name) },
        } } }
        agents.set(spec.childId, child)
        // DSH contains lifecycle listener exceptions and checks signal before admitting input.
        try { parentHooks.get('subagent/start')?.({ id: spec.childId, local: true }) } catch (error) { warnings.push(error.message) }
        spec.signal.throwIfAborted()
        let response = result
        if (!response) {
          const proposal = { hypothesis: report.hypothesis, discriminatingTest: `${report.discriminatingTest}: ${spec.label.split(':').at(-1)}`, expectedObservation: report.expectedObservation }
          await childTools.get('quest_experiment').execute(proposal, { agent: child, signal: spec.signal })
          response = { stopReason: 'completed', structured: { ...report, ...proposal }, output: [{ type: 'text', text: 'PRIVATE CHILD OUTPUT' }] }
        }
        return { childId: spec.childId, result: Promise.resolve(response), dispose: async () => { disposals++; agents.delete(spec.childId) } }
      },
    },
  }
  const script = 'console.log(JSON.stringify({accepted:false,facts:[]}))\n'
  writeFileSync(join(root, 'verify.mjs'), script)
  const config = configuration({ maxAttempts: 2, routes: [{ id: 'cheap', provider: 'p', model: 'flash', reasoningEffort: 'high' }], checks: { exit: { command: process.execPath, args: ['verify.mjs'], pins: { 'verify.mjs': hash(script) } } }, ...overrides.config })
  return { root, ctx, config, parent, tools, hooks, guards, starts, resolved, blocks, childHooks, childTools, registrations, warnings,
    get disposals() { return disposals }, get result() { return result }, set result(value) { result = value }, get goal() { return goal }, setGoal: value => { goal = value === null ? null : { ...goal, ...value } },
  }
}
