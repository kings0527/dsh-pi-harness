// Shared Board storage, byte-compatible with pi-harness `.pi-board/`.
//
// Layout (identical to pi-harness):
//   .pi-board/topics/<id>.jsonl          first line `#META#<json>`, then one note per line
//   .pi-board/topics/<id>.board.md       rendered, derived view
//   .pi-board/topics/archive/<id>.jsonl  closed topic
//   .pi-board/topics/archive/<id>.summary.md / .decisions.md / .board.md
//   .pi-board/events.jsonl               append-only audit log
//
// Invariants preserved from pi-harness: append-only notes, strictly
// contiguous seq 1..N, fail-loud on corruption, close writes a v1 witness.

import { join } from 'node:path'
import {
  BOARD_DIRNAME,
  appendLine,
  atomicWrite,
  ensureDir,
  exists,
  listFiles,
  oneLine,
  openExclusive,
  readText,
  sha256,
  unlinkSync,
  withTopicLock,
} from './util.js'

export const NOTE_KINDS = [
  'declare',
  'plan',
  'claim',
  'evidence',
  'challenge',
  'verification',
  'decision',
  'retraction',
  'convergence',
]

export const RELATIONS = ['supports', 'depends-on', 'conflicts-with', 'duplicate-of', 'child-of']

export function boardRoot(root) {
  return join(root, BOARD_DIRNAME)
}

function topicsDir(root) {
  return join(boardRoot(root), 'topics')
}

function archiveDir(root) {
  return join(topicsDir(root), 'archive')
}

function topicPath(root, id) {
  assertTopicId(id)
  return join(topicsDir(root), `${id}.jsonl`)
}

function archivedPath(root, id) {
  assertTopicId(id)
  return join(archiveDir(root), `${id}.jsonl`)
}

export function assertTopicId(id) {
  if (typeof id !== 'string' || id.length === 0 || /[\\/\0]/.test(id)) {
    throw new Error('Topic ID must be one non-empty path segment (no slashes)')
  }
  if (id === 'archive' || id.startsWith('.')) {
    throw new Error(`Topic ID "${id}" is reserved`)
  }
}

export function appendEvent(root, type, details = {}) {
  try {
    appendLine(join(boardRoot(root), 'events.jsonl'), JSON.stringify({ type, timestamp: Date.now(), details }))
  } catch {
    // Audit logging is secondary; the Board files stay authoritative.
  }
}

function validTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
}

export function validateTopic(topic) {
  if (!topic || typeof topic !== 'object') return 'META is not an object'
  if (typeof topic.id !== 'string' || !topic.id) return 'META id is not a non-empty string'
  if (typeof topic.goal !== 'string') return 'META goal is not a string'
  if (topic.status !== 'open' && topic.status !== 'closed') return 'META status is not open/closed'
  if (!validTimestamp(topic.createdAt)) return 'META createdAt is not a valid date'
  if (topic.closedAt !== undefined && !validTimestamp(topic.closedAt)) return 'META closedAt is not a valid date'
  if (topic.integrityVersion !== undefined && topic.integrityVersion !== 1) return 'META integrityVersion is not 1'
  if (topic.finalSeq !== undefined && !Number.isInteger(topic.finalSeq)) return 'META finalSeq is not an integer'
  return null
}

export function validateNote(note) {
  if (!note || typeof note !== 'object') return 'not an object'
  if (!Number.isInteger(note.seq)) return 'seq is not an integer'
  if (typeof note.author !== 'string' || !note.author) return 'author is not a non-empty string'
  if (!validTimestamp(note.timestamp)) return 'timestamp is not a valid date'
  if (typeof note.content !== 'string') return 'content is not a string'
  if (note.tags !== undefined && (!Array.isArray(note.tags) || note.tags.some((t) => typeof t !== 'string'))) {
    return 'tags is not a string array'
  }
  if (note.priority !== undefined && note.priority !== 'critical') return 'priority is not "critical"'
  return null
}

