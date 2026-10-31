import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

// Keep all tests away from the user's global knowledge and real project data.
const home = mkdtempSync(join(tmpdir(), 'dsh-reference-home-'))
process.env.USERPROFILE = home
process.env.HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reference-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.git'))
  const topics = new Map()
  function topic(id, notes = [], { goal = `Goal for ${id}`, createdAt = 1000 } = {}) {
    const path = join(root, '.pi-board', 'topics', `${id}.jsonl`)
    mkdirSync(join(root, '.pi-board', 'topics'), { recursive: true })
    const records = notes.map((note, i) => ({ seq: i + 1, author: 'test', timestamp: 1000 + i, ...note }))
    writeFileSync(path, [`#META#${JSON.stringify({ id, goal, status: 'open', createdAt })}`, ...records.map((note) => JSON.stringify(note))].join('\n') + '\n')
    topics.set(id, { path, notes: records })
    return records
  }
  function post(id, note) {
    const entry = topics.get(id)
    const record = { seq: entry.notes.length + 1, author: 'test', timestamp: Date.now(), ...note }
    appendFileSync(entry.path, JSON.stringify(record) + '\n')
    entry.notes.push(record)
    return record
  }
  function handoff(content = 'NEXT_ACTION') {
    writeFileSync(join(root, 'HANDOFF.md'), `# Session\n\n## Next\n${content}\n`)
  }
  return { root, topic, post, handoff }
}

export class SurfaceSession {
  messages = []
  admitted = []
  deriveMessages() { return [...this.messages] }
  append(type, data, options) {
    if (type !== 'user/message' || options.surfaceOp !== 'append') throw new Error('unexpected session mutation')
    if (this.admitted.some((entry) => entry.id === data.id)) throw new Error('duplicate admitted message id')
    this.admitted.push(data)
    this.messages.push(data)
  }
  compact(predicate = (entry) => entry.source?.kind === 'pi-harness') {
    this.messages = this.messages.filter((entry) => !predicate(entry))
  }
}

export function host(root, { goal, ensure, session = new SurfaceSession() } = {}) {
  const handlers = new Map()
  const warnings = []
  const optional = []
  const ctx = {
    effect: (fn) => fn(),
    inject(names, fn) { optional.push(names); if (goal) fn({ ...ctx, goals: goal }) },
    workingDirectory: { get: () => root, ensure: ensure ?? (async () => root) },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    logger: { warn: (value) => warnings.push(value) },
    on(event, fn) { const list = handlers.get(event) ?? []; list.push(fn); handlers.set(event, list) },
  }
  const agent = { id: 'test-agent', session }
  async function dispatch(event, position, terminal) {
    const callbacks = handlers.get(event) ?? []
    const payload = { agent, turn: 1, step: 0, ...position }
    const run = (index) => index < callbacks.length ? callbacks[index](payload, () => run(index + 1)) : terminal()
    return run(0)
  }
  const pre = (position = {}, messages = []) => dispatch('agent/pre-step', position, async () => ({ kind: 'enter', messages }))
  const request = (position = {}, terminal = async () => ({ provider: 'test', model: 'test' })) => dispatch('agent/request', position, terminal)
  async function step(position = {}, messages = []) {
    const decision = await pre(position, messages)
    await request(position)
    for (const entry of decision.messages) session.append('user/message', entry, { surfaceOp: 'append' })
    return decision
  }
  return { ctx, agent, session, warnings, optional, dispatch, pre, request, step }
}
