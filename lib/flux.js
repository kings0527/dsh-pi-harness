// Live Flux collective intelligence & step-level Sideline Field for DSH.
//
// Shares the exact `.pi-board/fields/` and `~/.pi-harness/flux.json` file
// contracts with WSL pi-harness via the bundled core (`dist/core.js`), while
// running concurrent tentacles natively in-process through `ctx.subagents` and
// delivering zero-KV-invalidation `[FIELD Δ]` tails via `tools/post-execute`.

import { randomUUID } from 'node:crypto'
import {
  COGNITIVE_LENSES,
  FLUX_DISCIPLINE,
  PULSE_KINDS,
  artifactsDir,
  buildCollectiveBoardSummary,
  buildFieldSnapshot,
  buildSidelineDelta,
  claimResource,
  clearProjectFluxConfig,
  closeField,
  createTentacleWorktree,
  emptySidelineCursor,
  extractToolTrace,
  getFieldMeta,
  getFluxConfig,
  getGlobalFluxPath,
  getProjectFluxPath,
  hasArchivedTopic,
  hasProjectFluxConfig,
  inspectWorktreeChanges,
  isFluxDisabled,
  listFields,
  listOpenTopics,
  listPresences,
  listResources,
  markPresenceDone,
  openField,
  openTopic,
  pickStartingLenses,
  postNote,
  postPulse,
  readPulses,
  releaseAllResources,
  releaseResource,
  removeTentacleWorktree,
  resolveFluxModels,
  setFluxConfig,
  updatePresence,
} from './engine.js'

const text = (value) => ({ text: String(value) })

function outputSchema(properties = {}) {
  return {
    type: 'object',
    properties: { text: { type: 'string' }, ...properties },
    required: ['text'],
    additionalProperties: true,
  }
}

function renderer(value) {
  const body = typeof value === 'string' ? value : value?.text ?? JSON.stringify(value, null, 2)
  return [{ type: 'text', text: String(body) }]
}