function parseJsonl(path, { expectStatus } = {}) {
  const raw = readText(path)
  if (raw === null) throw new Error(`Topic file not found: ${path}`)
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  if (!lines[0]?.startsWith('#META#')) throw new Error(`Corrupted topic file (missing META line): ${path}`)
  let topic
  try {
    topic = JSON.parse(lines[0].slice(6))
  } catch {
    throw new Error(`Corrupted topic file (META is not JSON): ${path}`)
  }
  const topicIssue = validateTopic(topic)
  if (topicIssue) throw new Error(`Corrupted topic file (${topicIssue}): ${path}`)
  if (expectStatus && topic.status !== expectStatus) {
    throw new Error(`Topic file status is ${topic.status}, expected ${expectStatus}: ${path}`)
  }
  const notes = []
  for (let index = 1; index < lines.length; index += 1) {
    let note
    try {
      note = JSON.parse(lines[index])
    } catch {
      throw new Error(`Corrupted topic file (line ${index + 1} is not JSON): ${path}`)
    }
    const issue = validateNote(note)
    if (issue) throw new Error(`Corrupted topic file (line ${index + 1}: ${issue}): ${path}`)
    if (note.seq !== index) {
      throw new Error(
        `Corrupted topic file (seq discontinuity: expected #${index}, got ${note.seq} — external rewrite or Git conflict?): ${path}`,
      )
    }
    notes.push(note)
  }
  return { topic, notes }
}

export function topicExists(root, id) {
  return exists(topicPath(root, id))
}

export function readTopic(root, id) {
  if (topicExists(root, id)) return { ...parseJsonl(topicPath(root, id)), archived: false }
  if (exists(archivedPath(root, id))) {
    const parsed = parseJsonl(archivedPath(root, id), { expectStatus: 'closed' })
    return { ...parsed, archived: true }
  }
  throw new Error(`Board topic "${id}" not found in ${boardRoot(root)}`)
}

export function listTopicIds(root) {
  const active = listFiles(topicsDir(root), '.jsonl').map((path) => path.slice(0, -6).split(/[\\/]/).pop())
  const archived = listFiles(archiveDir(root), '.jsonl').map((path) => path.slice(0, -6).split(/[\\/]/).pop())
  return { active: active.filter(Boolean).sort(), archived: archived.filter(Boolean).sort() }
}

export function listTopics(root) {
  const { active, archived } = listTopicIds(root)
  const rows = []
  for (const id of active) {
    try {
      const { topic, notes } = readTopic(root, id)
      rows.push({ ...topic, noteCount: notes.length, lastSeq: notes.at(-1)?.seq ?? 0 })
    } catch (error) {
      rows.push({ id, goal: `[unreadable: ${error.message}]`, status: 'error', noteCount: 0, lastSeq: 0 })
    }
  }
  for (const id of archived) {
    try {
      const { topic, notes } = readTopic(root, id)
      rows.push({ ...topic, noteCount: notes.length, lastSeq: notes.at(-1)?.seq ?? 0 })
    } catch {
      /* a broken archive is reported by read, not by listing */
    }
  }
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

function boardMarkdown(id, topic, notes) {
  let text = `# Topic: ${id}\n\n**Goal**: ${topic.goal}\n**Status**: ${topic.status}\n**Created**: ${new Date(topic.createdAt).toISOString()}\n`
  if (topic.createdBy) text += `**Created by**: ${topic.createdBy.label ?? topic.createdBy.id} (${topic.createdBy.id})\n`
  text += '\n---\n\n'
  for (const note of notes) {
    const critical = note.priority === 'critical' ? ' 🔴 CRITICAL' : ''
    const tags = note.tags?.length ? ` [${note.tags.join(', ')}]` : ''
    const kind = note.kind ? ` {${note.kind}${note.material ? ', material' : ''}}` : ''
    const actor = note.actor ? ` (${note.actor.id})` : ''
    text += `### #${note.seq} — ${note.author}${actor}${critical}${tags}${kind}\n*${new Date(note.timestamp).toISOString()}*\n\n${note.content}\n\n`
  }
  return text
}

function writeBoardView(root, id, topic, notes, archived = false) {
  const target = archived ? join(archiveDir(root), `${id}.board.md`) : join(topicsDir(root), `${id}.board.md`)
  atomicWrite(target, boardMarkdown(id, topic, notes))
}

export function openTopic(root, id, goal, { actor, relations } = {}) {
  assertTopicId(id)
  const path = topicPath(root, id)
  return withTopicLock(path, () => {
    if (exists(archivedPath(root, id))) throw new Error(`Topic "${id}" already exists in the archive`)
    const topic = {
      id,
      goal: String(goal ?? '').trim(),
      status: 'open',
      createdAt: Date.now(),
      ...(actor ? { createdBy: actor } : {}),
      ...(relations?.length ? { relations } : {}),
    }
    if (!topic.goal) throw new Error('A topic needs a non-empty goal')
    try {
      openExclusive(path, `#META#${JSON.stringify(topic)}\n`)
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`Topic "${id}" already exists (topics are append-only identities)`)
      throw error
    }
    writeBoardView(root, id, topic, [])
    appendEvent(root, 'board_open', {
      topic: id,
      goalBytes: Buffer.byteLength(topic.goal, 'utf-8'),
      goalDigest: sha256(topic.goal),
      actorId: actor?.id,
    })
    return topic
  })
}

