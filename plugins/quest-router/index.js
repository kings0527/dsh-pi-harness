import { randomUUID } from 'node:crypto'
import { Quest, REPORT_SCHEMA, EXPERIMENT_SCHEMA } from './core/quest.js'
import { configuration } from './core/policy.js'
import { hash } from './core/store.js'

export const name = 'quest-router'
export const inject = ['tools', 'workingDirectory', 'subagents', 'llm', 'systemPrompt']
const text = value => ({ text: JSON.stringify(value, null, 2) })
const render = (_args, value) => [{ type: 'text', text: value.text }]
const blockedTools = new Set(['quest', 'board', 'knowledge', 'handoff', 'goal', 'subagent', 'send_message', 'followup_task'])
const managedWorkers = new Set()
const goalRef = goal => goal ? { id: goal.id, revision: goal.revision, objectiveHash: hash(goal.objective ?? '') } : null
const sameObjective = (bound, goal) => bound && goal && bound.id === goal.id && bound.objectiveHash === hash(goal.objective ?? '')
const sameRevision = (bound, goal) => sameObjective(bound, goal) && bound.revision === goal.revision

/** Timeout, cancellation and failed isolation all fence startup before the initial prompt is admitted. */
export async function runChild(ctx, config, parent, request) {
  const controller = new AbortController(), timeout = AbortSignal.timeout(config.attemptTimeoutMs)
  const signal = AbortSignal.any([controller.signal, timeout, ...(request.signal ? [request.signal] : [])])
  signal.throwIfAborted()
  const provider = ctx.subagents.getProvider(config.backend)
  if (!provider || provider.inheritsParentContext || !provider.capabilities.agentOptions || !provider.capabilities.outputSchema || !provider.capabilities.depthLimit) throw new Error('quest-router requires the fresh spawn backend with structured output and route selection')
  const route = request.plan
  const allowed = ctx.get('sessionProjections')?.stateOf(parent.session, 'subagentModelSelectionPolicy')
  if (allowed && !allowed.some(r => r.provider === route.provider && r.model === route.model)) throw new Error(`Session policy does not allow ${route.provider}/${route.model}`)
  if (typeof ctx.subagents.resolveMaxDepth !== 'function') throw new Error('DSH resolveMaxDepth API is required')
  const depth = Math.max(parent.session.header.delegationDepth ?? 0, parent.options?.subagentDepth ?? 0)
  const hostDepth = ctx.subagents.resolveMaxDepth(), maxDepth = Math.min(hostDepth ?? depth + 1, depth + 1)
  if (!Number.isSafeInteger(depth) || !Number.isSafeInteger(maxDepth) || depth < 0 || depth + 1 > maxDepth) throw new Error('Host delegation depth does not allow a quest worker')
  const options = { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort, ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}) }
  await ctx.llm.resolveCallConfig(options, signal)
  signal.throwIfAborted()
  const childId = randomUUID(), disposers = []
  request.reserveChild?.(childId)
  let ready = false, isolationError, committed = false, activation
  managedWorkers.add(childId)
  const remove = parent.ctx.on('subagent/start', info => {
    if (String(info.id) !== childId) return
    try {
      const child = ctx.get('agents')?.get(info.id)
      if (!child) throw new Error('Fresh local child was not visible at subagent/start')
      disposers.push(child.ctx.on('agent/pre-step', async (_payload, next) => {
        if (!ready || signal.aborted) return { kind: 'reject' }
        const decision = await next()
        return decision.kind === 'enter' ? { ...decision, messages: decision.messages.filter(message => message.source?.kind !== 'pi-harness') } : decision
      }, { prepend: true }))
      disposers.push(child.ctx.tools.guard(exec => {
        if (!ready || signal.aborted) return 'Quest worker isolation is not active.'
        if (blockedTools.has(exec.name)) return 'Quest workers submit to their caller; shared Board and delegation tools are unavailable in this experiment.'
        if (!committed && !['quest_experiment', 'quest_context'].includes(exec.name)) return 'First read the capsule with quest_context if needed, then call quest_experiment to commit a falsifiable hypothesis, discriminating test and expected observation.'
      }))
      // PTC-only presentation exposes run_code before nested tools, which cannot be admitted before the plan.
      // Give this child a native surface so both the commit gate and structured output remain reachable.
      disposers.push(child.ctx.tools.presentAs('native'))
      disposers.push(child.ctx.tools.register({
        name: 'quest_context', description: 'Read a bounded slice of the complete task capsule, including an oversized contract. Allowed before committing the experiment. Offsets count JavaScript string characters.',
        parameters: { type: 'object', properties: { offset: { type: 'integer' }, length: { type: 'integer' } } },
        output: { schema: { type: 'object', properties: { text: { type: 'string' }, nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] } }, required: ['text', 'nextOffset'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        isConcurrencySafe: () => true,
        async execute(args) { signal.throwIfAborted(); return request.readContext(args) },
      }))
      disposers.push(child.ctx.tools.register({
        name: 'quest_experiment', description: 'Commit the hypothesis, discriminating test and expected observation BEFORE using tools. Keep these exact fields in the final structured report. Duplicate experiments on the same route/evidence are rejected.',
        parameters: EXPERIMENT_SCHEMA,
        output: { schema: { type: 'object', properties: { committed: { type: 'boolean' } }, required: ['committed'] }, render: () => [{ type: 'text', text: 'Experiment committed. Execute the discriminating test and report the same hypothesis/test/prediction.' }] },
        isConcurrencySafe: () => false,
        async execute(proposal) {
          signal.throwIfAborted()
          if (typeof request.commitExperiment !== 'function') throw new Error('Experiment journal callback is unavailable')
          const result = request.commitExperiment(proposal)
          committed = true
          return result
        },
      }))
      ready = true
    } catch (error) {
      isolationError = error
      controller.abort(error) // DSH contains listener throws; cancellation is the admission fence.
    }
  })
  try {
    activation = await ctx.subagents.startActivation({
      provider: config.backend, childId, label: `quest:${request.id}/${request.number}:${route.method}`,
      request: { parent, prompt: [{ type: 'text', text: `${request.prompt}\nUse quest_context to progressively read the full task capsule if needed. Before workspace tools, call quest_experiment. The final report must retain the committed hypothesis/test/prediction.` }], agentOptions: options, outputSchema: REPORT_SCHEMA, maxDepth,
        ...(config.workerPreset ? { agentPreset: config.workerPreset } : {}) },
      signal, delivery: 'caller',
    })
    if (!ready || isolationError) throw isolationError ?? new Error('Worker isolation was not confirmed')
    signal.throwIfAborted()
    const result = await activation.result
    signal.throwIfAborted()
    return { ...result, childId: String(activation.childId), requestedRoute: options }
  } finally {
    remove()
    try { if (activation) await activation.dispose() }
    finally { for (const dispose of disposers.reverse()) dispose(); managedWorkers.delete(childId) }
  }
}