function serviceOf(ctx, name) {
  if (typeof ctx?.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

export function parseModelRoute(spec) {
  const clean = String(spec ?? '').trim()
  if (!clean) return undefined
  const slash = clean.indexOf('/')
  if (slash <= 0 || slash === clean.length - 1) return { model: clean }
  return { provider: clean.slice(0, slash), model: clean.slice(slash + 1) }
}

export function formatModelSpec(entry) {
  const provider = String(entry?.provider ?? '').trim()
  const id = String(entry?.id ?? entry?.model ?? '').trim()
  return provider ? `${provider}/${id}` : id
}

export function fuzzyMatchModel(query, available, preferredProvider) {
  const lower = String(query ?? '').toLowerCase().trim()
  if (!lower) return null

  const exactSpec = available.find((m) => formatModelSpec(m).toLowerCase() === lower)
  if (exactSpec) return exactSpec

  const exactIds = available.filter((m) => String(m.id ?? '').toLowerCase() === lower)
  if (exactIds.length > 0) {
    if (preferredProvider) {
      const sameProvider = exactIds.find(
        (m) => String(m.provider ?? '').toLowerCase() === preferredProvider.toLowerCase(),
      )
      if (sameProvider) return sameProvider
    }
    return exactIds[0]
  }

  const bySpec = available.find((m) => formatModelSpec(m).toLowerCase().includes(lower))
  if (bySpec) return bySpec

  const byName = available.find((m) => String(m.name ?? '').toLowerCase().includes(lower))
  if (byName) return byName

  const byProvider = available.find((m) => String(m.provider ?? '').toLowerCase().includes(lower))
  if (byProvider) return byProvider

  return null
}

/** Read current parent `{ provider, model }` route from a live DSH agent when available. */
export function activeModelRouteOf(agent) {
  try {
    const rawHeader = agent?.session?.requestHeader?.()
    const cfg = rawHeader?.config ?? rawHeader
    if (cfg?.provider && cfg?.model) {
      return { provider: String(cfg.provider), model: String(cfg.model) }
    }
  } catch {
    /* fallback below */
  }
  const opts = agent?.options
  if (opts?.provider && opts?.model) {
    return { provider: String(opts.provider), model: String(opts.model) }
  }
  return undefined
}

export async function listAvailableModels(ctx, signal) {
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return []
  const providers = llm.listProviders() ?? []
  const out = []
  for (const provider of providers) {
    if (!provider?.id) continue
    try {
      const models = await llm.listModels?.(provider.id, signal)
      if (!Array.isArray(models)) continue
      for (const m of models) {
        if (!m?.id) continue
        out.push({
          provider: String(provider.id),
          id: String(m.id),
          name: String(m.name ?? m.id),
        })
      }
    } catch {
      /* skip provider whose remote/local catalog is temporarily unreachable */
    }
  }
  return out.sort((a, b) => formatModelSpec(a).localeCompare(formatModelSpec(b)))
}

function extractSubagentText(result) {
  if (!result) return ''
  if (typeof result === 'string') return result
  if (typeof result.text === 'string') return result.text
  if (Array.isArray(result.output)) {
    return result.output
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
  }
  return ''
}

function renderLiveFieldPrompt(att, meta) {
  const artDir = artifactsDir(att.projectRoot, att.fieldId)
  const lines = [
    `# Live Sideline Field (${att.fieldId})`,
    `Identity: ${att.actorLabel}${att.lens ? ` | Starting lens (decaying bias): ${att.lens}` : ''}`,
    `Goal: ${meta.goal}`,
    `Shared artifacts dir: ${artDir} | Root workspace: ${meta.rootCwd}`,
    `Sideline deltas ([FIELD Δ]) arrive automatically at the tail of tool results whenever peers emit new objective pulses, claim/release exclusive resources, shift focus area, or touch the same target.`,
    ...(att.isTentacle
      ? [
          'BOUNDARY (overrides generic Board workflow for this run): You are a spawned Live Field tentacle. Communicate via the `field` tool (pulses, resource claims, shared artifacts). Do NOT post/converge/close on the main `board`, do NOT write `knowledge`, and do NOT call `field action=close` — the coordinator performs single-point consolidation into Board once tentacles finish.',
        ]
      : []),
    FLUX_DISCIPLINE,
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Per-Host Field Runtime Registry (keyed by ctx.root for test isolation)
// ---------------------------------------------------------------------------

const runtimesByRoot = new WeakMap()

export function getOrCreateFieldRuntime(ctx) {
  const key = ctx?.root ?? ctx
  let runtime = runtimesByRoot.get(key)
  if (!runtime) {
    runtime = createFieldRuntime()
    runtimesByRoot.set(key, runtime)
  }
  return runtime
}

export function createFieldRuntime() {
  const attachments = new Map()
  let installed = false
  let commandsRegistered = false

  function getActive(agentId) {
    if (!agentId) return null
    const att = attachments.get(String(agentId))
    if (!att) return null
    const meta = getFieldMeta(att.projectRoot, att.fieldId)
    if (!meta || meta.status === 'closed') return null
    return { att, meta }
  }

  function attach(agentId, options) {
    const id = String(agentId)
    const prev = attachments.get(id)
    if (prev && prev.fieldId !== options.fieldId) {
      detach(id, 'idle')
    }
    const label =
      options.actorLabel?.trim() ||
      `dsh-${id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'agent'}`
    const actorId = options.actorId?.trim() || id
    const att = {
      agentId: id,
      actorId,
      actorLabel: label,
      fieldId: options.fieldId,
      projectRoot: options.projectRoot,
      cwd: options.cwd ?? options.projectRoot,
      lens: options.lens,
      isTentacle: Boolean(options.isTentacle),
      cursor: emptySidelineCursor(),
      snapshotInjectedForField: null,
    }
    attachments.set(id, att)
    try {
      updatePresence(att.projectRoot, att.fieldId, {
        actorId: att.actorId,
        label: att.actorLabel,
        lens: att.lens,
        cwd: att.cwd,
        heading: att.lens ? `starting (${att.lens})` : 'joined field',
        status: 'active',
      })
    } catch {
      /* presence startup is best-effort */
    }
    return att
  }

  function detach(agentId, status = 'done') {
    if (!agentId) return null
    const id = String(agentId)
    const att = attachments.get(id)
    if (!att) return null
    attachments.delete(id)
    try {
      releaseAllResources(att.projectRoot, att.fieldId, att.actorId)
    } catch {
      /* best effort */
    }
    try {
      markPresenceDone(att.projectRoot, att.fieldId, att.actorId, status)
    } catch {
      /* best effort */
    }
    return att
  }

  return {
    attachments,
    get: (agentId) => (agentId ? attachments.get(String(agentId)) ?? null : null),
    getActive,
    attach,
    detach,
    markInstalled: () => {
      if (installed) return false
      installed = true
      return true
    },
    markCommandsRegistered: () => {
      if (commandsRegistered) return false
      commandsRegistered = true
      return true
    },
  }
}

export function installFieldRuntime(ctx, runtime, { getProjectRoot }) {
  if (!runtime.markInstalled()) return

  // 1. Dynamic scoped system prompt: injects Live Field header + FLUX_DISCIPLINE
  //    ONLY for attached agents; returns '' (zero tokens) for ordinary sessions.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'pi-harness-field',
      order: 905,
      interpolate: false,
      text: (context) => {
        const active = runtime.getActive(context?.agent?.id)
        if (!active) return ''
        return renderLiveFieldPrompt(active.att, active.meta)
      },
    }),
  )

  // 2. Inject initial [FIELD SNAPSHOT] once per attached field on first pre-step.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || !payload?.agent || payload.signal?.aborted) return decision
    const active = runtime.getActive(payload.agent.id)
    if (!active) return decision
    const { att } = active
    if (att.snapshotInjectedForField === att.fieldId) return decision

    try {
      const existingPulses = readPulses(att.projectRoot, att.fieldId)
      const resources = listResources(att.projectRoot, att.fieldId)
      att.cursor = {
        lastPulseSeq: existingPulses.at(-1)?.seq ?? 0,
        lastResourcesSig: resources.map((r) => `${r.resource}=${r.holderId}:${r.purpose}`).join('|'),
        lastPeersSig: '',
        lastOverlapSig: '',
        seenBreachSeqs: existingPulses.filter((p) => p.kind === 'breach').map((p) => p.seq),
      }
      att.snapshotInjectedForField = att.fieldId

      const snapshot = buildFieldSnapshot(att.projectRoot, att.fieldId, {
        selfActorId: att.actorId,
      })
      const snapshotMessage = {
        id: randomUUID(),
        role: 'user',
        time: Date.now(),
        content: [{ type: 'text', text: snapshot }],
        source: { kind: 'pi-harness', form: 'field-snapshot', summary: 'Live Field snapshot' },
      }
      return { ...decision, messages: [...decision.messages, snapshotMessage] }
    } catch {
      return decision
    }
  })

  // 3. Implicit slime trail before tool runs (domain-agnostic argument inspection).
  ctx.on('tools/execute', async (exec, next) => {
    const active = runtime.getActive(exec?.agent?.id)
    if (active) {
      try {
        const { att, meta } = active
        const cwd = att.cwd || meta.rootCwd || getProjectRoot(exec)
        const trace = extractToolTrace(exec.name, exec.arguments ?? {}, cwd)
        updatePresence(att.projectRoot, att.fieldId, {
          actorId: att.actorId,
          label: att.actorLabel,
          lens: att.lens,
          cwd,
          heading: trace.heading,
          focusArea: trace.focusArea,
          targets: trace.targets,
          lastTool: exec.name,
          status: 'active',
        })
      } catch {
        /* implicit trail must never interfere with real tool execution */
      }
    }
    return next()
  })

  // 4. Step-level sideline delta piggyback at the tail of tool results
  //    (zero KV-cache prefix invalidation; preserves tool structured value).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'block') return decision
    if (Object.hasOwn(decision, 'value')) return decision
    const active = runtime.getActive(exec?.agent?.id)
    if (!active) return decision

    try {
      const { att, meta } = active
      const cwd = att.cwd || meta.rootCwd || getProjectRoot(exec)
      const trace = extractToolTrace(exec.name, exec.arguments ?? {}, cwd)
      updatePresence(att.projectRoot, att.fieldId, {
        actorId: att.actorId,
        label: att.actorLabel,
        lens: att.lens,
        cwd,
        heading: trace.heading,
        focusArea: trace.focusArea,
        targets: trace.targets,
        lastTool: exec.name,
        lastToolError: result?.isError === true,
        incrementStep: true,
        status: 'active',
      })

      if (exec.name === 'field' && exec.arguments?.action === 'peek') return decision

      const delta = buildSidelineDelta(att.projectRoot, att.fieldId, att.actorId, att.cursor, {
        currentTargets: trace.targets,
      })
      if (!delta) return decision

      att.cursor = delta.nextCursor
      const baseContent = Array.isArray(decision.content)
        ? decision.content
        : Array.isArray(result?.content)
          ? result.content
          : []
      return {
        ...decision,
        content: [...baseContent, { type: 'text', text: `\n\n${delta.text}` }],
      }
    } catch {
      return decision
    }
  })

  // 5. Release locks/presence cleanly whenever an in-process subagent ends.
  ctx.on('subagent/end', (event) => {
    const childId = event?.childId ?? event?.sessionId
    if (childId) runtime.detach(childId, 'done')
  })
}