function normalizeRefs(refs) {
  if (!refs) return undefined
  return refs.map((ref) => {
    const topic = String(ref?.topic ?? '')
    const seq = Number(ref?.seq)
    assertTopicId(topic)
    if (!Number.isInteger(seq) || seq < 1) throw new Error(`Invalid note reference ${topic}#${ref?.seq}`)
    return { topic, seq }
  })
}

export function postNote(root, id, options) {
  const path = topicPath(root, id)
  if (!exists(path)) throw new Error(`Board topic "${id}" not found (it may have been closed; read the archive instead)`)
  const content = String(options.content ?? '')
  if (!content.trim()) throw new Error('A note needs non-empty content')
  return withTopicLock(path, () => {
    const { topic, notes } = parseJsonl(path, { expectStatus: 'open' })
    const seq = notes.length + 1
    const note = {
      seq,
      author: options.author || 'agent',
      timestamp: Date.now(),
      content,
      ...(options.tags?.length ? { tags: options.tags } : {}),
      ...(options.priority === 'critical' ? { priority: 'critical' } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.targets ? { targets: normalizeRefs(options.targets) } : {}),
      ...(options.relations ? { relations: options.relations } : {}),
      ...(options.material !== undefined ? { material: Boolean(options.material) } : {}),
      ...(options.verdict ? { verdict: String(options.verdict) } : {}),
      ...(options.unresolved ? { unresolved: normalizeRefs(options.unresolved) } : {}),
    }
    if (note.kind && !NOTE_KINDS.includes(note.kind)) {
      throw new Error(`Unknown note kind "${note.kind}" (expected one of ${NOTE_KINDS.join(', ')})`)
    }
    if (note.kind && !note.actor) throw new Error('A structured note needs a runtime actor (call through the board tool)')
    for (const relation of note.relations ?? []) {
      if (!RELATIONS.includes(relation.type) || !relation.topic) throw new Error('A relation needs a known type and a topic')
    }
    if (['challenge', 'verification', 'retraction'].includes(note.kind ?? '') && !note.targets?.length) {
      throw new Error(`A ${note.kind} note needs at least one target reference (topic#seq)`)
    }
    if (note.kind === 'convergence' && !note.verdict) {
      throw new Error('A convergence note needs a verdict')
    }
    // Mirror pi-harness validation exactly: pi re-validates every note when it
    // reads the topic, so a note that violates these rules would make the whole
    // topic unreadable to the other harness.
    const declaredTopics = new Set([
      ...(topic.relations ?? []).map((relation) => relation.topic),
      ...notes.flatMap((candidate) => (candidate.relations ?? []).map((relation) => relation.topic)),
      ...(note.relations ?? []).map((relation) => relation.topic),
    ])
    const explicitTargets = note.targets ?? []
    for (const ref of [...explicitTargets, ...(note.unresolved ?? [])]) {
      if (ref.topic !== id && !declaredTopics.has(ref.topic)) {
        throw new Error(`Cross-topic target ${ref.topic} requires a declared relation`)
      }
      const source = ref.topic === id ? notes : readTopic(root, ref.topic).notes
      const record = source.find((candidate) => candidate.seq === ref.seq)
      if (!record) throw new Error(`Note target ${ref.topic}#${ref.seq} does not exist`)
      if (!explicitTargets.some((target) => target.topic === ref.topic && target.seq === ref.seq)) continue
      if (note.kind === 'challenge' && !['claim', 'evidence', 'decision'].includes(record.kind ?? '')) {
        throw new Error('A challenge target must be a claim, evidence, or decision note')
      }
      if (note.kind === 'verification' && record.kind !== 'claim') {
        throw new Error('A verification target must be a claim note')
      }
    }
    appendLine(path, JSON.stringify(note))
    const after = parseJsonl(path, { expectStatus: 'open' })
    if (after.notes.length !== notes.length + 1) throw new Error(`Append verification failed for topic "${id}"`)
    writeBoardView(root, id, after.topic, after.notes)
    appendEvent(root, 'board_post', { topic: id, seq, author: note.author, actorId: note.actor?.id, kind: note.kind })
    return note
  })
}

/** Notes that remain after append-only retractions are applied (newest first walk). */
export function activeNotes(notes) {
  const retracted = new Set()
  const kept = []
  for (const note of [...notes].reverse()) {
    if (retracted.has(note.seq)) continue
    kept.push(note)
    if (note.kind === 'retraction') for (const ref of note.targets ?? []) retracted.add(ref.seq)
  }
  return kept.reverse()
}

