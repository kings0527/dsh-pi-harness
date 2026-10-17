// The model-facing surface: three tools, all writing pi-harness formats.

import { listTopics, readTopic, NOTE_KINDS, RELATIONS } from './board.js'
import {
  addEntry,
  assessCloseReadiness,
  auditIndex,
  closeTopic,
  markConflict,
  openTopic,
  postNote,
} from './engine.js'
import {
  catalog,
  knowledgeRoot,
  parseIndex,
  readEntry,
  search,
  SCOPES,
  scopeRoots,
} from './knowledge.js'
import { listHandoffs, readHandoff, writeHandoff } from './handoff.js'
import { takeoverSummary } from './reference.js'
import { listTopicIds } from './board.js'
import { oneLine } from './util.js'

const text = (value) => ({ text: String(value) })

function renderText() {
  return [{ type: 'text', text: '' }]
}

function outputSchema(properties) {
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

function actorOf(exec) {
  const id = exec?.agent?.id
  if (!id) throw new Error('The board needs a live session actor; call it from an agent turn')
  return { id: String(id), label: 'dsh' }
}

function requireString(args, field) {
  const value = args?.[field]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${field}" is required`)
  return value
}

function formatNote(note) {
  const flags = [
    note.priority === 'critical' ? 'CRITICAL' : '',
    note.tags?.includes('plan') ? 'PLAN' : '',
    note.kind ?? '',
  ].filter(Boolean)
  const prefix = flags.length ? `[${flags.join('][')}] ` : ''
  const targets = note.targets?.length ? ` -> ${note.targets.map((ref) => `${ref.topic}#${ref.seq}`).join(', ')}` : ''
  return `${prefix}#${note.seq} ${note.author}: ${note.content}${targets}`
}

function scopeOf(value) {
  if (value === undefined || value === null || value === '') return 'project'
  if (!SCOPES.includes(value)) throw new Error(`"scope" must be one of ${SCOPES.join(', ')}`)
  return value
}

export function boardTool({ getProjectRoot }) {
  return {
    name: 'board',
    description:
      'Append-only shared Board for work that spans a session or several agents. Actions: open (create a topic with a goal), ' +
      'post (typed note: plan/claim/evidence/challenge/verification/decision/retraction/convergence), read (full notes), ' +
      'list (all topics incl. archive), close (archive with summary; requires a convergence verdict). ' +
      'Use it for plans that must survive compaction, findings another agent must read, and decisions with evidence.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'post', 'read', 'list', 'close'] },
        topic: { type: 'string', description: 'Topic id (kebab-case, one path segment).' },
        goal: { type: 'string', description: 'open: what this topic is trying to settle.' },
        content: { type: 'string', description: 'post: the note body.' },
        kind: {
          type: 'string',
          enum: NOTE_KINDS,
          description: 'post: note kind. claim/verification/challenge/retraction carry graph meaning; others are prose.',
        },
        targets: {
          type: 'array',
          description: 'post: notes this note is about (required for challenge/verification/retraction).',
          items: {
            type: 'object',
            properties: { topic: { type: 'string' }, seq: { type: 'integer', minimum: 1 } },
            required: ['topic', 'seq'],
          },
        },
        unresolved: {
          type: 'array',
          description: 'post (convergence): bounded unknowns you explicitly accept.',
          items: {
            type: 'object',
            properties: { topic: { type: 'string' }, seq: { type: 'integer', minimum: 1 } },
            required: ['topic', 'seq'],
          },
        },
        relations: {
          type: 'array',
          description: 'post: declared relation to another topic.',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: RELATIONS }, topic: { type: 'string' } },
            required: ['type', 'topic'],
          },
        },
        material: { type: 'boolean', description: 'post: mark a claim as material — it must then be verified or explicitly accepted.' },
        verdict: { type: 'string', description: 'post (convergence): the one-sentence judgement.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'post: free tags; "plan" pins the note.' },
        priority: { type: 'string', enum: ['normal', 'critical'], description: 'post: critical notes are always visible.' },
        since: { type: 'integer', description: 'read: only notes with a higher seq.' },
        limit: { type: 'integer', description: 'read: maximum notes, newest first (default 80; 0 = all).' },
        author: { type: 'string', description: 'post: author label (default "agent").' },
      },
      required: ['action'],
    },
    output: { schema: outputSchema({}), render: (_args, value) => renderer(value) },
    async execute(args, exec) {
      const root = getProjectRoot(exec)
      switch (args.action) {
        case 'open': {
          const topic = openTopic(root, requireString(args, 'topic'), requireString(args, 'goal'), {
            actor: actorOf(exec),
            relations: args.relations,
          })
          return text(`Opened "${topic.id}" — ${oneLine(topic.goal, 240)}`)
        }
        case 'post': {
          const note = postNote(root, requireString(args, 'topic'), {
            author: args.author || 'agent',
            content: requireString(args, 'content'),
            kind: args.kind,
            targets: args.targets,
            unresolved: args.unresolved,
            relations: args.relations,
            material: args.material,
            verdict: args.verdict,
            tags: args.tags,
            priority: args.priority === 'critical' ? 'critical' : undefined,
            actor: actorOf(exec),
          })
          return text(`Posted #${note.seq} to "${args.topic}".`)
        }
        case 'read': {
          const { topic, notes, archived } = readTopic(root, requireString(args, 'topic'))
          const selected = args.since ? notes.filter((note) => note.seq > args.since) : notes
          const head = `${topic.id} (${topic.status}${archived ? ', archived' : ''}) — ${oneLine(topic.goal, 240)}\n`
          if (!selected.length) return text(`${head}\nNo notes${args.since ? ` after #${args.since}` : ''}.`)
          // A long-lived topic can be hundreds of notes; returning all of them
          // turns one read into a spilled tool result the model cannot see.
          // Default to the newest page and always say how to get the rest.
          const limit = Number.isInteger(args.limit) ? args.limit : 80
          const shown = limit > 0 && selected.length > limit ? selected.slice(-limit) : selected
          const omitted = selected.length - shown.length
          const notice = omitted
            ? `[${omitted} earlier notes withheld (#${selected[0].seq}–#${shown[0].seq - 1}); call again with since=${
                shown[0].seq - 1
              } or limit=0 to read them]\n`
            : ''
          return text(`${head}\n${notice}${shown.map(formatNote).join('\n')}`)
        }
        case 'list': {
          const rows = listTopics(root)
          if (!rows.length) return text('No Board topics yet. Open one with action=open.')
          return text(
            rows
              .map(
                (row) =>
                  `- ${row.id} [${row.status}] (${row.noteCount} notes; through #${row.lastSeq}) — ${oneLine(row.goal, 200)}`,
              )
              .join('\n'),
          )
        }
        case 'close': {
          const id = requireString(args, 'topic')
          const readiness = assessCloseReadiness(root, id)
          if (!readiness.ready) {
            return text(
              `Close blocked: ${readiness.reason}. Post a convergence note with a verdict (and verify or explicitly accept material claims) first.`,
            )
          }
          const result = closeTopic(root, id, { actor: actorOf(exec) })
          return text(
            `Closed "${id}". Wrote .pi-board/topics/archive/${id}.{jsonl,summary.md,decisions.md}.\n` +
              `Next: distill the durable conclusions into knowledge (knowledge action=add with a source).`,
          )
        }
        default:
          throw new Error(`Unknown board action "${args.action}"`)
      }
    },
  }
}

