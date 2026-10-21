import { hash } from './store.js'

export const METHODS = {
  forward: 'Trace a concrete input forward through the causal chain. Record the first divergence from the expected observation.',
  backward: 'Start at the failed exit condition, derive its necessary preconditions, and test which precondition is false.',
  minimize: 'Reduce the failing example or environment to the smallest reproduction that distinguishes competing hypotheses.',
  falsify: 'Challenge a specific assumed premise. Design an observation that would refute it; do not merely propose another fix.',
}

/** Deployment choices belong in configuration; method names describe behavior, not neural experts. */
export function configuration(input = {}) {
  const config = {
    backend: 'spawn', routes: [], checks: {}, methods: Object.keys(METHODS),
    maxAttempts: 12, maxSessionAttempts: 48, stagnantAttempts: 2, attemptTimeoutMs: 600000,
    checkTimeoutMs: 60000, maxCheckBytes: 65536, maxConclusionBytes: 2400, maxCapsuleBytes: 16384,
    repeatToolResults: 3, blockGoalOnExhaustion: true, workerPreset: undefined,
    ...input,
  }
  for (const key of ['maxAttempts', 'maxSessionAttempts', 'stagnantAttempts', 'attemptTimeoutMs', 'checkTimeoutMs', 'maxCheckBytes', 'maxConclusionBytes', 'maxCapsuleBytes', 'repeatToolResults']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`)
  }
  if (config.backend !== 'spawn') throw new Error('v0.1 supports the fresh in-process spawn backend only')
  if (!Array.isArray(config.methods) || !config.methods.length || new Set(config.methods).size !== config.methods.length || config.methods.some(m => !METHODS[m])) throw new Error('Invalid methods')
  if (!Array.isArray(config.routes)) throw new Error('routes must be an array')
  const ids = new Set()
  config.routes = config.routes.map(route => {
    if (!route || !['id', 'provider', 'model'].every(k => typeof route[k] === 'string' && route[k].trim())) throw new Error('Each route needs id, provider and model')
    if (ids.has(route.id)) throw new Error(`Duplicate route: ${route.id}`)
    ids.add(route.id)
    const tier = route.tier ?? 0
    const cost = route.cost ?? 1
    if (!Number.isSafeInteger(tier) || tier < 0 || !Number.isFinite(cost) || cost <= 0) throw new Error('Invalid route tier/cost')
    return { ...route, tier, cost }
  }).sort((a, b) => a.tier - b.tier || a.cost - b.cost || a.id.localeCompare(b.id))
  for (const [name, check] of Object.entries(config.checks)) {
    if (!check || typeof check.command !== 'string' || !check.command || !Array.isArray(check.args) || check.args.some(x => typeof x !== 'string')) throw new Error(`Invalid check ${name}`)
    if (!check.pins || !Object.keys(check.pins).length || Object.values(check.pins).some(h => !/^[a-f0-9]{64}$/.test(h))) throw new Error(`Check ${name} needs explicit SHA256 pins`)
  }
  return config
}

export const evidenceVersion = state => hash(JSON.stringify(state.facts.map(f => [f.key, f.value]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))))

/** Select an untried method on this evidence version; promote route tier only after validated stagnation. */
export function nextPlan(state, config) {
  if (state.attempts.length >= config.maxAttempts) return { blocked: 'attempt-budget' }
  if (!config.routes.length) return { blocked: 'no-configured-routes' }
  const version = evidenceVersion(state)
  const attempts = state.attempts.filter(a => a.epoch === state.epoch && a.outcome !== 'infrastructure-error')
  const last = attempts.at(-1)
  const floor = last?.tier ?? config.routes[0].tier
  for (const route of config.routes.filter(r => r.tier >= floor)) {
    const stagnant = attempts.filter(a => a.routeId === route.id && a.evidenceVersion === version && a.novelFacts === 0)
    if (stagnant.length >= config.stagnantAttempts && new Set(stagnant.map(a => a.method)).size >= Math.min(2, config.methods.length)) continue
    for (const method of config.methods) {
      const key = hash(JSON.stringify([state.contractHash, state.epoch, version, route.id, route.provider, route.model, route.reasoningEffort ?? null, method]))
      if (!state.attempts.some(a => a.key === key)) return { ...route, routeId: route.id, method, evidenceVersion: version, key }
    }
  }
  return { blocked: 'configured-routing-policy-exhausted' }
}