// ---------------------------------------------------------------------------
// `field` Tool — Shared Sideline Primitive (pi-harness & DSH byte-compatible)
// ---------------------------------------------------------------------------

export function fieldTool({ runtime, getProjectRoot }) {
  return {
    name: 'field',
    description:
      'Live sideline field for parallel exploration: pulse (objective echo/breach/conflict/artifact/need), ' +
      'claim/release (exclusive shared resources), peek, artifact, open, join, close, list. ' +
      'Attached agents automatically receive incremental [FIELD Δ] updates on tool results.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pulse', 'claim', 'release', 'peek', 'artifact', 'open', 'join', 'close', 'list'],
        },
        field: { type: 'string', description: 'Field ID (defaults to currently attached field).' },
        kind: {
          type: 'string',
          enum: [...PULSE_KINDS],
          description: 'pulse: echo (default), need, conflict, breach, or artifact.',
        },
        fact: {
          type: 'string',
          description: 'pulse: 1-3 lines of objective world feedback (method -> echo); no scores.',
        },
        anchor: { type: 'string', description: 'Exact coordinate (file:line, address, cmd, artifact path).' },
        next: { type: 'string', description: 'Your next heading.' },
        resource: { type: 'string', description: 'Exclusive resource key to coordinate.' },
        purpose: { type: 'string', description: 'Why you are holding the exclusive resource.' },
        goal: { type: 'string', description: 'open: exploration objective.' },
        mode: { type: 'string', enum: ['shared', 'worktree'] },
        lens: { type: 'string', description: 'join: optional starting cognitive lens.' },
      },
      required: ['action'],
    },
    output: { schema: outputSchema(), render: (_args, value) => renderer(value) },
    async execute(args, exec) {
      const agentId = exec?.agent?.id ? String(exec.agent.id) : null
      const att = runtime.get(agentId)
      const root = att?.projectRoot ?? getProjectRoot(exec)
      const targetField = String(args.field ?? att?.fieldId ?? '').trim()
      const actorId = att?.actorId ?? agentId ?? 'dsh-agent'
      const actorLabel =
        att?.actorLabel ?? `dsh-${String(actorId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'agent'}`

      switch (args.action) {
        case 'list': {
          const all = listFields(root)
          if (!all.length) return text('No live fields yet.')
          return text(
            all
              .map(
                (f) =>
                  `- ${f.id} [${f.status}; ${f.mode}]${att?.fieldId === f.id ? ' (attached)' : ''} — ${f.goal}`,
              )
              .join('\n'),
          )
        }
        case 'open': {
          if (!targetField) throw new Error('field ID is required for open')
          if (!String(args.goal ?? '').trim()) throw new Error('goal is required for open')
          const meta = openField(root, targetField, args.goal, {
            mode: args.mode,
            createdBy: actorLabel,
            rootCwd: root,
          })
          if (agentId) {
            runtime.attach(agentId, {
              projectRoot: root,
              fieldId: meta.id,
              actorId,
              actorLabel,
              lens: args.lens,
            })
          }
          return text(
            `Opened and joined live field "${meta.id}" (${meta.mode}). Artifacts dir: ${artifactsDir(root, meta.id)}`,
          )
        }
        case 'join': {
          if (!targetField) throw new Error('field ID is required for join')
          const meta = getFieldMeta(root, targetField)
          if (!meta) throw new Error(`Field "${targetField}" not found`)
          if (agentId) {
            runtime.attach(agentId, {
              projectRoot: root,
              fieldId: meta.id,
              actorId,
              actorLabel,
              lens: args.lens,
            })
          }
          return text(buildFieldSnapshot(root, meta.id, { selfActorId: actorId }))
        }
        case 'close': {
          if (!targetField) throw new Error('field ID is required for close')
          const activePeers = listPresences(root, targetField).filter((p) => p.actorId !== actorId)
          if (activePeers.length > 0) {
            return text(
              `Cannot close field "${targetField}" while ${activePeers.length} peer(s) are still active (${activePeers.map((p) => p.label).join(', ')}). Emit a pulse or finish cleanly; the coordinator closes the field once all tentacles settle.`,
            )
          }
          const closed = closeField(root, targetField)
          if (agentId && att?.fieldId === targetField) runtime.detach(agentId, 'done')
          return text(closed ? `Closed field "${targetField}".` : `Field "${targetField}" not found.`)
        }
        case 'peek': {
          if (!targetField) throw new Error('No field attached; pass field=<id> or join one first')
          const snap = buildFieldSnapshot(root, targetField, { selfActorId: actorId })
          if (att && att.fieldId === targetField) {
            const latest = readPulses(root, targetField)
            att.cursor.lastPulseSeq = latest.at(-1)?.seq ?? att.cursor.lastPulseSeq
          }
          return text(snap)
        }
        case 'artifact': {
          if (!targetField) throw new Error('No field attached; pass field=<id>')
          const dir = artifactsDir(root, targetField)
          return text(
            `Shared artifacts dir for "${targetField}": ${dir}\nWrite reusable outputs here, then announce via field action=pulse kind=artifact anchor="<file>" fact="<what it contains>".`,
          )
        }
        case 'claim': {
          if (!targetField) throw new Error('No field attached; pass field=<id>')
          if (!String(args.resource ?? '').trim()) throw new Error('resource is required for claim')
          const result = claimResource(root, targetField, args.resource, {
            actorId,
            label: actorLabel,
            purpose: args.purpose || 'exclusive access',
          })
          if (result.acquired) {
            return text(
              `Claimed exclusive resource "${result.lease.resource}" for ${actorLabel} (${result.lease.purpose}). Release when done with field action=release.`,
            )
          }
          const age = Math.max(0, Math.round((Date.now() - result.lease.acquiredAt) / 1000))
          return text(
            `Resource "${result.lease.resource}" is BUSY — held by ${result.lease.holderLabel} (${result.lease.purpose}, ${age}s ago). Do NOT race it: work on non-exclusive analysis, inspect ${artifactsDir(root, targetField)}, or emit field action=pulse kind=need to piggyback a probe.`,
          )
        }
        case 'release': {
          if (!targetField) throw new Error('No field attached; pass field=<id>')
          if (!String(args.resource ?? '').trim()) {
            const released = releaseAllResources(root, targetField, actorId)
            return text(
              released.length ? `Released resources: ${released.join(', ')}.` : 'No held resources to release.',
            )
          }
          const ok = releaseResource(root, targetField, args.resource, actorId)
          return text(
            ok
              ? `Released "${args.resource}".`
              : `Could not release "${args.resource}" (not held by you or already free).`,
          )
        }
        case 'pulse': {
          if (!targetField) throw new Error('No field attached; pass field=<id> or open/join one first')
          if (!String(args.fact ?? '').trim()) throw new Error('fact is required for pulse')
          const kind = args.kind ?? 'echo'
          if (!PULSE_KINDS.includes(kind)) throw new Error(`Invalid pulse kind "${kind}"`)
          if (!getFieldMeta(root, targetField)) {
            openField(root, targetField, String(args.fact).slice(0, 160), {
              createdBy: actorLabel,
              rootCwd: root,
            })
          }
          const pulse = postPulse(root, targetField, {
            actorId,
            actorLabel,
            lens: att?.lens,
            kind,
            fact: args.fact,
            anchor: args.anchor,
            next: args.next,
          })
          if (att && att.fieldId === targetField) {
            att.cursor.lastPulseSeq = Math.max(att.cursor.lastPulseSeq, pulse.seq)
          }
          return text(`Emitted pulse #${pulse.seq} [${pulse.kind}] to field "${targetField}".`)
        }
        default:
          throw new Error(`Unknown field action "${args.action}"`)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Flux Config Formatting & Subagent Provider Resolution
// ---------------------------------------------------------------------------

function defaultWriteScope(root) {
  return hasProjectFluxConfig(root) ? 'project' : 'global'
}

function formatFluxStatus(root, agent) {
  const config = getFluxConfig(root)
  const parentRoute = activeModelRouteOf(agent)
  const parentSpec = parentRoute ? formatModelSpec(parentRoute) : undefined
  const resolved = resolveFluxModels(config, parentSpec)
  const activeFields = listFields(root).filter((f) => f.status !== 'closed')
  const scopeLabel =
    config.source === 'project'
      ? `project (${getProjectFluxPath(root)})`
      : config.source === 'global'
        ? `global (${getGlobalFluxPath(root)})`
        : 'default (zero-config ON)'

  if (isFluxDisabled(config)) {
    return `Live Flux mode: OFF [${scopeLabel}]\nRe-enable with: /flux on`
  }

  const poolLine =
    config.models.length > 0
      ? config.models.join(', ')
      : resolved.length > 0
        ? `auto -> ${resolved[0]} (inherits active session model)`
        : 'auto (inherits active session model)'

  return [
    `Live Flux mode: ON [${scopeLabel}]`,
    `Models: ${poolLine}`,
    `Tentacles: ${config.tentacles ?? 'auto (3+)'}`,
    `Topology: ${config.mode ?? 'shared'} (shared workspace or git worktree clones + shared sideline)`,
    `Starting lenses: ${COGNITIVE_LENSES.map((l) => l.id).join(', ')} (decaying initial bias)`,
    ...(activeFields.length > 0
      ? [`Active fields: ${activeFields.map((f) => `${f.id} (${f.status}/${f.mode})`).join(', ')}`]
      : []),
    `Commands: /flux status | /flux models | /flux toggle <provider/id> | /flux on [models] | /flux clear | /flux off | /flux tentacles <N|auto> | /flux mode shared|worktree | /flux scope global|project`,
  ].join('\n')
}

async function formatFluxModels(ctx, root, agent, signal) {
  const config = getFluxConfig(root)
  const selected = new Set(config.models)
  const parentRoute = activeModelRouteOf(agent)
  const parentSpec = parentRoute ? formatModelSpec(parentRoute) : undefined
  const available = await listAvailableModels(ctx, signal)

  if (!available.length) {
    const saved = config.models.length ? config.models.join(', ') : '(empty — auto-inherits current model)'
    return `Live Flux model pool: ${saved}\n(Model catalog unavailable right now; set explicit provider/id via /flux on <provider/id> or flux action=config.)`
  }

  const byProvider = new Map()
  for (const m of available) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, [])
    byProvider.get(m.provider).push(m)
  }

  const lines = [
    `Live Flux model pool (${selected.size > 0 ? `${selected.size} selected` : `auto -> ${parentSpec ?? 'current model'}`}; scope=${defaultWriteScope(root)}):`,
  ]
  for (const provider of [...byProvider.keys()].sort()) {
    lines.push(`\n[${provider}]`)
    for (const m of byProvider.get(provider)) {
      const spec = formatModelSpec(m)
      const box = selected.has(spec) ? '[x]' : '[ ]'
      const star = parentSpec && spec === parentSpec ? ' * (current)' : ''
      lines.push(`  ${box} ${spec}${star}`)
    }
  }
  lines.push(
    `\nToggle with: /flux toggle <provider/id>  |  Set pool: /flux on <p1/m1>,<p2/m2>  |  Auto-current: /flux clear`,
  )
  return lines.join('\n')
}