export function knowledgeTool({ getProjectRoot }) {
  return {
    name: 'knowledge',
    description:
      'Tiered long-term knowledge that outlives the session: project (<cwd>/knowledge), workspace (git root), global (~/.pi-harness). ' +
      'Actions: catalog (what this directory already knows), search, read, list (index rows), add (new sourced entry), ' +
      'conflict (append contradicting evidence without overwriting), audit (dead index rows). ' +
      'Read the catalog before re-deriving something, and distill after a Board topic closes.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['catalog', 'search', 'read', 'list', 'add', 'conflict', 'audit'] },
        scope: { type: 'string', enum: SCOPES, description: 'project (default), workspace, or global.' },
        path: { type: 'string', description: 'read/add/conflict: entry path relative to the knowledge root.' },
        content: { type: 'string', description: 'add/conflict: the entry body, or the contradicting evidence.' },
        source: { type: 'string', description: 'add/conflict: provenance (topic-id#seq, URL, command, artifact path). Required.' },
        description: { type: 'string', description: 'add: one-line index row description.' },
        query: { type: 'string', description: 'search: substring to look for.' },
        offset: { type: 'integer', description: 'read: 0-based line offset (default 0).' },
        limit: { type: 'integer', description: 'search: max matches (default 40); read: max lines (default 400; 0 = all).' },
      },
      required: ['action'],
    },
    output: { schema: outputSchema({}), render: (_args, value) => renderer(value) },
    async execute(args, exec) {
      const projectRoot = getProjectRoot(exec)
      const scope = scopeOf(args.scope)
      switch (args.action) {
        case 'catalog': {
          const lines = [`project root: ${projectRoot}`]
          for (const { root, scopes } of scopeRoots(projectRoot)) {
            lines.push(`\n## ${scopes.join(' + ')}: ${root}`)
            lines.push(catalog(root) || '(empty)')
          }
          return text(lines.join('\n'))
        }
        case 'list': {
          const root = knowledgeRoot(projectRoot, scope)
          const rows = parseIndex(root)
          if (!rows.length) return text(`No index rows at ${root}/index.md${scope === 'project' ? '' : ` (scope=${scope})`}.`)
          return text(rows.map((row) => `[${row.status}] ${row.path} | ${row.description}`).join('\n'))
        }
        case 'read': {
          const entry = readEntry(knowledgeRoot(projectRoot, scope), requireString(args, 'path'))
          const limit = Number.isInteger(args.limit) ? args.limit : 400
          const lines = entry.split('\n')
          if (limit <= 0 || lines.length <= limit) return text(entry)
          const offset = Number.isInteger(args.offset) && args.offset > 0 ? Math.min(args.offset, lines.length) : 0
          const slice = lines.slice(offset, offset + limit)
          return text(
            `[${Buffer.byteLength(entry, 'utf-8')} bytes, ${lines.length} lines; showing lines ${offset + 1}-${
              offset + slice.length
            }. Use offset=${offset + slice.length} to continue, or limit=0 for the whole file.]\n${slice.join('\n')}`,
          )
        }
        case 'search': {
          const hits = search(knowledgeRoot(projectRoot, scope), requireString(args, 'query'), { limit: args.limit ?? 40 })
          return text(hits.length ? hits.join('\n') : `No match for "${args.query}" in ${scope} knowledge.`)
        }
        case 'add': {
          // Pass the PROJECT root, not the knowledge root: the core resolves
          // `knowledge/` from the scope itself, so handing it the knowledge
          // root would nest one level deeper (knowledge/knowledge/...).
          const written = addEntry(
            projectRoot,
            requireString(args, 'path'),
            requireString(args, 'content'),
            requireString(args, 'source'),
            requireString(args, 'description'),
            scope,
          )
          return text(`Distilled into ${written} (scope=${scope}). Index row updated.`)
        }
        case 'conflict': {
          const written = markConflict(
            projectRoot,
            requireString(args, 'path'),
            requireString(args, 'source'),
            requireString(args, 'content'),
            scope,
          )
          return text(`Appended a CONFLICT block to ${written}; the original entry is preserved.`)
        }
        case 'audit': {
          const root = knowledgeRoot(projectRoot, scope)
          const issues = auditIndex(projectRoot, scope)
          return text(
            issues.length
              ? issues.map((issue) => `${issue.path}: ${issue.reason}`).join('\n')
              : `Index at ${root}/index.md has no dead rows.`,
          )
        }
        default:
          throw new Error(`Unknown knowledge action "${args.action}"`)
      }
    },
  }
}

