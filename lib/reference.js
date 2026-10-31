// Index-first, budgeted references. Full Board notes and knowledge entries are read on demand.
import { join } from 'node:path'
import { activeNotes, digest, latestPlan, listTopicIds, readTopic } from './board.js'
import { handoffPointer } from './handoff.js'
import { knowledgeIndexEntries, knowledgeScopeRoots, scopeRoots } from './knowledge.js'
import { estimateTokens, exists, mtimeOf, sha256 } from './util.js'

export const POLICY =
  'This is a compact index, not the source material. Read the referenced Board note or knowledge file before relying on details. ' +
  'Entries omitted for budget are available through the paged tools; omission does not mean absence.'

export const DEFAULT_REFERENCE_BUDGET_TOKENS = 4096
export const MIN_REFERENCE_BUDGET_TOKENS = 2048

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const record = () => Object.create(null)
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const stateKey = (entry) => entry.scope + '\0' + entry.path
const quoted = (value) => JSON.stringify(String(value))

export function knowledgeBytes(projectRoot, { activeScopes = [] } = {}) {
  const entries = knowledgeIndexEntries(projectRoot, { activeScopes })
  const content = entries.map((entry) => [entry.scope, entry.path, entry.sourcePath, entry.status, entry.description, entry.revision].join('\t')).join('\n')
  let latest = 0
  for (const { root } of scopeRoots(projectRoot)) {
    latest = Math.max(latest, mtimeOf(join(root, 'index.md')), mtimeOf(join(root, 'KNOWLEDGE.md')), mtimeOf(root))
  }
  for (const root of new Set([...knowledgeScopeRoots(projectRoot), ...activeScopes])) {
    latest = Math.max(latest, mtimeOf(join(root, 'KNOWLEDGE.md')))
  }
  return { content, entries, signature: sha256(content), latest }
}
export function activeGoalSignature(goal) {
  return goal?.phase === 'active' ? sha256(JSON.stringify([goal.id, goal.revision, goal.objective])) : ''
}

function topicIndexEntry(projectRoot, id, status, known = null) {
  try {
    const { topic, notes, cursor = 0 } = known ?? readTopic(projectRoot, id)
    const last = notes.at(-1)
    if (status === 'closed') {
      return {
        id,
        text: 'Archived Board topic ' + id + ' has ' + notes.length + ' notes through #' + (last?.seq ?? 0) +
        '; read it with board read topic=' + quoted(id) + '.',
        fallback: 'Archived Board topic ' + id + ' is not expanded; read it with board read topic=' + quoted(id) + '.',
      }
    }
    const plan = latestPlan(notes, id)
    const live = activeNotes(notes, id)
    const convergence = [...live].reverse().find((note) => note.kind === 'convergence' && note.actor)
    const state = convergence ? 'has a convergence note at #' + convergence.seq : 'has no convergence note yet'
    return {
      id,
      // A sequence-only plan pointer cannot restore the task after compaction.
      // Keep the active objective and plan intact; budget only secondary indexes.
      text: 'Board topic ' + id + ' is open for ' + flat(topic.goal) + '; it has ' + notes.length + ' notes through #' +
        (last?.seq ?? 0) + ', latest plan ' + (plan ? '#' + plan.seq : 'none') + ', and ' + state +
        '; read details with board read topic=' + quoted(id) + '.' +
        '\nActive plan and fresh notes:\n' + digest(topic, notes, { sinceSeq: cursor }).text,
      fallback: 'Board topic ' + id + ' is open; its goal and details are not expanded here; read it with board read topic=' + quoted(id) + '.',
      pinned: Boolean(plan),
    }
  } catch (error) {
    return {
      id,
      text: 'Board topic ' + id + ' is unreadable (' + flat(error?.message ?? error) + '); inspect it with board read topic=' + quoted(id) + '.',
      fallback: 'Board topic ' + id + ' is unreadable; inspect it with board read topic=' + quoted(id) + '.',
    }
  }
}

