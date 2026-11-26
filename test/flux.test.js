import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as bridge from '../index.js'
import * as commandsPlugin from '../commands.js'
import * as engine from '../lib/engine.js'
import { readTopic } from '../lib/board.js'
import { fixture, SurfaceSession } from './fixtures.js'

function fluxHost(root, { llm, subagents, includeCommands = true } = {}) {
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const sections = []
  const rootMarker = {}

  const ctx = {
    root: rootMarker,
    effect: (fn) => fn(),
    inject: () => {},
    workingDirectory: { get: () => root, ensure: async () => root },
    tools: {
      register: (def) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    systemPrompt: {
      section: (sec) => {
        sections.push(sec)
        return () => {
          const i = sections.indexOf(sec)
          if (i >= 0) sections.splice(i, 1)
        }
      },
    },
    ...(includeCommands
      ? {
          commands: {
            register: (def) => {
              commands.set(def.name, def)
              return () => commands.delete(def.name)
            },
          },
        }
      : {}),
    ...(llm ? { llm } : {}),
    ...(subagents ? { subagents } : {}),
    get(name) {
      return this[name]
    },
    logger: { warn: () => {}, info: () => {} },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
  }

  async function dispatchWaterfall(event, ...args) {
    const terminal = args.pop()
    const callbacks = handlers.get(event) ?? []
    const run = (index) =>
      index < callbacks.length ? callbacks[index](...args, () => run(index + 1)) : terminal()
    return run(0)
  }

  function emit(event, payload) {
    for (const fn of handlers.get(event) ?? []) fn(payload)
  }

  function renderFieldSection(agent) {
    const sec = sections.find((s) => s.name === 'pi-harness-field')
    if (!sec) return ''
    return typeof sec.text === 'function' ? sec.text({ agent }) : sec.text
  }

  async function runTool(agent, name, args, bodyFn) {
    const exec = {
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    }
    const raw = await dispatchWaterfall('tools/execute', exec, async () => {
      if (bodyFn) return bodyFn(exec)
      const def = tools.get(name)
      assert.ok(def, `tool "${name}" not registered`)
      const value = await def.execute(args, exec)
      return { content: def.output.render(args, value), value, isError: false }
    })
    const post = await dispatchWaterfall('tools/post-execute', exec, raw, async () => ({
      kind: 'accept',
    }))
    return { ...raw, ...(post?.content ? { content: post.content } : {}) }
  }

  return { ctx, tools, commands, sections, dispatchWaterfall, emit, renderFieldSection, runTool }
}

test('engine exposes bundled Live Field & Flux primitives with global/project layering and multi-project isolation', (t) => {
  assert.equal(engine.engineStatus().ok, true)
  const f1 = fixture(t)
  const f2 = fixture(t)

  // Default zero-config ON
  const defCfg = engine.getFluxConfig(f1.root)
  assert.equal(defCfg.enabled, true)
  assert.equal(defCfg.configured, false)
  assert.equal(defCfg.source, 'default')
  assert.equal(engine.isFluxDisabled(defCfg), false)

  // Global config visible across both projects
  engine.setFluxConfig(
    f1.root,
    { enabled: true, models: ['ollama-cloud/deepseek-v4.1-flash:1017'], tentacles: 4, mode: 'shared' },
    'global',
  )
  assert.equal(engine.getFluxConfig(f2.root).source, 'global')
  assert.deepEqual(engine.getFluxConfig(f2.root).models, ['ollama-cloud/deepseek-v4.1-flash:1017'])

  // Project override in f1 does NOT bleed into f2
  engine.setFluxConfig(f1.root, { enabled: false, models: [] }, 'project')
  assert.equal(engine.isFluxDisabled(engine.getFluxConfig(f1.root)), true)
  assert.equal(engine.isFluxDisabled(engine.getFluxConfig(f2.root)), false)

  // Clearing f1 project override restores global config
  assert.equal(engine.clearProjectFluxConfig(f1.root), true)
  assert.equal(engine.getFluxConfig(f1.root).source, 'global')
  assert.equal(engine.isFluxDisabled(engine.getFluxConfig(f1.root)), false)
})

test('Live Sideline Field middleware: zero cost unattached, scoped prompt + snapshot + step-level [FIELD Δ] + focusArea overlap + auto lock release', async (t) => {
  const f = fixture(t)
  const h = fluxHost(f.root)
  bridge.apply(h.ctx, { injectReference: false, doctrine: false })

  const agentA = { id: 'sess-a', session: new SurfaceSession() }
  const agentB = { id: 'sess-b', session: new SurfaceSession() }
  const plain = { id: 'sess-plain', session: new SurfaceSession() }

  // Unattached agent gets zero system prompt & zero pre-step injection
  assert.equal(h.renderFieldSection(plain), '')
  const plainPre = await h.dispatchWaterfall(
    'agent/pre-step',
    { agent: plain, turn: 1, step: 0 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(plainPre.messages.length, 0)

  // A opens field, B joins with lens=seam
  await h.runTool(agentA, 'field', { action: 'open', field: 'dsh-hunt', goal: 'trace auth bypass' })
  await h.runTool(agentB, 'field', { action: 'join', field: 'dsh-hunt', lens: 'seam' })

  // Scoped system prompt injects Live Field + FLUX_DISCIPLINE only for attached agents
  assert.match(h.renderFieldSection(agentB), /Live Sideline Field \(dsh-hunt\)/)
  assert.match(h.renderFieldSection(agentB), /DRIVE BY WORLD FEEDBACK/)
  assert.equal(h.renderFieldSection(plain), '')

  // First pre-step delivers [FIELD SNAPSHOT] once
  const bPre1 = await h.dispatchWaterfall(
    'agent/pre-step',
    { agent: agentB, turn: 1, step: 0 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(bPre1.messages.length, 1)
  assert.match(bPre1.messages[0].content[0].text, /FIELD SNAPSHOT/)
  const bPre2 = await h.dispatchWaterfall(
    'agent/pre-step',
    { agent: agentB, turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(bPre2.messages.length, 0)

  // A claims exclusive resource & emits objective echo pulse; B tries to claim -> BUSY
  const claimA = await h.runTool(agentA, 'field', {
    action: 'claim',
    resource: 'device@usb0',
    purpose: 'dynamic trace',
  })
  assert.match(claimA.content[0].text, /Claimed exclusive resource/)

  const claimB = await h.runTool(agentB, 'field', {
    action: 'claim',
    resource: 'device@usb0',
    purpose: 'also trace',
  })
  assert.match(claimB.content[0].text, /BUSY/)

  await h.runTool(agentA, 'field', {
    action: 'pulse',
    kind: 'echo',
    anchor: 'analysis/unpack/tools/reloc.py:12',
    fact: 'Empirical scan found 40 shifted slots',
    next: 'verify reloc base',
  })

  // A touches analysis/unpack/tools/reloc.py via read_file
  await h.runTool(agentA, 'read_file', { file_path: 'analysis/unpack/tools/reloc.py' }, async () => ({
    content: [{ type: 'text', text: 'reloc code' }],
    isError: false,
  }))

  // B touches analysis/unpack/tools/dump.py -> post-execute piggybacks [FIELD Δ] with pulse + LOCK + subdirectory OVERLAP
  const bRead = await h.runTool(
    agentB,
    'read_file',
    { file_path: 'analysis/unpack/tools/dump.py' },
    async () => ({
      content: [{ type: 'text', text: 'dump code' }],
      isError: false,
    }),
  )
  assert.equal(bRead.content.length, 2)
  assert.match(bRead.content[1].text, /\[FIELD Δ/)
  assert.match(bRead.content[1].text, /Empirical scan found 40 shifted slots/)
  assert.match(bRead.content[1].text, /LOCK: device@usb0/)
  assert.match(bRead.content[1].text, /OVERLAP:.*analysis\/unpack\/tools/)

  // Premature close refused while peer is active
  const earlyClose = await h.runTool(agentA, 'field', { action: 'close', field: 'dsh-hunt' })
  assert.match(earlyClose.content[0].text, /Cannot close field/)

  // subagent/end detaches A and auto-releases held lock
  h.emit('subagent/end', { childId: 'sess-a' })
  assert.equal(engine.listResources(f.root, 'dsh-hunt').length, 0)
})

test('flux tool: zero-config concurrent in-process tentacles + worktree isolation + breach wave + single-point Board digest', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'dsh-flux-repo-'))
  t.after(() => rmSync(repoDir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
  writeFileSync(join(repoDir, 'wall.txt'), 'sealed\n', 'utf-8')
  execFileSync('git', ['add', 'wall.txt'], { cwd: repoDir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoDir })

  // Ensure zero-config state (no project flux.json, clean global pool)
  engine.clearProjectFluxConfig(repoDir)
  engine.setFluxConfig(repoDir, { enabled: true, models: [] }, 'global')

  const startedSpecs = []
  const usedSubagentNames = new Set()
  const disposedIds = []
  const promptSnapshots = new Map()

  let h
  const mockSubagents = {
    getProvider: (name) => (name === 'spawn' ? { name: 'spawn', inheritsParentContext: false } : undefined),
    async startActivation(spec) {
      // Simulate real DSH SiblingNameReservations: duplicate sibling names in one parent session throw!
      assert.match(spec.name, /^[a-z][a-z0-9-]{0,31}$/)
      assert.equal(usedSubagentNames.has(spec.name), false, `duplicate subagent name "${spec.name}"`)
      usedSubagentNames.add(spec.name)
      startedSpecs.push(spec)
      const childAgent = { id: spec.childId, session: new SurfaceSession() }
      // Verify tentacle already has scoped Live Field + BOUNDARY + FLUX_DISCIPLINE before step 1!
      promptSnapshots.set(spec.name, h.renderFieldSection(childAgent))

      const resultPromise = (async () => {
        // Tentacle must be blocked from nesting another flux swarm
        const nested = await h.runTool(childAgent, 'flux', { action: 'run', question: 'nested' })
        assert.match(nested.content[0].text, /cannot nest another flux swarm/i)

        if (spec.name.includes('seam')) {
          writeFileSync(join(spec.cwd, 'wall.txt'), 'breached-in-worktree\n', 'utf-8')
          await h.runTool(childAgent, 'field', {
            action: 'pulse',
            kind: 'breach',
            anchor: 'wall.txt:1',
            fact: 'Verified seam crack inside isolated worktree',
          })
          return { output: [{ type: 'text', text: 'seam verified breach' }], stopReason: 'completed' }
        }
        await new Promise((r) => setTimeout(r, 35))
        // Spine runs a read tool and receives seam's BREACH WAVE via post-execute sideline
        const readRes = await h.runTool(childAgent, 'read_file', { file_path: 'wall.txt' }, async () => ({
          content: [{ type: 'text', text: 'sealed' }],
          isError: false,
        }))
        const sawBreach = readRes.content.some((b) => /BREACH WAVE/.test(b.text))
        await h.runTool(childAgent, 'field', {
          action: 'pulse',
          kind: 'echo',
          fact: sawBreach ? 'Received BREACH WAVE and orthogonally verified wall.txt' : 'checked wall.txt',
        })
        return { output: [{ type: 'text', text: `spine done (sawBreach=${sawBreach})` }], stopReason: 'completed' }
      })()

      return {
        childId: spec.childId,
        name: spec.name,
        result: resultPromise,
        dispose: async () => {
          disposedIds.push(spec.childId)
        },
      }
    },
  }

  const mockLlm = {
    listProviders: () => [
      { id: 'ollama-cloud', name: 'Ollama Cloud' },
      { id: 'zai-coding-cn', name: 'ZAI' },
    ],
    listModels: async (provider) => {
      if (provider === 'ollama-cloud') {
        return [{ id: 'deepseek-v4.1-flash:1017', name: 'DeepSeek v4.1 Flash' }]
      }
      return [{ id: 'glm-5.3', name: 'GLM 5.3' }]
    },
  }

  h = fluxHost(repoDir, { llm: mockLlm, subagents: mockSubagents })
  bridge.apply(h.ctx, { injectReference: false, doctrine: false })

  const recordedEvents = []
  const parentBaseSession = new SurfaceSession()
  const parentAgent = {
    id: 'parent-lead',
    // Real DSH: stale initial `agent.options` vs live `session.requestHeader().config`!
    options: { provider: 'zai-coding-cn', model: 'glm-5.3' },
    session: Object.assign(parentBaseSession, {
      requestHeader: () => ({ config: { provider: 'ollama-cloud', model: 'deepseek-v4.1-flash:1017' } }),
      append(type, data, options) {
        if (type.startsWith('tool-workflow/')) {
          recordedEvents.push({ type, data })
          return
        }
        return SurfaceSession.prototype.append.call(this, type, data, options)
      },
    }),
  }

  // Zero-config run without pre-opening topic!
  const res = await h.runTool(parentAgent, 'flux', {
    action: 'run',
    topic: 'siege-auto',
    question: 'Break wall.txt via seam or spine',
    lenses: ['spine', 'seam'],
    mode: 'worktree',
  })

  const outText = res.content[0].text
  assert.match(outText, /Live Flux complete \(2 tentacles, worktree, 2 pulses, BREACH verified/)
  assert.match(outText, /Verified seam crack inside isolated worktree/)
  assert.match(outText, /Worktree changes/)
  assert.match(outText, /sawBreach=true/)

  // Both tentacles inherited parent model (no agentOptions override needed) and got BOUNDARY prompt
  assert.equal(startedSpecs.length, 2)
  assert.equal(startedSpecs[0].agentOptions, undefined)
  assert.match(promptSnapshots.get(startedSpecs[0].name), /BOUNDARY/)
  assert.match(promptSnapshots.get(startedSpecs[1].name), /DRIVE BY WORLD FEEDBACK/)
  assert.equal(disposedIds.length, 2)

  // Inline live run panel events (tool-workflow/*) recorded on parent session in exact lifecycle order
  const wfEvents = recordedEvents
  assert.deepEqual(
    wfEvents.map((e) => e.type),
    [
      'tool-workflow/run-start',
      'tool-workflow/agent-start',
      'tool-workflow/agent-start',
      'tool-workflow/agent-end',
      'tool-workflow/agent-end',
      'tool-workflow/run-end',
    ],
  )
  assert.equal(wfEvents[0].data.name, 'flux · siege-auto')
  assert.equal(wfEvents[1].data.phase, 'Live Field (worktree)')
  assert.match(wfEvents[1].data.label, /ollama-cloud\/deepseek-v4\.1-flash:1017/)
  assert.equal(wfEvents[1].data.childId, startedSpecs[0].childId)
  // Seam finished faster than spine (35ms sleep), so seam's agent-end (seq=2) streamed BEFORE spine's (seq=1)!
  assert.equal(wfEvents[3].data.seq, 2)
  assert.equal(wfEvents[3].data.outcome, 'completed')
  assert.equal(wfEvents[4].data.seq, 1)
  assert.equal(wfEvents[4].data.outcome, 'completed')
  assert.equal(wfEvents[5].data.stopReason, 'completed')

  // Dirty worktree preserved; clean worktree removed
  assert.equal(existsSync(startedSpecs[1].cwd), true)
  assert.equal(existsSync(startedSpecs[0].cwd), false)

  // Main Board topic auto-opened and received ONE single-point flux synthesis note
  const boardState = readTopic(repoDir, 'siege-auto')
  assert.equal(boardState.notes.length, 1)
  assert.equal(boardState.notes[0].author, 'flux')
  assert.equal(boardState.notes[0].kind, 'evidence')
  assert.match(boardState.notes[0].content, /Live Flux Field:/)

  // Multi-channel catalog discovery & config auto-save
  const modelsRes = await h.runTool(parentAgent, 'flux', { action: 'models' })
  assert.match(modelsRes.content[0].text, /ollama-cloud\/deepseek-v4\.1-flash:1017 \* \(current\)/)
  assert.match(modelsRes.content[0].text, /zai-coding-cn\/glm-5\.3/)

  await h.runTool(parentAgent, 'flux', {
    action: 'config',
    models: ['glm-5.3', 'ollama-cloud/deepseek-v4.1-flash:1017'],
    tentacles: 2,
    mode: 'shared',
    scope: 'project',
  })
  const saved = engine.getFluxConfig(repoDir)
  assert.equal(saved.source, 'project')
  assert.deepEqual(saved.models, ['zai-coding-cn/glm-5.3', 'ollama-cloud/deepseek-v4.1-flash:1017'])

  // Next run passes exact multi-channel { provider, model } agentOptions per tentacle!
  startedSpecs.length = 0
  await h.runTool(parentAgent, 'flux', {
    action: 'run',
    topic: 'siege-multi-channel',
    question: 'Check channel routing',
    lenses: ['spine', 'seam'],
    mode: 'shared',
  })
  assert.deepEqual(startedSpecs[0].agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3' })
  assert.deepEqual(startedSpecs[1].agentOptions, {
    provider: 'ollama-cloud',
    model: 'deepseek-v4.1-flash:1017',
  })
})

test('commands.js sibling plugin registers /flux and /field sharing the same FieldRuntime', async (t) => {
  const f = fixture(t)
  const mockLlm = {
    listProviders: () => [{ id: 'ollama-cloud', name: 'Ollama Cloud' }],
    listModels: async () => [{ id: 'deepseek-v4.1-flash:1017', name: 'Flash' }],
  }
  const h = fluxHost(f.root, { llm: mockLlm, includeCommands: false })

  // Mount pi-harness BEFORE commands service exists (realistic Cordis startup order)
  bridge.apply(h.ctx, { injectReference: false, doctrine: false })
  assert.equal(h.commands.size, 0)

  // Now commands service arrives and pi-harness-commands mounts on the same ctx.root
  h.ctx.commands = {
    register: (def) => {
      h.commands.set(def.name, def)
      return () => h.commands.delete(def.name)
    },
  }
  commandsPlugin.apply(h.ctx)
  assert.ok(h.commands.has('flux'))
  assert.ok(h.commands.has('field'))

  const agent = { id: 'cmd-user', session: new SurfaceSession() }
  const invoke = (cmd, rawInput = '') => h.commands.get(cmd).handler({ agent, rawInput })

  // /flux toggle auto-saves full provider/id
  const toggled = await invoke('flux', 'toggle deepseek-v4.1-flash:1017')
  assert.equal(toggled.kind, 'success')
  assert.match(toggled.text, /Added ollama-cloud\/deepseek-v4\.1-flash:1017/)
  assert.deepEqual(engine.getFluxConfig(f.root).models, ['ollama-cloud/deepseek-v4.1-flash:1017'])

  // /flux toggle again removes it
  const toggledOff = await invoke('flux', 'toggle ollama-cloud/deepseek-v4.1-flash:1017')
  assert.match(toggledOff.text, /Removed ollama-cloud\/deepseek-v4\.1-flash:1017/)
  assert.deepEqual(engine.getFluxConfig(f.root).models, [])

  // /field open attaches the exact same runtime seen by systemPrompt.section!
  const opened = await invoke('field', 'open tab-hunt locate root cause')
  assert.equal(opened.kind, 'success')
  assert.match(h.renderFieldSection(agent), /Live Sideline Field \(tab-hunt\)/)

  const left = await invoke('field', 'leave')
  assert.equal(left.kind, 'success')
  assert.equal(h.renderFieldSection(agent), '')
})