export function assessCloseReadiness(root, id) {
  const { topic, notes } = readTopic(root, id)
  const active = activeNotes(notes)
  const convergence = [...active].reverse().find((note) => note.kind === 'convergence' && note.actor)
  const materialClaims = active.filter((note) => note.kind === 'claim' && note.material)
  const accepted = new Set((convergence?.unresolved ?? []).map((ref) => ref.seq))
  const verifiedAt = new Map()
  const decidedAt = new Map()
  for (const note of active) {
    if (note.kind === 'verification') for (const ref of note.targets ?? []) if (ref.topic === id) verifiedAt.set(ref.seq, note.seq)
    if (note.kind === 'decision') for (const ref of note.targets ?? []) if (ref.topic === id) decidedAt.set(ref.seq, note.seq)
  }
  const convergenceSeq = convergence?.seq ?? -1
  // A verification only settles a claim when it predates the verdict; a verdict
  // cannot decide material claims that did not exist when it was posted.
  const openClaims = materialClaims
    .filter(
      (note) =>
        note.seq > convergenceSeq ||
        ((verifiedAt.get(note.seq) ?? Infinity) > convergenceSeq && !accepted.has(note.seq)),
    )
    .map((note) => `#${note.seq}`)
  const openChallenges = active
    .filter((note) => note.kind === 'challenge')
    .filter((note) => !accepted.has(note.seq))
    .filter((note) => {
      const decisionSeq = decidedAt.get(note.seq)
      return note.seq > convergenceSeq || decisionSeq === undefined || decisionSeq > convergenceSeq
    })
    .map((note) => `#${note.seq}`)
  const legacy = !topic.createdBy && !notes.some((note) => note.kind !== undefined)
  if (legacy) {
    // pi keeps a tag-based convention for topics that predate structured notes;
    // the extension gate requires at least one note tagged "convergence".
    const tagged = notes.some((note) => Array.isArray(note.tags) && note.tags.includes('convergence'))
    return tagged
      ? { ready: true, legacy: true, convergence: undefined }
      : { ready: false, legacy: true, reason: 'legacy topic has no note tagged "convergence"' }
  }
  if (!convergence) return { ready: false, reason: 'no structured convergence verdict on the board' }
  if (openClaims.length) return { ready: false, reason: `open material claims: ${openClaims.join(', ')}` }
  if (openChallenges.length) {
    return { ready: false, reason: `open challenges posted after the verdict: ${openChallenges.join(', ')}` }
  }
  return { ready: true, convergence }
}

function summaryMarkdown(id, topic, notes) {
  const participants = [...new Set(notes.map((note) => note.author))].join(', ')
  let text = `<!-- PI_BOARD_SUMMARY v1 totalNotes=${notes.length} -->\n# Summary: ${id}\n\n**Goal**: ${topic.goal}\n`
  text += `**Duration**: ${new Date(topic.createdAt).toISOString()} → ${new Date().toISOString()}\n`
  text += `**Total Notes**: ${notes.length}\n**Participants**: ${participants}\n\n## Discussion Highlights\n\n`
  const critical = notes.filter((note) => note.priority === 'critical')
  if (critical.length) {
    text += '### Critical Notes\n\n'
    for (const note of critical) text += `- [#${note.seq}] ${note.author}: ${note.content}\n`
    text += '\n'
  }
  text += '### Complete Activity\n\n'
  for (const note of notes) text += `- [#${note.seq}] ${note.author}: ${note.content}\n`
  return text
}

function decisionsMarkdown(id, topic, notes) {
  let text = `# Decisions: ${id}\n\n**Goal**: ${topic.goal}\n\n## Key Findings & Decisions\n\n`
  for (const note of notes.filter((candidate) => candidate.priority === 'critical')) {
    text += `### Decision from ${note.author} (seq #${note.seq})\n\n${note.content}\n\n`
  }
  const last = notes.at(-1)
  if (last) text += `### Final Note (seq #${last.seq}, by ${last.author})\n\n${last.content}\n\n`
  return `${text}---\n\n*Generated at topic close. Distill the durable conclusions into knowledge.*\n`
}