function topicStates(projectRoot, previous) {
  const ids = listTopicIds(projectRoot)
  const active = ids.active.sort((a, b) => a.localeCompare(b)).map((id) => {
    try {
      const { topic, notes } = readTopic(projectRoot, id)
      const same = Object.hasOwn(previous?.incarnations ?? {}, id) && previous.incarnations[id] === topic.createdAt
      const cursor = same ? previous.board?.[id] ?? 0 : 0
      return {
        id, topic, notes, cursor,
        fresh: !same || cursor !== (notes.at(-1)?.seq ?? 0),
        index: topicIndexEntry(projectRoot, id, 'open', { topic, notes, cursor }),
      }
    } catch (error) {
      return { id, error: String(error?.message ?? error), fresh: true, index: topicIndexEntry(projectRoot, id, 'open') }
    }
  })
  const archived = ids.archived.sort((a, b) => a.localeCompare(b)).map((id) => {
    try {
      const { topic, notes } = readTopic(projectRoot, id)
      return {
        id, topic, notes,
        fresh: !Object.hasOwn(previous?.archived ?? {}, id) || previous.archived[id] !== topic.createdAt,
        index: topicIndexEntry(projectRoot, id, 'closed', { topic, notes }),
      }
    } catch (error) {
      return { id, error: String(error?.message ?? error), fresh: true, index: topicIndexEntry(projectRoot, id, 'closed') }
    }
  })
  return { active, archived }
}

function knowledgeCandidate(entry, updated = false) {
  if (entry.kind === 'status') {
    const text = 'Knowledge ' + entry.scope + '/' + entry.path + ': ' + entry.description
    return { text, fallback: text, scope: entry.scope.split('+')[0], path: entry.path, sourcePath: entry.sourcePath }
  }
  const scope = entry.scope.split('+')[0]
  const read = 'knowledge read path=' + quoted(entry.sourcePath) + ' scope=' + quoted(scope)
  const changed = updated ? ' This index or source changed; reread it before relying on it.' : ''
  return {
    text: 'Knowledge ' + entry.scope + '/' + entry.path + ': ' + entry.description +
      ' [' + entry.status + ']; read the source with ' + read + '.' + changed,
    fallback: 'Knowledge ' + entry.scope + '/' + entry.path + ' is indexed but its description is deferred; read it with ' + read + '.' + changed,
    scope,
    path: entry.path,
    sourcePath: entry.sourcePath,
  }
}

function knowledgeGroupKey(scope) {
  if (scope.includes('global')) return 'knowledge-global'
  if (scope.includes('project')) return 'knowledge-project'
  return 'knowledge-workspace'
}

function makeGroups({ coreItems, boardItems, archivedItems, knowledgeItems, onlyBoard }) {
  const groups = []
  const add = (key, title, items, continuation, weight) => {
    groups.push({ key, title, items, selected: [], continuation, weight, deferred: 0 })
  }
  if (!onlyBoard) add('context', 'Current goal and handoff', coreItems, '', 0.16)
  add('board', 'Open Board index', boardItems, 'board list status=open offset=', 0.43)
  if (!onlyBoard) add('archive', 'Archived Board index', archivedItems, 'board list status=closed offset=', 0.06)
  const byScope = new Map()
  for (const candidate of knowledgeItems) {
    const key = knowledgeGroupKey(candidate.scope)
    if (!byScope.has(key)) byScope.set(key, [])
    byScope.get(key).push(candidate)
  }
  const scopeGroups = onlyBoard ? [] : [
    ['knowledge-project', 'Project knowledge index'],
    ['knowledge-workspace', 'Workspace knowledge index'],
    ['knowledge-global', 'Global knowledge index'],
  ].filter(([key]) => byScope.has(key))
  const kbWeight = 0.35 / Math.max(1, scopeGroups.length)
  for (const [key, title] of scopeGroups) {
    const scope = key.slice('knowledge-'.length)
    add(key, title, byScope.get(key), 'knowledge list scope=' + scope + ' offset=', kbWeight)
  }
  return groups
}

