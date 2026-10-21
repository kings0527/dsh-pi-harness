import { randomUUID } from 'node:crypto'
import { Quest, REPORT_SCHEMA } from './core/quest.js'
import { configuration } from './core/policy.js'
import { hash } from './core/store.js'

export const name = 'quest-router'
export const inject = ['tools', 'workingDirectory', 'subagents', 'llm', 'systemPrompt']

const text = value => ({ text: JSON.stringify(value, null, 2) })
const render = (_args, value) => [{ type: 'text', text: value.text }]
const blockedTools = new Set(['quest', 'board', 'knowledge', 'handoff', 'subagent', 'send_message', 'followup_task'])

/** Uses DSH's fresh spawn API, caller-only delivery, and the configured exact model routes. */
export async function runChild(ctx, config, parent, request) {
  const provider = ctx.subagents.getProvider(config.backend)
  if (!provider || provider.inheritsParentContext || !provider.capabilities.agentOptions || !provider.capabilities.outputSchema || !provider.capabilities.depthLimit) throw new Error('quest-router requires the fresh spawn backend with structured output and route selection')
  const route = request.plan
  const policy = ctx.get('sessionProjections')?.stateOf(parent.session, 'subagentModelSelectionPolicy')
  if (policy && !policy.some(r => r.provider === route.provider && r.model === route.model)) throw new Error(`Session policy does not allow ${route.provider}/${route.model}`)
  const options = { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort, ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}) }
  await ctx.llm.resolveCallConfig(options, request.signal)
  request.signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(config.attemptTimeoutMs)
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  // This listener is scoped to the exact parent and installed only during this exclusive start.
  const remove = parent.ctx.on('subagent/start', info => {
    const child = ctx.get('agents')?.get(info.id)
    if (!child) throw new Error('Fresh local child was not visible at subagent/start')
    child.ctx.tools.guard(exec => blockedTools.has(exec.name) ? 'Quest workers submit to their caller; shared Board and delegation tools are unavailable in this experiment.' : undefined)
    child.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      return { ...decision, messages: decision.messages.filter(message => message.source?.kind !== 'pi-harness') }
    }, { prepend: true })
  })
  let activation
  try {
    activation = await ctx.subagents.startActivation({
      provider: config.backend, label: `quest:${request.id}/${request.number}:${route.method}`,
      request: { parent, prompt: [{ type: 'text', text: request.prompt }], agentOptions: options,
        outputSchema: REPORT_SCHEMA, maxDepth: (parent.session.header.delegationDepth ?? 0) + 1,
        ...(config.workerPreset ? { agentPreset: config.workerPreset } : {}) },
      signal, delivery: 'caller',
    })
  } finally { remove() }
  try {
    return { ...(await activation.result), childId: String(activation.childId), requestedRoute: options }
  } finally { await activation.dispose() }
}

export function apply(ctx, input = {}) {
  const config = configuration(input)
  // Explicit effort prevents a route change from inheriting another provider's effort setting.
  for (const route of config.routes) if (typeof route.reasoningEffort !== 'string' || !route.reasoningEffort) throw new Error(`Route ${route.id} needs reasoningEffort; inspect list_subagent_models for the adapter-owned value`)
  const repeats = new Map()
  const service = async exec => {
    if (!exec.agent) throw new Error('quest needs a live DSH session')
    const root = await ctx.workingDirectory.ensure(exec.agent)
    return new Quest(root, config, request => runChild(ctx, config, exec.agent, request))
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'quest-router', order: 910,
    text: 'For a blocked step with competing hypotheses, open a quest with entry facts, an exit condition and a configured verifier. quest run owns fresh-context experiments and evidence-gated model routing. Its certificate is scoped to that step, not completion of the main goal. Keep raw attempts out of Board; copy only a verified certificate reference when needed. Logical nesting uses quest dependencies, not recursive worker delegation.',
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'quest', description: 'Isolated experiments. create: define entry/exit and pinned check; run: external scheduler tries methods/routes until verified or blocked; status; depend: add prerequisite quests; invalidate: revoke and reopen with reason. Raw attempts stay in the journal.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['create', 'run', 'status', 'depend', 'invalidate'] },
      id: { type: 'string' }, objective: { type: 'string' }, entry: { type: 'string' }, exit: { type: 'string' }, check: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } }, inputs: { type: 'array', items: { type: 'string' } },
      parent: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
      blocksMainline: { type: 'boolean', description: 'Bind an exhausted/error experiment to the main goal blocker; otherwise other mainline work may continue.' },
    }, required: ['action'] },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const quest = await service(exec)
      const owner = String(exec.agent.id)
      if (args.action === 'status') return text(args.id ? quest.card(args.id) : quest.store.list().filter(s => s.owner === owner).map(s => quest.card(s.id)))
      if (args.action === 'create') { quest.create(args, owner); return text(quest.card(args.id)) }
      if (args.action === 'depend') { quest.depend(args.id, args.dependsOn, owner); return text(quest.card(args.id)) }
      if (args.action === 'invalidate') { quest.invalidate(args.id, owner, args.reason); return text(quest.card(args.id)) }
      if (args.action !== 'run') throw new Error('Unknown quest action')
      const result = await quest.run(args.id, owner, exec.signal)
      if (config.blockGoalOnExhaustion && ['blocked', 'error', 'cancelled', 'stale'].includes(result.status) && quest.store.read(args.id).state.blocksMainline) {
        const goals = ctx.get('goals')
        if (!goals) throw new Error(`Quest ${args.id} stopped (${result.reason}); goal service is unavailable, so automatic continuation could not be blocked`)
        const goal = goals.get(exec.agent)
        if (goal?.phase === 'active') goals.block(exec.agent, { id: goal.id, revision: goal.revision }, { code: 'quest-blocked', message: `${args.id}: ${result.reason ?? result.status}; inspect the evidence and revise the experiment or resources before resuming.` })
      }
      return text(result)
    },
  }))

  // Repeated byte-identical observations are only an advisory signal, never evidence of model exhaustion.
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || exec.name === 'quest' || /wait|poll/.test(exec.name) || result.isError) return
    const id = String(exec.agent.id)
    const fingerprint = hash(JSON.stringify([exec.name, exec.arguments, result.content]))
    const old = repeats.get(id)
    repeats.set(id, { fingerprint, count: old?.fingerprint === fingerprint ? old.count + 1 : 1, pending: old?.fingerprint === fingerprint ? old.pending : false })
    const state = repeats.get(id)
    if (state.count === config.repeatToolResults) state.pending = true
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const state = repeats.get(String(payload.agent.id))
    if (decision.kind !== 'enter' || !state?.pending) return decision
    state.pending = false
    return { ...decision, messages: [...decision.messages, {
      id: randomUUID(), role: 'user', time: Date.now(), content: [{ type: 'text', text: 'Runtime observation: the same tool input returned the same output repeatedly. This is a stall hint, not proof of exhausted model capability. If this is expected polling, keep the wait explicit. Otherwise define a distinguishing experiment, or open a quest with a configured exit verifier. Changing a persona name alone is not a new experiment.' }],
      source: { kind: 'quest-router', form: 'observation', summary: 'Repeated unchanged tool observation' },
    }] }
  })
}