export function handoffTool({ getProjectRoot }) {
  return {
    name: 'handoff',
    description:
      'Session handoff for "open this directory and continue". Actions: status (what this directory already carries — board, knowledge, handoff), ' +
      'list, read (latest or named), write (create handoff/<date>-<slug>.md with goal/done/next/evidence). ' +
      'Write one before ending a session whose next step is not obvious from the code.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list', 'read', 'write'] },
        name: { type: 'string', description: 'read: exact handoff file name.' },
        title: { type: 'string', description: 'write: handoff title.' },
        slug: { type: 'string', description: 'write: file slug (defaults to the title).' },
        content: { type: 'string', description: 'write: full markdown body; omit for a structured template.' },
      },
      required: ['action'],
    },
    output: { schema: outputSchema({}), render: (_args, value) => renderer(value) },
    async execute(args, exec) {
      const root = getProjectRoot(exec)
      switch (args.action) {
        case 'status': {
          const summary = takeoverSummary(root)
          const { open = 0, archived = 0 } = summary.board
          const knowledge = summary.knowledge.length
            ? summary.knowledge.map((entry) => `  - ${entry.scopes.join('+')}: ${entry.root}`).join('\n')
            : '  - none yet'
          return text(
            [
              `project: ${summary.projectRoot}`,
              `board: ${open} open / ${archived} archived — ${summary.board.root}`,
              `knowledge:\n${knowledge}`,
              `handoff: ${summary.handoff ? summary.handoff.split('\n')[0] : 'none'}`,
            ].join('\n'),
          )
        }
        case 'list': {
          const rows = listHandoffs(root)
          if (!rows.length) return text('No handoffs in this directory yet.')
          return text(
            rows
              .map((row) => `- ${row.name} (${new Date(row.mtime).toISOString()})`)
              .join('\n'),
          )
        }
        case 'read': {
          const entry = readHandoff(root, args.name)
          return text(entry.content)
        }
        case 'write': {
          const result = writeHandoff(root, {
            title: args.title,
            content: args.content,
            slug: args.slug,
            agent: 'deepseek-harness',
          })
          return text(`Wrote ${result.name} (${result.bytes} bytes) under handoff/.`)
        }
        default:
          throw new Error(`Unknown handoff action "${args.action}"`)
      }
    },
  }
}

export { listTopicIds }