function renderReference(kind, body) {
  const digest = sha256(body)
  const text = [
    '<pi_harness_' + kind + ' source_digest="' + digest + '">',
    '<policy>' + POLICY + '</policy>',
    '<data encoding="xml-escaped">',
    escapeXml(body),
    '</data>',
    '</pi_harness_' + kind + '>',
  ].join('\n')
  return { text, digest }
}

function referenceBody({ groups, goalLine, handoffLine, budgetTokens, full }) {
  const parts = []
  if (goalLine) parts.push('Current context: ' + goalLine)
  if (handoffLine) parts.push('Resume pointer: ' + handoffLine)
  for (const group of groups) {
    const total = group.items.length
    const shown = group.selected.length
    if (shown === 0 && total > 0) {
      const command = full
        ? group.continuation + '0'
        : group.continuation + '0, then continue through its pages'
      parts.push(group.title + ': ' + total + ' row(s) not shown; continue with ' + command + '.')
      continue
    }
    parts.push(group.title + ' (' + shown + ' of ' + total + ' rows shown):')
    if (shown) parts.push(group.selected.map((item) => '- ' + item.text).join('\n'))
    else if (total === 0) parts.push('- none')
    if (group.deferred) {
      parts.push('- ' + group.deferred + ' long row(s) are represented by source pointers, not clipped text.')
    }
    if (shown < total) {
      if (full) parts.push('- ' + (total - shown) + ' whole row(s) remain; continue with ' + group.continuation + shown + '.')
      else parts.push('- ' + (total - shown) + ' update row(s) remain; inspect the complete current index with ' + group.continuation + '0, then continue through its pages.')
    }
  }
  parts.push('Reference budget: ' + budgetTokens + ' conservative token-estimate units (UTF-8 byte proxy) for this index message; rows are whole and source material stays on disk.')
  return parts.join('\n\n')
}

function selectWithinBudget(groups, { goalLine, handoffLine, budgetTokens, full }) {
  const base = estimateTokens(referenceBody({ groups, goalLine, handoffLine, budgetTokens, full }))
  let available = Math.max(0, budgetTokens - base)
  const weightsTotal = groups.reduce((sum, group) => sum + group.weight, 0) || 1
  const budgets = new Map(groups.map((group) => [group.key, Math.floor(available * group.weight / weightsTotal)]))

  for (const group of groups) {
    // Core task state is not a budgetable index row: it must survive a compacted
    // original user message. Secondary indexes may still be paged or deferred.
    group.selected.push(...group.items.filter((item) => item.pinned))
    let cap = budgets.get(group.key) ?? 0
    for (const item of group.items) {
      if (item.pinned) continue
      const fullCost = estimateTokens(escapeXml(item.text))
      const fallbackCost = estimateTokens(escapeXml(item.fallback))
      if (fullCost <= cap) {
        group.selected.push(item)
        cap -= fullCost
        available -= fullCost
      } else if (fallbackCost <= cap) {
        group.selected.push({ ...item, text: item.fallback, fallbackUsed: true })
        group.deferred += 1
        cap -= fallbackCost
        available -= fallbackCost
      } else {
        break
      }
    }
  }

  // Share unused allocations without changing row order within any index.
  let progressed = true
  while (available > 0 && progressed) {
    progressed = false
    for (const group of groups) {
      const item = group.items.find((candidate) => !group.selected.some((selected) => selected.id === candidate.id))
      if (!item) continue
      const fullCost = estimateTokens(escapeXml(item.text))
      const fallbackCost = estimateTokens(escapeXml(item.fallback))
      if (fullCost <= available) {
        group.selected.push(item)
        available -= fullCost
        progressed = true
      } else if (fallbackCost <= available) {
        group.selected.push({ ...item, text: item.fallback, fallbackUsed: true })
        group.deferred += 1
        available -= fallbackCost
        progressed = true
      }
    }
  }

  const priorities = [...groups].reverse()
  let body = referenceBody({ groups, goalLine, handoffLine, budgetTokens, full })
  let result = renderReference(full ? 'reference' : 'delta', body)
  while (estimateTokens(result.text) > budgetTokens) {
    const group = priorities.find((candidate) => candidate.selected.some((item) => !item.pinned))
    if (!group) break
    const index = group.selected.findLastIndex((item) => !item.pinned)
    const [removed] = group.selected.splice(index, 1)
    if (removed.fallbackUsed) group.deferred -= 1
    body = referenceBody({ groups, goalLine, handoffLine, budgetTokens, full })
    result = renderReference(full ? 'reference' : 'delta', body)
  }
  return { ...result, body, estimatedTokens: estimateTokens(result.text) }
}