function resolveSpawnProvider(subagents) {
  if (!subagents) return null
  if (typeof subagents.getProvider === 'function') {
    const spawn = subagents.getProvider('spawn')
    if (spawn) return 'spawn'
  }
  if (subagents.providers instanceof Map) {
    for (const [name, prov] of subagents.providers.entries()) {
      if (!prov?.inheritsParentContext) return name
    }
    const first = subagents.providers.keys().next().value
    if (first) return first
  }
  return 'spawn'
}

/**
 * Project a top-level `flux` run into DSH's built-in inline `WorkflowRunPanel`
 * (`dsh-client-ui-workflow-run`) via durable non-surface `tool-workflow/*`
 * session events:
 *   - Shows ONLY the tentacles of THIS `flux` run right inside the chat stream
 *   - Updates each tentacle's status dot in real time as it starts and finishes
 *   - Allows one-click navigation into any running tentacle session
 *   - Adds zero tokens to the LLM surface (`SURFACE_EVENT_TYPES` excludes them)
 *   - Contained: any session-append failure disables recording without affecting execution
 */
function createFluxRunRecorder(exec, logger) {
  const session = exec?.parent === undefined ? exec?.agent?.session : undefined
  if (!session || typeof session.append !== 'function') {
    return {
      startRun: () => false,
      startTentacle: () => {},
      endTentacle: () => {},
      endRun: () => {},
    }
  }

  let enabled = true
  let started = false
  let ended = false
  const startedSeqs = new Set()
  const endedSeqs = new Set()

  const append = (type, data) => {
    if (!enabled) return false
    try {
      session.append(type, data)
      return true
    } catch (error) {
      enabled = false
      logger?.warn?.(`flux: disabled inline run panel after ${type} append failed: ${String(error)}`)
      return false
    }
  }

  return {
    startRun(runId, name) {
      if (started) return enabled
      started = append('tool-workflow/run-start', { runId, name })
      return started
    },
    startTentacle(runId, { seq, label, phase, childId }) {
      if (!started || !enabled || startedSeqs.has(seq)) return
      if (
        append('tool-workflow/agent-start', {
          runId,
          seq,
          label,
          ...(phase !== undefined ? { phase } : {}),
          childId,
        })
      ) {
        startedSeqs.add(seq)
      }
    },
    endTentacle(runId, seq, outcome) {
      if (!started || !enabled || !startedSeqs.has(seq) || endedSeqs.has(seq)) return
      if (append('tool-workflow/agent-end', { runId, seq, outcome })) {
        endedSeqs.add(seq)
      }
    },
    endRun(runId, stopReason) {
      if (!started || !enabled || ended) return
      ended = true
      const fallbackOutcome = stopReason === 'cancelled' ? 'cancelled' : 'failed'
      for (const seq of startedSeqs) {
        if (!endedSeqs.has(seq)) {
          if (append('tool-workflow/agent-end', { runId, seq, outcome: fallbackOutcome })) {
            endedSeqs.add(seq)
          }
        }
      }
      append('tool-workflow/run-end', { runId, stopReason })
    },
  }
}