export function closeTopic(root, id, { actor } = {}) {
  const path = topicPath(root, id)
  return withTopicLock(path, () => {
    const readiness = assessCloseReadiness(root, id)
    if (!readiness.ready) throw new Error(`Board close blocked: ${readiness.reason}`)
    const { topic, notes } = parseJsonl(path, { expectStatus: 'open' })
    ensureDir(archiveDir(root))
    const summary = summaryMarkdown(id, topic, notes)
    const decisions = decisionsMarkdown(id, topic, notes)
    // Recovery path: a previous close may have written the archive and died
    // before removing the active files. Adopt it only when the archived notes
    // are byte-identical, never overwrite a different archive.
    if (exists(archivedPath(root, id))) {
      const archived = parseJsonl(archivedPath(root, id), { expectStatus: 'closed' })
      const sameNotes =
        archived.notes.length === notes.length &&
        archived.notes.every((note, index) => JSON.stringify(note) === JSON.stringify(notes[index]))
      if (!sameNotes) throw new Error(`Archive collision for "${id}"; the active topic was left untouched`)
      if (!exists(join(archiveDir(root), `${id}.summary.md`))) {
        atomicWrite(join(archiveDir(root), `${id}.summary.md`), summary)
      }
      if (!exists(join(archiveDir(root), `${id}.decisions.md`))) {
        atomicWrite(join(archiveDir(root), `${id}.decisions.md`), decisions)
      }
      unlinkTopic(path)
      unlinkTopic(join(topicsDir(root), `${id}.board.md`))
      appendEvent(root, 'board_close_recovered', { topic: id, actorId: actor?.id })
      return { topic: archived.topic, summary, decisions }
    }
    for (const target of [join(archiveDir(root), `${id}.board.md`), join(archiveDir(root), `${id}.summary.md`)]) {
      if (exists(target)) throw new Error(`Archive collision for "${id}"; the active topic was left untouched`)
    }
    const closedMeta = {
      ...topic,
      status: 'closed',
      closedAt: Date.now(),
      ...(actor ? { closedBy: actor } : {}),
      integrityVersion: 1,
      finalSeq: notes.length,
    }
    const body = [`#META#${JSON.stringify(closedMeta)}`, ...notes.map((note) => JSON.stringify(note))].join('\n')
    atomicWrite(archivedPath(root, id), `${body}\n`)
    writeBoardView(root, id, { ...topic, status: 'closed' }, notes, true)
    atomicWrite(join(archiveDir(root), `${id}.summary.md`), summary)
    atomicWrite(join(archiveDir(root), `${id}.decisions.md`), decisions)
    try {
      unlinkTopic(path)
      unlinkTopic(join(topicsDir(root), `${id}.board.md`))
    } catch (error) {
      throw new Error(`Closed "${id}" but could not remove the active files: ${error.message}`)
    }
    appendEvent(root, 'board_close', { topic: id, actorId: actor?.id, notes: notes.length })
    return { topic: closedMeta, summary, decisions }
  })
}

function unlinkTopic(path) {
  if (exists(path)) unlinkSync(path)
}

/** Render one topic's notes as the reference digest text (newest plan and criticals pinned). */
export function digest(topic, notes, { sinceSeq } = {}) {
  const selected = sinceSeq === undefined ? notes : notes.filter((note) => note.seq > (sinceSeq ?? 0))
  if (selected.length === 0) return { text: '', lastSeq: notes.at(-1)?.seq ?? 0 }
  const plan = [...notes].reverse().find((note) => note.tags?.includes('plan'))
  const pinned = []
  if (plan && selected.some((note) => note.seq === plan.seq)) pinned.push(plan)
  for (const note of selected) {
    if (note.priority === 'critical' && !pinned.some((candidate) => candidate.seq === note.seq)) pinned.push(note)
  }
  const pinnedSeqs = new Set(pinned.map((note) => note.seq))
  const rest = selected.filter((note) => !pinnedSeqs.has(note.seq))
  const format = (note) => {
    const markers = []
    if (note.tags?.includes('plan')) markers.push('PLAN')
    if (note.priority === 'critical') markers.push('CRITICAL')
    const prefix = markers.length ? `[${markers.join('][')}] ` : ''
    const kind = note.kind ? `{${note.kind}${note.material ? ',material' : ''}} ` : ''
    return `${prefix}#${note.seq} ${oneLine(note.author, 80)}: ${kind}${note.content}`
  }
  const sections = []
  if (pinned.length) sections.push(pinned.map(format).join('\n'))
  if (rest.length) sections.push(rest.map(format).join('\n'))
  return { text: sections.join('\n---\n').trim(), lastSeq: selected.at(-1).seq }
}

export function readNotes(root, id, since) {
  const { notes } = readTopic(root, id)
  return since === undefined ? notes : notes.filter((note) => note.seq > since)
}
