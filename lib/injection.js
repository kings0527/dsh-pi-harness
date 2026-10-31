// Proposal != delivery: advance receipts only after observing the message on
// the session's derived surface. Request retries also check that surface.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeGoalSignature, buildDelta, buildReference } from './reference.js'
import { findKnowledgeScope } from './knowledge.js'
import { ensureDir, exists, oneLine } from './util.js'

function message(text, form) {
  return {
    id: randomUUID(), role: 'user', time: Date.now(),
    content: [{ type: 'text', text }],
    source: { kind: 'pi-harness', form, summary: form === 'degraded' ? 'Reference temporarily unavailable' : 'Board / knowledge / handoff reference' },
  }
}

function includes(surface, expected) {
  return surface?.some((candidate) => candidate.id === expected.id && candidate.source?.kind === 'pi-harness' &&
    JSON.stringify(candidate.content) === JSON.stringify(expected.content))
}

export function createReferenceDelivery(ctx, settings, { now = Date.now } = {}) {
  const states = new WeakMap()
  let goalReader = null
  let goalWarning = false
  function stateFor(agent) {
    let state = states.get(agent)
    if (!state) {
      state = { root: null, current: null, pending: null, required: new Map(), lastTurn: -1, checkpointTurn: -1, failure: null, activeScopes: new Set(), scopeRevision: 0, deliveredScopeRevision: 0 }
      states.set(agent, state)
    }
    return state
  }
  function rootFor(agent) {
    if (!agent) throw new Error('This tool needs a live session (no agent scope was provided)')
    const state = stateFor(agent)
    state.root ??= ctx.workingDirectory.get(agent.session)
    return state.root
  }
  if (!settings.injectReference) return { stateFor, rootFor }

  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (!result?.isError && exec.agent && ['read', 'write', 'edit', 'read_file', 'write_file', 'edit_file'].includes(exec.name)) {
      try {
        const state = stateFor(exec.agent)
        const scope = findKnowledgeScope(rootFor(exec.agent), exec.arguments?.file_path ?? exec.arguments?.path)
        if (scope && !state.activeScopes.has(scope)) {
          state.activeScopes.add(scope)
          state.scopeRevision += 1
        }
      } catch { /* knowledge discovery must not change the tool outcome */ }
    }
    return result
  })

  // Cordis inject entries are required dependencies. A separate child fiber
  // makes goals explicitly optional without preventing Board tools from loading.
  ctx.inject?.(['goals'], (goalCtx) => {
    goalCtx.effect(() => {
      goalReader = (agent) => goalCtx.goals.get(agent)
      return () => { goalReader = null }
    })
  })
  function activeGoal(agent) {
    try {
      const goal = goalReader?.(agent)
      goalWarning = false
      return goal?.phase === 'active' ? goal : undefined
    } catch (error) {
      if (!goalWarning) ctx.logger?.warn?.(`pi-harness: goal anchor unavailable: ${oneLine(error.message, 160)}`)
      goalWarning = true
      return undefined
    }
  }
  const surfaceOf = (agent) => typeof agent.session?.deriveMessages === 'function' ? agent.session.deriveMessages() : null
  function commit(state, pending) {
    state.current = pending.built
    state.lastTurn = pending.turn
    state.deliveredScopeRevision = pending.scopeRevision
    if (pending.full) {
      state.required.clear()
      state.checkpointTurn = pending.turn
    }
    state.required.set(pending.message.id, pending.message)
    state.pending = null
    state.failure = null
  }
  function reconcile(state, surface) {
    if (state.pending && includes(surface, state.pending.message)) commit(state, state.pending)
    if (state.failure && includes(surface, state.failure.notice)) state.failure.notified = true
  }
  const missing = (state, surface) => surface !== null && [...state.required.values()].some((entry) => !includes(surface, entry))
  function fail(state, error) {
    if (!state.failure) {
      const detail = oneLine(error?.message ?? error, 160)
      state.failure = {
        count: 0, nextAt: 0, notified: false,
        notice: message(`Pi Harness reference temporarily unavailable: ${detail}. Reference delivery will retry automatically; Board, knowledge and handoff tools remain available.`, 'degraded'),
      }
      ctx.logger?.warn?.(`pi-harness: reference temporarily unavailable: ${detail}`)
      try {
        if (state.root && exists(state.root)) {
          ensureDir(join(state.root, '.pi-board'))
          writeFileSync(join(state.root, '.pi-board', 'dsh-inject-error.txt'), `${new Date().toISOString()}\n${detail}\n`, 'utf-8')
        }
      } catch { /* diagnostic output must not fail the turn */ }
    }
    state.failure.count += 1
    state.failure.nextAt = now() + Math.min(30000, (settings.retryBaseMs ?? 1000) * 2 ** Math.min(5, state.failure.count - 1))
  }
  const canRetry = (state) => !state.failure || now() >= state.failure.nextAt
  const noticeFor = (state, surface) => state.failure && !state.failure.notified && !includes(surface, state.failure.notice) ? state.failure.notice : null
  async function build(state, payload, full) {
    state.root ??= await ctx.workingDirectory.ensure(payload.agent)
    const options = {
      goal: activeGoal(payload.agent),
      activeScopes: [...state.activeScopes],
      budgetTokens: settings.referenceBudgetTokens,
    }
    const built = full ? buildReference(state.root, options) : buildDelta(state.root, state.current, options)
    if (!built?.text) return null
    const pending = {
      built, full, turn: payload.turn, step: payload.step,
      message: message(built.text, full ? 'reference' : 'delta'), offered: false, scopeRevision: state.scopeRevision,
    }
    state.pending = pending
    return pending
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || !payload.agent || payload.signal?.aborted) return decision
    const state = stateFor(payload.agent)
    let surface = null
    try {
      surface = surfaceOf(payload.agent)
      reconcile(state, surface)
      // No derived-surface API on an older host: use the periodic fallback.
      if (surface === null && state.pending?.offered && state.pending.turn !== payload.turn) commit(state, state.pending)
      if (state.pending) {
        const pending = state.pending
        if (pending.turn === payload.turn && pending.step === payload.step && !pending.offered) {
          return { ...decision, messages: [...decision.messages.filter((entry) => entry.id !== pending.message.id), pending.message] }
        }
        // A rejected/unadmitted proposal must not advance the cursor or turn.
        state.pending = null
      }
      if (canRetry(state)) {
        const lost = missing(state, surface)
        const goalChanged = activeGoalSignature(activeGoal(payload.agent)) !== (state.current?.goal ?? '')
        const stale = settings.checkpointEveryTurns > 0 && payload.turn - state.checkpointTurn >= settings.checkpointEveryTurns
        if (!state.current || lost || stale || state.lastTurn !== payload.turn || goalChanged || state.scopeRevision !== state.deliveredScopeRevision) {
          const pending = await build(state, payload, !state.current || lost || stale)
          if (pending) return { ...decision, messages: [...decision.messages, pending.message] }
        }
      }
    } catch (error) {
      if (payload.signal?.aborted) return decision
      fail(state, error)
    }
    const notice = noticeFor(state, surface)
    if (notice) state.failure.proposed = { turn: payload.turn, step: payload.step, offered: false }
    return notice ? { ...decision, messages: [...decision.messages, notice] } : decision
  })

  // prepareRequest runs on every model attempt. Overflow compaction can shadow
  // an admitted reference after pre-step; restore it before the retry's request
  // is frozen. No session/event callback is used as an async commit barrier.
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    if (!payload.agent || payload.signal?.aborted) return config
    const state = stateFor(payload.agent)
    let surface = null
    let proposedNotice = false
    try {
      surface = surfaceOf(payload.agent)
      reconcile(state, surface)
      const proposed = state.failure?.proposed
      if (proposed && !proposed.offered && proposed.turn === payload.turn && proposed.step === payload.step) {
        proposed.offered = true
        proposedNotice = true
      }
      if (state.pending) {
        const pending = state.pending
        if (!pending.offered && pending.turn === payload.turn && pending.step === payload.step) {
          // Compaction in prepareRequest can also invalidate the baseline of
          // a not-yet-admitted delta. Upgrade that very proposal in place: the
          // loop still owns its position after the real user's messages.
          if (!pending.full && missing(state, surface)) {
            const upgraded = await build(state, payload, true)
            if (upgraded) {
              Object.assign(pending.message, upgraded.message)
              upgraded.message = pending.message
              upgraded.offered = true
              return config
            }
          }
          // The loop admits decision.messages immediately after this first
          // prepareRequest. Do not append a second copy ahead of the real user.
          pending.offered = true
          return config
        }
        if (surface === null) commit(state, pending)
        else state.pending = null
      }
      if (!proposedNotice && canRetry(state) && (!state.current || missing(state, surface))) {
        const pending = await build(state, payload, true)
        if (pending && typeof payload.agent.session?.append === 'function') {
          payload.agent.session.append('user/message', pending.message, { surfaceOp: 'append' })
          reconcile(state, surfaceOf(payload.agent))
        }
      }
    } catch (error) {
      if (payload.signal?.aborted) return config
      fail(state, error)
    }
    const notice = noticeFor(state, surface)
    if (notice && !proposedNotice && typeof payload.agent.session?.append === 'function') {
      try {
        payload.agent.session.append('user/message', notice, { surfaceOp: 'append' })
        state.failure.notified = true
      } catch { /* the next admitted step can carry the same notice */ }
    }
    return config
  })
  return { stateFor, rootFor }
}