function buildUniqueSubagentName(runTag, index, lensId) {
  const cleanLens =
    String(lensId ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'probe'
  return `f${runTag}-t${index + 1}-${cleanLens}`.slice(0, 32).replace(/-+$/g, '')
}

function shortModelDisplay(spec) {
  const raw = String(spec ?? '').trim()
  return raw || 'default'
}

// ---------------------------------------------------------------------------
// `flux` Tool — Native In-Process Concurrent Live-Field Exploration
// ---------------------------------------------------------------------------

export function fluxTool({ ctx, runtime, getProjectRoot }) {
  return {
    name: 'flux',
    description:
      'Live Flux collective intelligence: launch concurrent tentacles sharing a step-level sideline field ' +
      '(objective echoes, focus-area presence, cooperative resource leases, shared artifacts) without rigid barriers or scoring, ' +
      'then post one single-point digest to Board. Actions: run (default when question is given), status, models, config.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'status', 'models', 'config'],
          description: 'run (launch concurrent tentacles), status, models (list available provider/id catalog), or config (save pool/topology).',
        },
        topic: { type: 'string', description: 'run: Board topic id (auto-opened if absent).' },
        question: { type: 'string', description: 'run: exploration question or breakthrough objective.' },
        lenses: {
          type: 'array',
          items: { type: 'string' },
          description: 'run: optional decaying starting lenses (spine, seam, probe, invert, scout, or custom).',
        },
        angles: {
          type: 'array',
          items: { type: 'string' },
          description: 'run: optional per-tentacle initial hints.',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'run/config: provider/id model specs (empty array in config resets to auto-inherit current model).',
        },
        tentacles: {
          type: 'integer',
          minimum: 0,
          maximum: 8,
          description: 'run/config: concurrent tentacles 1-8 (0 in config resets to auto).',
        },
        mode: {
          type: 'string',
          enum: ['shared', 'worktree'],
          description: 'run/config: shared workspace or isolated git worktree per tentacle.',
        },
        enabled: { type: 'boolean', description: 'config: explicitly enable or disable Flux.' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'config: save globally (~/.pi-harness/flux.json) or project-local.' },
      },
    },
    output: { schema: outputSchema(), render: (_args, value) => renderer(value) },
    presentCall(args = {}) {
      const action = args.action || (args.question ? 'run' : 'status')
      if (action === 'run') {
        const topic = String(args.topic ?? '').trim()
        const firstLine = String(args.question ?? '').trim().split(/\r?\n/u, 1)[0] ?? ''
        const head = topic ? `flux · ${topic}` : 'flux · run'
        return {
          card: 'generic',
          title: firstLine ? `${head} — ${firstLine.slice(0, 72)}` : head,
        }
      }
      return { card: 'generic', title: `flux · ${action}` }
    },
    async execute(args = {}, exec) {
      const root = getProjectRoot(exec)
      const action = args.action || (args.question ? 'run' : 'status')

      if (action === 'status') {
        return text(formatFluxStatus(root, exec?.agent))
      }

      if (action === 'models') {
        return text(await formatFluxModels(ctx, root, exec?.agent, exec?.signal))
      }

      if (action === 'config') {
        const current = getFluxConfig(root)
        const targetScope = args.scope ?? defaultWriteScope(root)
        const next = {
          enabled: args.enabled !== undefined ? Boolean(args.enabled) : current.enabled,
          models: current.models,
          ...(current.tentacles !== undefined ? { tentacles: current.tentacles } : {}),
          ...(current.mode ? { mode: current.mode } : {}),
        }
        if (Array.isArray(args.models)) {
          const available = await listAvailableModels(ctx, exec?.signal)
          const parentRoute = activeModelRouteOf(exec?.agent)
          next.models = args.models
            .map((raw) => String(raw ?? '').trim())
            .filter(Boolean)
            .map((token) => {
              if (!available.length) return token
              const matched = fuzzyMatchModel(token, available, parentRoute?.provider)
              return matched ? formatModelSpec(matched) : token
            })
        }
        if (args.tentacles !== undefined) {
          if (args.tentacles === 0) delete next.tentacles
          else next.tentacles = Math.min(8, Math.max(1, Math.floor(args.tentacles)))
        }
        if (args.mode === 'shared' || args.mode === 'worktree') {
          next.mode = args.mode
        }
        if (args.scope === 'global') {
          clearProjectFluxConfig(root)
        }
        setFluxConfig(root, next, targetScope)
        return text(`Saved Flux configuration (${targetScope}).\n\n${formatFluxStatus(root, exec?.agent)}`)
      }

      if (action !== 'run') {
        throw new Error(`Unknown flux action "${action}"`)
      }

      if (runtime.get(exec?.agent?.id)?.isTentacle) {
        return text(
          'Spawned Live Field tentacles cannot nest another flux swarm; explore directly and share discoveries via the field tool.',
        )
      }

      const question = String(args.question ?? '').trim()
      if (!question) throw new Error('"question" is required for flux action=run')

      const config = getFluxConfig(root)
      if (isFluxDisabled(config)) {
        throw new Error('Flux mode is disabled. Re-enable with /flux on or flux action=config enabled=true')
      }

      const subagents = serviceOf(ctx, 'subagents')
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error(
          'DSH subagent service is unavailable in this host. You can still collaborate manually via the field tool.',
        )
      }
      if (!exec?.agent) {
        throw new Error('flux action=run requires an active parent agent turn')
      }

      const providerName = resolveSpawnProvider(subagents)
      const parentRoute = activeModelRouteOf(exec.agent)
      const parentSpec = parentRoute ? formatModelSpec(parentRoute) : undefined
      const rawModels = resolveFluxModels(config, undefined, args.models)
      const availableCatalog =
        rawModels.some((m) => !m.includes('/')) ? await listAvailableModels(ctx, exec.signal) : []
      const resolvedRoutes = rawModels.map((spec) => {
        if (spec.includes('/')) {
          return { spec, route: parseModelRoute(spec) }
        }
        const matched = fuzzyMatchModel(spec, availableCatalog, parentRoute?.provider)
        if (matched) {
          const full = formatModelSpec(matched)
          return { spec: full, route: { provider: matched.provider, model: matched.id } }
        }
        return {
          spec: parentRoute?.provider ? `${parentRoute.provider}/${spec}` : spec,
          route: parentRoute?.provider ? { provider: parentRoute.provider, model: spec } : { model: spec },
        }
      })

      const actor = { id: String(exec.agent.id), label: 'dsh' }
      const topicId = String(args.topic ?? '').trim() || `flux-${Date.now()}`
      const openList = listOpenTopics(root)
      const existingTopic = openList.find((t) => t.id === topicId)
      if (!existingTopic) {
        if (hasArchivedTopic(root, topicId)) {
          throw new Error(`Topic "${topicId}" already exists in archive; pick a fresh topic ID`)
        }
        openTopic(root, topicId, question, { actor })
      }

      const mode = args.mode ?? config.mode ?? 'shared'
      const requestedCount =
        (typeof args.tentacles === 'number' && args.tentacles > 0 ? args.tentacles : undefined) ??
        (Array.isArray(args.lenses) && args.lenses.length > 0 ? args.lenses.length : undefined) ??
        (Array.isArray(args.angles) && args.angles.length > 0 ? args.angles.length : undefined) ??
        config.tentacles ??
        Math.max(resolvedRoutes.length, 3)
      const tentacleCount = Math.min(Math.max(1, Math.floor(requestedCount)), 8)
      const lenses = pickStartingLenses(tentacleCount, args.lenses)

      const fieldId = `${topicId}--field-${Date.now()}`
      openField(root, fieldId, question, {
        topic: topicId,
        mode,
        rootCwd: root,
        createdBy: 'flux-coordinator',
      })
      const sharedArtifacts = artifactsDir(root, fieldId)

      const createdWorktrees = []
      const launched = []
      const runId = randomUUID()
      const runTag = runId.replace(/-/g, '').slice(0, 4).toLowerCase()
      const phaseTitle = `Live Field (${mode})`
      const recorder = createFluxRunRecorder(exec, ctx?.logger)
      recorder.startRun(runId, `flux · ${topicId}`)

      try {
        // Launch all N tentacles concurrently; pre-register each childId in the
        // Live Field runtime before startActivation so step 1 has zero race.
        for (let i = 0; i < tentacleCount; i += 1) {
          const seq = i + 1
          const lens = lenses[i]
          const label = `t${seq}-${lens.id}`
          const subagentName = buildUniqueSubagentName(runTag, i, lens.id)
          const childId = randomUUID()
          const actorId = `${fieldId}:${label}`
          const picked = resolvedRoutes.length > 0 ? resolvedRoutes[i % resolvedRoutes.length] : null
          const modelSpec = picked?.spec ?? parentSpec ?? 'default'
          const shortModel = shortModelDisplay(modelSpec)
          const angleHint = args.angles?.[i]?.trim()

          let tentacleCwd = root
          let wt
          if (mode === 'worktree') {
            wt = createTentacleWorktree(root, fieldId, label)
            createdWorktrees.push(wt)
            tentacleCwd = wt.path
          }

          runtime.attach(childId, {
            projectRoot: root,
            fieldId,
            actorId,
            actorLabel: label,
            cwd: tentacleCwd,
            lens: lens.id,
            isTentacle: true,
          })

          const promptText = [
            `You are "${label}", a Live Flux tentacle exploring topic "${topicId}" on field "${fieldId}".`,
            `Question / Objective: "${question}"`,
            `Starting lens (${lens.name}, decaying initial bias): ${lens.startingBias}`,
            ...(angleHint ? [`Initial direction hint: ${angleHint}`] : []),
            `Shared artifacts dir (write reusable outputs here): ${sharedArtifacts}`,
            ...(wt
              ? [`Workspace topology: isolated git worktree (${wt.path}) sharing the live cognitive field with peers.`]
              : [`Workspace topology: shared workspace (${root}). Use field action=claim/release before mutating exclusive shared resources.`]),
            `Start probing the real environment immediately. Emit concise objective echoes via \`field action=pulse\` (and \`kind="breach"\` on verified breakthrough).`,
          ].join('\n')

          const agentOptions =
            picked?.route?.provider && picked?.route?.model
              ? { provider: picked.route.provider, model: picked.route.model }
              : undefined

          const memberDisplayLabel = angleHint
            ? `${label} · ${shortModel} — ${angleHint.slice(0, 36)}`
            : `${label} · ${shortModel}`

          const startPromise = subagents
            .startActivation({
              provider: providerName,
              childId,
              name: subagentName,
              label: `[${topicId}] ${label} · ${shortModel}`,
              delivery: 'caller',
              signal: exec.signal,
              cwd: tentacleCwd,
              prompt: [{ type: 'text', text: promptText }],
              parent: exec.agent,
              maxDepth: 1,
              ...(agentOptions ? { agentOptions } : {}),
            })
            .then((receipt) => {
              recorder.startTentacle(runId, {
                seq,
                label: memberDisplayLabel,
                phase: phaseTitle,
                childId: receipt?.childId ?? childId,
              })
              return receipt
            })

          launched.push({
            seq,
            childId,
            label,
            subagentName,
            lens: lens.id,
            model: modelSpec,
            worktree: wt,
            startPromise,
            receipt: null,
          })
        }

        // Wait for all activations to start, then await all results in parallel,
        // streaming each individual tentacle's completion to the inline UI immediately.
        const started = await Promise.allSettled(launched.map((entry) => entry.startPromise))
        for (let i = 0; i < launched.length; i += 1) {
          if (started[i].status === 'fulfilled') {
            launched[i].receipt = started[i].value
          }
        }

        const settled = await Promise.allSettled(
          launched.map(async (entry, idx) => {
            if (started[idx].status === 'rejected') {
              throw started[idx].reason
            }
            const run = entry.receipt
            try {
              const res = await run.result
              const stop = res?.stopReason ?? 'completed'
              const ok = stop === 'completed' || stop === 'stop' || stop === 'end_turn'
              const outcome =
                exec.signal?.aborted || stop === 'aborted'
                  ? 'cancelled'
                  : ok
                    ? 'completed'
                    : 'failed'
              recorder.endTentacle(runId, entry.seq, outcome)
              return res
            } catch (runErr) {
              recorder.endTentacle(runId, entry.seq, exec.signal?.aborted ? 'cancelled' : 'failed')
              throw runErr
            } finally {
              runtime.detach(entry.childId, 'done')
              try {
                await run.dispose?.()
              } catch {
                /* teardown best-effort */
              }
            }
          }),
        )

        const outcomes = launched.map((entry, idx) => {
          runtime.detach(entry.childId, 'done')
          let worktreePath
          let worktreeDiffStat
          if (entry.worktree) {
            const diff = inspectWorktreeChanges(entry.worktree.path)
            if (diff.dirty) {
              worktreePath = entry.worktree.path
              worktreeDiffStat = diff.summary
            } else {
              removeTentacleWorktree(root, entry.worktree.path)
            }
          }
          const outcome = settled[idx]
          if (outcome.status === 'fulfilled') {
            const val = outcome.value
            const stop = val?.stopReason ?? 'completed'
            const ok = stop === 'completed' || stop === 'stop' || stop === 'end_turn'
            return {
              label: entry.label,
              lens: entry.lens,
              model: entry.model,
              exitCode: ok ? 0 : 1,
              timedOut: stop === 'aborted' || stop === 'timeout',
              output: extractSubagentText(val),
              ...(worktreePath ? { worktreePath, worktreeDiffStat } : {}),
            }
          }
          const reason = outcome.reason?.message ?? String(outcome.reason ?? 'unknown error')
          return {
            label: entry.label,
            lens: entry.lens,
            model: entry.model,
            exitCode: 1,
            timedOut: Boolean(exec.signal?.aborted),
            output: `[tentacle error] ${reason}`,
            ...(worktreePath ? { worktreePath, worktreeDiffStat } : {}),
          }
        })

        recorder.endRun(runId, exec.signal?.aborted ? 'cancelled' : 'completed')

        const finalMeta = getFieldMeta(root, fieldId)
        const breached = Boolean(finalMeta?.breachSeq || finalMeta?.status === 'breached')
        closeField(root, fieldId, { status: breached ? 'breached' : 'closed' })

        const summary = buildCollectiveBoardSummary(root, fieldId, outcomes)
        postNote(root, topicId, {
          author: 'flux',
          content: summary,
          tags: ['flux-synthesis'],
          kind: 'evidence',
          actor,
        })

        const pulseCount = readPulses(root, fieldId).length
        const statusNote = breached
          ? `BREACH verified by ${finalMeta?.breachedBy ?? 'tentacle'} (pulse #${finalMeta?.breachSeq ?? '?'})`
          : 'natural saturation'
        return text(
          `Live Flux complete (${tentacleCount} tentacles, ${mode}, ${pulseCount} pulses, ${statusNote}).\n` +
            `Single-point structured digest posted to topic "${topicId}".\n\n${summary}\n\n---\n` +
            `Review the collective echoes above, then verify/converge on "${topicId}" (or launch another targeted probe).`,
        )
      } catch (err) {
        recorder.endRun(runId, exec.signal?.aborted ? 'cancelled' : 'error')
        for (const entry of launched) {
          runtime.detach(entry.childId, 'done')
          try {
            await entry.receipt?.dispose?.()
          } catch {
            /* best effort */
          }
        }
        for (const wt of createdWorktrees) {
          removeTentacleWorktree(root, wt.path)
        }
        closeField(root, fieldId)
        throw err
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Human Slash Commands: `/flux` and `/field` (via DSH `ctx.commands`)
// ---------------------------------------------------------------------------

export function registerFluxCommands(ctx, { runtime, getProjectRoot }) {
  const commands = serviceOf(ctx, 'commands')
  if (!commands || typeof commands.register !== 'function') return
  if (!runtime.markCommandsRegistered()) return

  const resolveRoot = (invocation) => {
    const agent = invocation?.agent
    if (agent) {
      try {
        return getProjectRoot({ agent })
      } catch {
        /* fallback */
      }
    }
    return ctx.workingDirectory?.get?.(agent?.session) ?? process.cwd()
  }

  ctx.effect(() =>
    commands.register({
      definitionId: '@local/dsh-pi-harness:flux',
      name: 'flux',
      description: 'Configure or inspect Live Flux collective intelligence (model pool, tentacles, topology)',
      input: {
        hint: '[status|models|toggle <provider/id>|on [models]|clear|off|tentacles <N|auto>|mode shared|worktree|scope global|project]',
      },
      async handler(invocation) {
        const root = resolveRoot(invocation)
        const raw = String(invocation?.rawInput ?? '').trim()
        const lower = raw.toLowerCase()

        if (!raw || lower === 'status') {
          return { kind: 'success', text: formatFluxStatus(root, invocation?.agent) }
        }

        if (lower === 'models' || lower === 'list') {
          return { kind: 'success', text: await formatFluxModels(ctx, root, invocation?.agent) }
        }

        if (lower === 'off') {
          const current = getFluxConfig(root)
          setFluxConfig(root, { ...current, enabled: false }, defaultWriteScope(root))
          return { kind: 'success', text: 'Flux mode explicitly disabled. Re-enable anytime with /flux on.' }
        }

        if (lower === 'clear') {
          const current = getFluxConfig(root)
          const scope = defaultWriteScope(root)
          setFluxConfig(root, { ...current, enabled: true, models: [] }, scope)
          return {
            kind: 'success',
            text: `Cleared Flux model pool (${scope}); tentacles now auto-inherit the active session model.`,
          }
        }

        if (lower.startsWith('scope')) {
          const target = raw.slice('scope'.length).trim().toLowerCase()
          if (target !== 'global' && target !== 'project') {
            return { kind: 'error', text: 'Usage: /flux scope global|project' }
          }
          const current = getFluxConfig(root)
          if (target === 'global') {
            setFluxConfig(root, current, 'global')
            const cleared = clearProjectFluxConfig(root)
            return {
              kind: 'success',
              text: `Saved Flux config globally (${getGlobalFluxPath(root)})${cleared ? ' and removed project override' : ''}.`,
            }
          }
          setFluxConfig(root, current, 'project')
          return {
            kind: 'success',
            text: `Saved project-local Flux override (${getProjectFluxPath(root)}).`,
          }
        }

        if (lower.startsWith('tentacles')) {
          const arg = raw.slice('tentacles'.length).trim().toLowerCase()
          const current = getFluxConfig(root)
          const scope = defaultWriteScope(root)
          if (arg === 'auto') {
            const { tentacles: _drop, ...rest } = current
            setFluxConfig(root, { ...rest, enabled: true }, scope)
            return { kind: 'success', text: 'Flux tentacles reset to auto (3+ concurrent agents).' }
          }
          const n = parseInt(arg, 10)
          if (Number.isNaN(n) || n < 1 || n > 8) {
            return { kind: 'error', text: 'Usage: /flux tentacles <1-8|auto>' }
          }
          setFluxConfig(root, { ...current, enabled: true, tentacles: n }, scope)
          return { kind: 'success', text: `Flux tentacles set to ${n} (${scope}).` }
        }

        if (lower.startsWith('mode')) {
          const mode = raw.slice('mode'.length).trim().toLowerCase()
          if (mode !== 'shared' && mode !== 'worktree') {
            return { kind: 'error', text: 'Usage: /flux mode shared|worktree' }
          }
          const current = getFluxConfig(root)
          const scope = defaultWriteScope(root)
          setFluxConfig(root, { ...current, enabled: true, mode }, scope)
          return { kind: 'success', text: `Flux topology set to ${mode} (${scope}).` }
        }

        if (lower.startsWith('toggle ')) {
          const token = raw.slice('toggle '.length).trim()
          if (!token) return { kind: 'error', text: 'Usage: /flux toggle <provider/id>' }
          const available = await listAvailableModels(ctx)
          const parentRoute = activeModelRouteOf(invocation?.agent)
          const match = available.length ? fuzzyMatchModel(token, available, parentRoute?.provider) : null
          const spec = match ? formatModelSpec(match) : token
          const current = getFluxConfig(root)
          const scope = defaultWriteScope(root)
          const nextModels = current.models.includes(spec)
            ? current.models.filter((m) => m !== spec)
            : [...current.models, spec]
          setFluxConfig(root, { ...current, enabled: true, models: nextModels }, scope)
          const verb = nextModels.includes(spec) ? 'Added' : 'Removed'
          return {
            kind: 'success',
            text: `${verb} ${spec} (auto-saved to ${scope}).\n\n${formatFluxStatus(root, invocation?.agent)}`,
          }
        }

        if (lower === 'on' || lower.startsWith('on ')) {
          const modelsStr = raw.slice(2).trim()
          const current = getFluxConfig(root)
          const scope = defaultWriteScope(root)
          if (!modelsStr) {
            setFluxConfig(root, { ...current, enabled: true }, scope)
            return { kind: 'success', text: formatFluxStatus(root, invocation?.agent) }
          }
          const requested = modelsStr
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          const available = await listAvailableModels(ctx)
          const parentRoute = activeModelRouteOf(invocation?.agent)
          const resolved = []
          const unmatched = []
          for (const token of requested) {
            if (!available.length) {
              resolved.push(token)
              continue
            }
            const match = fuzzyMatchModel(token, available, parentRoute?.provider)
            if (match) resolved.push(formatModelSpec(match))
            else unmatched.push(token)
          }
          if (unmatched.length > 0) {
            return {
              kind: 'error',
              text: `Cannot find models matching: ${unmatched.join(', ')}\nRun /flux models to inspect available provider/id routes.`,
            }
          }
          setFluxConfig(root, { ...current, enabled: true, models: resolved }, scope)
          return {
            kind: 'success',
            text: `Live Flux enabled (${scope}).\nModels: ${resolved.join(', ')}`,
          }
        }

        return {
          kind: 'error',
          text: 'Usage: /flux [status|models|toggle <provider/id>|on [models]|clear|off|tentacles <N|auto>|mode shared|worktree|scope global|project]',
        }
      },
    }),
  )

  ctx.effect(() =>
    commands.register({
      definitionId: '@local/dsh-pi-harness:field',
      name: 'field',
      description: 'Open, join, leave, or inspect a Live Sideline Field shared across tabs and WSL pi',
      input: { hint: '[status|list|open <id> <goal>|join <id> [lens]|leave|close [id]]' },
      handler(invocation) {
        const root = resolveRoot(invocation)
        const agentId = invocation?.agent?.id ? String(invocation.agent.id) : null
        const att = runtime.get(agentId)
        const parts = String(invocation?.rawInput ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
        const sub = (parts[0] || 'status').toLowerCase()

        if (sub === 'status') {
          if (!att) {
            const active = listFields(root).filter((f) => f.status !== 'closed')
            const hint = active.length
              ? `\nActive fields:\n${active.map((f) => `  - ${f.id} [${f.status}; ${f.mode}] — ${f.goal}`).join('\n')}\nJoin with: /field join <id> [lens]`
              : '\nNo active fields. Open one with: /field open <id> <goal>'
            return { kind: 'success', text: `Field: detached${hint}` }
          }
          return {
            kind: 'success',
            text: buildFieldSnapshot(att.projectRoot, att.fieldId, { selfActorId: att.actorId }),
          }
        }

        if (sub === 'list') {
          const all = listFields(root)
          return {
            kind: 'success',
            text: all.length
              ? all
                  .map(
                    (f) =>
                      `- ${f.id} [${f.status}; ${f.mode}]${att?.fieldId === f.id ? ' *' : ''} — ${f.goal}`,
                  )
                  .join('\n')
              : 'No fields in this workspace.',
          }
        }

        if (sub === 'open') {
          const id = parts[1]
          const goal = parts.slice(2).join(' ').trim()
          if (!id || !goal) return { kind: 'error', text: 'Usage: /field open <id> <goal>' }
          const meta = openField(root, id, goal, { rootCwd: root, createdBy: agentId ?? 'dsh' })
          if (agentId) runtime.attach(agentId, { projectRoot: root, fieldId: meta.id })
          return {
            kind: 'success',
            text: `Opened & joined live field "${meta.id}" — ${meta.goal}\nOther tabs or WSL pi sessions can join with: /field join ${meta.id} [spine|seam|probe|invert|scout]`,
          }
        }

        if (sub === 'join') {
          const id = parts[1]
          const lens = parts[2]
          if (!id) return { kind: 'error', text: 'Usage: /field join <id> [lens]' }
          const meta = getFieldMeta(root, id)
          if (!meta) return { kind: 'error', text: `Field "${id}" not found.` }
          if (agentId) runtime.attach(agentId, { projectRoot: root, fieldId: meta.id, lens })
          return {
            kind: 'success',
            text: `Joined live field "${meta.id}"${lens ? ` (lens=${lens})` : ''}.\n${buildFieldSnapshot(root, meta.id, { selfActorId: agentId ?? undefined })}`,
          }
        }

        if (sub === 'leave') {
          const prev = runtime.detach(agentId, 'done')
          return {
            kind: 'success',
            text: prev
              ? `Left field "${prev.fieldId}" and released held resources.`
              : 'Not attached to any field.',
          }
        }

        if (sub === 'close') {
          const id = parts[1] || att?.fieldId
          if (!id) return { kind: 'error', text: 'Usage: /field close <id>' }
          closeField(root, id)
          if (agentId && att?.fieldId === id) runtime.detach(agentId, 'done')
          return { kind: 'success', text: `Closed field "${id}".` }
        }

        return {
          kind: 'error',
          text: 'Usage: /field [status|list|open <id> <goal>|join <id> [lens]|leave|close [id]]',
        }
      },
    }),
  )
}
