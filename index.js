// Pi Harness Bridge — Host plugin entry.
//
// Gives DeepSeek Harness the parts of pi-harness that are genuinely portable:
//   * a shared append-only Board            (.pi-board/, same bytes as pi)
//   * tiered long-term knowledge            (knowledge/, ~/.pi-harness/knowledge)
//   * session handoff + directory takeover  (handoff/)
//   * always-on doctrine + per-turn reference injection
//
// Everything is file-first: the same project directory keeps working in pi.

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardTool, handoffTool, knowledgeTool } from './lib/tools.js'
import { doctrineText } from './lib/doctrine.js'
import { buildDelta, buildReference } from './lib/reference.js'
import { exists } from './lib/util.js'

export const name = 'pi-harness'
export const inject = ['tools', 'workingDirectory', 'systemPrompt']

const DOCTRINE_SECTION = 'pi-harness-doctrine'
const REFERENCE_ORDER = 250

export function apply(ctx, config = {}) {
  const settings = {
    injectReference: config.injectReference !== false,
    doctrine: config.doctrine !== false,
    maxReferenceBytes: Number.isFinite(config.maxReferenceBytes) ? config.maxReferenceBytes : 48000,
    // A checkpoint is the only message that carries the full catalog, every
    // topic's goal and the handoff pointer. Compaction can drop it while this
    // process still remembers delivering it, and long sessions drift without
    // it, so re-anchor on a fixed turn interval.
    checkpointEveryTurns: Number.isFinite(config.checkpointEveryTurns) ? config.checkpointEveryTurns : 12,
  }

  // One cache per agent: the resolved project directory and the last reference
  // the model actually received. Recomputing per turn is cheap; injecting an
  // unchanged reference is not.
  const states = new Map()

  function stateFor(agentId) {
    let state = states.get(agentId)
    if (!state) {
      state = { root: null, turn: -1, digest: null, lastCheckpointTurn: -1, failure: null }
      states.set(agentId, state)
    }
    return state
  }

  function rememberFailure(state, root, error) {
    if (state.failure) return
    state.failure = String(error?.message ?? error)
    try {
      if (root && exists(root)) {
        writeFileSync(
          join(root, '.pi-board', 'dsh-inject-error.txt'),
          `${new Date().toISOString()}\n${state.failure}\n${error?.stack ?? ''}\n`,
          'utf-8',
        )
      }
    } catch {
      /* the failure is also reported through the tool surface */
    }
  }

  if (settings.doctrine) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: DOCTRINE_SECTION,
        order: 900,
        text: doctrineText(),
      }),
    )
  }

  // Read-only path for tools: the committed directory, no filesystem I/O.
  const getProjectRoot = (exec) => {
    const agent = exec?.agent
    if (!agent) throw new Error('This tool needs a live session (no agent scope was provided)')
    const state = stateFor(String(agent.id))
    if (state.root) return state.root
    try {
      state.root = ctx.workingDirectory.get(agent.session)
      return state.root
    } catch (error) {
      throw new Error(`Could not resolve this session's working directory: ${error.message}`)
    }
  }

  for (const factory of [boardTool, knowledgeTool, handoffTool]) {
    const definition = factory({ getProjectRoot })
    ctx.effect(() => ctx.tools.register(definition))
  }

  if (!settings.injectReference) return

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    const agent = payload?.agent
    if (!agent) return decision
    const state = stateFor(String(agent.id))
    if (state.failure) return decision
    if (payload.turn === state.turn) return decision

    let root = state.root
    if (!root) {
      try {
        root = await ctx.workingDirectory.ensure(agent)
        state.root = root
      } catch (error) {
        rememberFailure(state, null, error)
        return decision
      }
    }

    try {
      const first = state.digest === null
      // Re-anchor periodically: the checkpoint may have been compacted out of
      // the live context while this process still believes it is there.
      const stale =
        !first && settings.checkpointEveryTurns > 0 && payload.turn - state.lastCheckpointTurn >= settings.checkpointEveryTurns
      const previous = first ? null : { board: state.board, knowledge: state.knowledge }
      const built =
        first || stale ? buildReference(root, { maxBytes: settings.maxReferenceBytes }) : buildDelta(root, previous)
      state.turn = payload.turn
      if (!built) return decision
      if (first || stale) state.lastCheckpointTurn = payload.turn
      state.digest = built.digest
      state.board = built.board
      state.knowledge = built.knowledge
      const message = {
        id: randomUUID(),
        role: 'user',
        time: Date.now(),
        content: [{ type: 'text', text: built.text }],
        source: {
          kind: 'pi-harness',
          form: first || stale ? 'reference' : 'delta',
          summary:
            first || stale ? 'knowledge catalog + open Board topics + handoff' : 'Board/knowledge changes',
        },
      }
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      // A reference is an optimization, never a precondition: a broken
      // .pi-board must not take the turn down with it.
      rememberFailure(state, root, error)
      return decision
    }
  })
}