export function apply(ctx, input = {}) {
  const config = configuration(input), states = new Map()
  for (const route of config.routes) if (typeof route.reasoningEffort !== 'string' || !route.reasoningEffort) throw new Error(`Route ${route.id} needs reasoningEffort; inspect list_subagent_models for the adapter-owned value`)
  const currentGoal = agent => ctx.get('goals')?.get(agent)
  const stateFor = agent => {
    if (!states.has(agent)) states.set(agent, { fingerprint: null, count: 0, pending: false, delivered: new Set(), busy: false })
    return states.get(agent)
  }
  const service = async exec => {
    if (!exec.agent) throw new Error('quest needs a live DSH session')
    const root = await ctx.workingDirectory.ensure(exec.agent)
    const policy = ctx.get('sessionProjections')?.stateOf(exec.agent.session, 'subagentModelSelectionPolicy')
    const routes = policy ? config.routes.filter(route => policy.some(r => r.provider === route.provider && r.model === route.model)) : config.routes
    // Filtering the policy can yield no routes even when automatic entry is configured.
    const runtime = { ...config, autoQuest: null, routes }
    const quest = new Quest(root, runtime, request => {
      const state = quest.store.read(request.id).state
      if (state.blocksMainline && !sameObjective(state.goalRef, currentGoal(exec.agent))) throw new Error('Goal changed; no further experiment may start for the old objective')
      return runChild(ctx, config, exec.agent, request)
    })
    return quest
  }
  const block = (agent, ref, message) => {
    const goal = currentGoal(agent)
    if (config.blockGoalOnExhaustion && sameRevision(ref, goal) && goal.phase === 'active') ctx.get('goals').block(agent, { id: goal.id, revision: goal.revision }, { code: 'quest-blocked', message })
  }
  const run = async (quest, id, exec) => {
    const state = quest.own(id, String(exec.agent.id)).state, snapshot = goalRef(currentGoal(exec.agent))
    if (state.blocksMainline && !sameObjective(state.goalRef, currentGoal(exec.agent))) throw new Error('Quest goal binding is absent or changed; explicitly bind it before running for this goal')
    try {
      const result = await quest.run(id, String(exec.agent.id), exec.signal)
      if (state.blocksMainline && !sameObjective(snapshot, currentGoal(exec.agent))) return { id, status: 'detached', storedStatus: result.status, attempts: result.attempts, goalRef: state.goalRef, journal: result.journal, reason: 'Goal changed; this result is archived for its original objective and is not promoted to the new mainline.' }
      if (state.blocksMainline && ['blocked', 'error', 'stale'].includes(result.status) && !exec.signal?.aborted) block(exec.agent, snapshot, `${id}: ${result.reason ?? result.status}; inspect evidence and revise the experiment or resources.`)
      return result
    } catch (error) {
      if (state.blocksMainline && !exec.signal?.aborted) block(exec.agent, snapshot, `${id}: ${error.message}`)
      throw error
    }
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'quest-router', order: 910,
    text: `Use quest status to inspect configured checks and routes. For a blocked step, create a scoped quest with entry facts, an exit condition and a pinned check. quest run owns fresh experiments and model routing; workers must commit an experiment before using tools. Only promote its verified certificate to the mainline. Logical nesting uses dependencies. Configured checks: ${Object.keys(config.checks).join(', ') || '(none; configure before running)'}. Automatic entry: ${config.autoQuest ? `enabled for check ${config.autoQuest.check}` : 'disabled; configure autoQuest.check to enable'}. A step certificate does not complete the main goal.`,
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'quest', description: 'Scoped experiments: status includes configuration and damaged-case diagnostics; create; run (cancelled runs resume without resetting budgets); depend; invalidate; bind explicitly attaches a case to the current goal. Raw attempts stay in the journal.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['create', 'run', 'status', 'depend', 'invalidate', 'bind'] },
      id: { type: 'string' }, objective: { type: 'string' }, entry: { type: 'string' }, exit: { type: 'string' }, check: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } }, inputs: { type: 'array', items: { type: 'string' } }, parent: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
      blocksMainline: { type: 'boolean', description: 'Bind to this goal. Failed critical cases block that exact goal revision; optional cases do not.' },
    }, required: ['action'] },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render }, isConcurrencySafe: () => false,
    async execute(args, exec) {
      const quest = await service(exec), owner = String(exec.agent.id)
      if (args.action === 'status') {
        if (args.id) return text(quest.card(args.id))
        const { states: rows, damaged } = quest.store.scan()
        return text({ configuration: { routes: quest.config.routes, checks: Object.keys(config.checks), autoQuest: config.autoQuest }, cases: rows.filter(s => s.owner === owner).map(s => quest.card(s.id)), damaged })
      }
      if (args.action === 'create') {
        const goal = currentGoal(exec.agent)
        if (args.blocksMainline && !goal) throw new Error('blocksMainline requires a current goal')
        quest.create({ ...args, goalRef: args.blocksMainline ? goalRef(goal) : null }, owner)
      } else if (args.action === 'bind') {
        const goal = currentGoal(exec.agent), row = quest.own(args.id, owner)
        if (!goal || row.state.status === 'running') throw new Error('Binding requires a current goal and a stopped quest')
        quest.store.write(args.id, 'goal-bound', s => ({ ...s, blocksMainline: true, goalRef: goalRef(goal) }), row.seq)
      } else if (args.action === 'depend') quest.depend(args.id, args.dependsOn, owner)
      else if (args.action === 'invalidate') quest.invalidate(args.id, owner, args.reason)
      else if (args.action === 'run') return text(await run(quest, args.id, exec))
      else throw new Error('Unknown quest action')
      return text(quest.card(args.id))
    },
  }))
  ctx.on('agent/disposed', ({ agent }) => states.delete(agent))
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || managedWorkers.has(String(exec.agent.id)) || exec.name === 'quest' || /wait|poll/.test(exec.name)) return
    const bound = goalRef(currentGoal(exec.agent)), goalKey = JSON.stringify([bound?.id, bound?.objectiveHash])
    const state = stateFor(exec.agent), fingerprint = hash(JSON.stringify([goalKey, exec.name, exec.arguments, result.content, !!result.isError]))
    state.observation = { tool: exec.name, arguments: exec.arguments, content: result.content, isError: !!result.isError }
    state.observationGoal = goalKey
    state.count = state.fingerprint === fingerprint ? state.count + 1 : 1
    state.fingerprint = fingerprint
    state.pending = state.count >= config.repeatToolResults
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || managedWorkers.has(String(payload.agent.id))) return decision
    const state = stateFor(payload.agent), repeated = state.pending
    const goal = currentGoal(payload.agent), before = goalRef(goal)
    const continued = goal?.phase === 'active' && payload.messages?.some(({ source }) => source?.kind === 'goal' && source.goalId === goal.id && source.revision === goal.revision && source.round > 0)
    const auto = config.autoQuest, trigger = auto && (!goal || goal.phase === 'active') && ((auto.onRepeat && repeated) || (auto.onGoalRound && continued))
    if ((!repeated && !trigger) || state.busy) return decision
    state.pending = false
    const append = value => ({ ...decision, messages: [...decision.messages, { id: randomUUID(), role: 'user', time: Date.now(), content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], source: { kind: 'quest-router', form: 'observation', summary: 'Quest runtime checkpoint' } }] })
    if (!trigger || (!goal && !auto.objective)) return append('Repeated unchanged tool observation. This is not proof of exhausted model capability. Define a distinguishing experiment or configure autoQuest with a pinned check; polling alone does not trigger a model switch.')
    state.busy = true
    try {
      const quest = await service(payload), owner = String(payload.agent.id)
      payload.signal?.throwIfAborted()
      if (before && !sameRevision(before, currentGoal(payload.agent))) return { kind: 'reject' }
      const id = `auto-${hash(JSON.stringify([owner, before?.id, before?.objectiveHash, auto])).slice(0, 24)}`
      if (!quest.store.list().some(s => s.id === id)) {
        const observation = state.observationGoal === JSON.stringify([before?.id, before?.objectiveHash]) && state.observation ? quest.store.blob(state.observation) : null
        const entry = auto.entry ?? 'Continue only this configured blocker from the captured inputs and pinned verifier; preceding mainline conclusions remain conditional.'
        quest.create({ id, objective: auto.objective ?? goal.objective, entry: `${entry}${observation ? ` Runtime tool observation is unverified, not an established fact: ${observation.path}` : ''}`, exit: auto.exit ?? `Pinned check ${auto.check} accepts a reproducible witness`, check: auto.check, inputs: [...(auto.inputs ?? []), ...(observation ? [observation.path] : [])], blocksMainline: goal?.phase === 'active', goalRef: before }, owner)
      }
      const result = await run(quest, id, payload)
      if (payload.signal?.aborted || (before && !sameObjective(before, currentGoal(payload.agent)))) return { kind: 'reject' }
      const receipt = hash(JSON.stringify(result))
      if (state.delivered.has(receipt)) return decision
      state.delivered.add(receipt)
      return append({ automaticQuest: result })
    } catch (error) {
      if (payload.signal?.aborted) return { kind: 'reject' }
      block(payload.agent, before, `Automatic quest could not run: ${error.message}`)
      return append({ automaticQuestError: error.message })
    } finally { state.busy = false }
  })
}