function assemble(projectRoot, { previous = null, full = true, goal, activeScopes = [], onlyBoard = false, budgetTokens = DEFAULT_REFERENCE_BUDGET_TOKENS } = {}) {
  const budget = Number.isFinite(budgetTokens)
    ? Math.max(MIN_REFERENCE_BUDGET_TOKENS, Math.floor(budgetTokens))
    : DEFAULT_REFERENCE_BUDGET_TOKENS
  const topics = topicStates(projectRoot, full ? null : previous)
  const kb = onlyBoard ? { entries: [], signature: '', latest: 0 } : knowledgeBytes(projectRoot, { activeScopes })
  const goalSignature = activeGoalSignature(goal)
  const pointer = onlyBoard ? '' : handoffPointer(projectRoot, { knowledgeMtime: kb.latest })
  const handoffSignature = sha256(pointer)
  const goalChanged = goalSignature !== (previous?.goal ?? '')
  const currentBoard = record()
  const incarnations = record()
  const archived = full ? record() : Object.assign(record(), previous?.archived)
  for (const entry of topics.active) {
    if (!entry.error && previous?.incarnations?.[entry.id] === entry.topic.createdAt && Object.hasOwn(previous.board ?? {}, entry.id)) {
      currentBoard[entry.id] = previous.board[entry.id]
      incarnations[entry.id] = entry.topic.createdAt
    }
  }

  const activeIds = new Set(topics.active.map((entry) => entry.id))
  const removed = Object.keys(previous?.board ?? {}).filter((id) => !activeIds.has(id))
  const kbChanged = !onlyBoard && (full || kb.signature !== previous?.knowledge)
  const changedKnowledge = full || !previous?.knowledgeRows
    ? kb.entries
    : kb.entries.filter((entry) => {
      const prior = previous.knowledgeRows.find((row) => stateKey(row) === stateKey(entry))
      return !prior || prior.status !== entry.status || prior.sourcePath !== entry.sourcePath ||
        prior.description !== entry.description || prior.revision !== entry.revision
    })
  const removedKnowledge = !full && previous?.knowledgeRows
    ? previous.knowledgeRows.filter((row) => !kb.entries.some((entry) => stateKey(entry) === stateKey(row)))
    : []

  const freshBoard = topics.active.filter((entry) => full || entry.fresh).map((entry) => entry.index)
  const freshArchive = onlyBoard ? [] : topics.archived.filter((entry) => full || entry.fresh).map((entry) => entry.index)
  const changedBoard = full ? freshBoard : [
    ...freshBoard,
    ...removed.map((id) => ({
      text: 'Board topic ' + id + ' is no longer open; inspect its archive with board read topic=' + quoted(id) + '.',
      fallback: 'Board topic ' + id + ' moved to the archive; inspect it with board read topic=' + quoted(id) + '.',
    })),
  ]
  const knowledgeRows = changedKnowledge.map((entry) => {
    const prior = previous?.knowledgeRows?.find((row) => stateKey(row) === stateKey(entry))
    return knowledgeCandidate(entry, Boolean(prior))
  })
  for (const row of removedKnowledge) {
    const scope = row.scope.split('+')[0]
    knowledgeRows.push({
      text: 'Knowledge index entry ' + row.scope + '/' + row.path + ' was removed; check the current index with knowledge list scope=' + scope + '.',
      fallback: 'A knowledge index entry was removed; check knowledge list scope=' + scope + '.',
      scope: row.scope,
      path: row.path,
      sourcePath: row.sourcePath,
    })
  }

  if (!full && !topics.active.some((entry) => entry.fresh) && !removed.length &&
      !topics.archived.some((entry) => entry.fresh) && !kbChanged && !goalChanged && handoffSignature === previous?.handoff) return null

  const coreItems = []
  if (!onlyBoard && goal?.phase === 'active') {
    coreItems.push({
      text: 'Active DSH goal:\n' + goal.objective,
      fallback: 'An active DSH goal exists in the session; consult the original task message.',
      pinned: true,
    })
  } else if (!onlyBoard && goalChanged) {
    coreItems.push({
      text: 'There is no active DSH goal; previous goal anchors are historical.',
      fallback: 'The active DSH goal changed; consult the current session goal.',
    })
  }
  if (!onlyBoard && pointer) {
    coreItems.push({
      text: pointer,
      fallback: 'A handoff file is available; read it with the handoff tool before continuing.',
      pinned: true,
    })
  }
  const groups = makeGroups({
    coreItems,
    boardItems: changedBoard,
    archivedItems: freshArchive,
    knowledgeItems: onlyBoard || !kbChanged ? [] : knowledgeRows,
    onlyBoard,
  })
  const selected = selectWithinBudget(groups, { goalLine: '', handoffLine: '', budgetTokens: budget, full })

  // Scanning a topic is not delivery. Only a complete rendered index row can
  // advance its cursor; omitted and fallback rows stay fresh for the next delta.
  const deliveredBoard = new Set(groups.find((group) => group.key === 'board').selected.filter((item) => !item.fallbackUsed).map((item) => item.id))
  for (const entry of topics.active) {
    if (!entry.error && deliveredBoard.has(entry.id)) {
      currentBoard[entry.id] = entry.notes.at(-1)?.seq ?? 0
      incarnations[entry.id] = entry.topic.createdAt
    }
  }
  const deliveredArchives = new Set(groups.find((group) => group.key === 'archive')?.selected.filter((item) => !item.fallbackUsed).map((item) => item.id) ?? [])
  for (const entry of topics.archived) {
    if (!entry.error && deliveredArchives.has(entry.id)) archived[entry.id] = entry.topic.createdAt
  }

  return {
    ...selected,
    board: currentBoard,
    incarnations,
    archived,
    knowledge: kb.signature,
    knowledgeRows: kb.entries,
    goal: goalSignature,
    handoff: handoffSignature,
    estimatedTokens: selected.estimatedTokens,
    budgetTokens: budget,
    omitted: groups.map((group) => ({ key: group.key, total: group.items.length, shown: group.selected.length })),
  }
}

export function buildReference(projectRoot, options = {}) {
  return assemble(projectRoot, options)
}

export function buildDelta(projectRoot, previous, options = {}) {
  return assemble(projectRoot, { ...options, previous, full: false })
}

export function boardSnapshot(projectRoot, options = {}) {
  const built = assemble(projectRoot, { ...options, onlyBoard: true })
  return { content: built.body, seqs: built.board, incarnations: built.incarnations }
}

export function takeoverSummary(projectRoot) {
  const { active, archived } = listTopicIds(projectRoot)
  return {
    projectRoot,
    board: { open: active.length, archived: archived.length, root: join(projectRoot, '.pi-board') },
    knowledge: scopeRoots(projectRoot).filter(({ root }) => exists(root)).map(({ root, scopes }) => ({ scopes, root })),
    handoff: handoffPointer(projectRoot, { includeNext: false }) || null,
  }
}
