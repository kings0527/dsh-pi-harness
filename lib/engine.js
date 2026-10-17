// Storage engine: pi-harness core (bundled to ../dist/core.js) for every write
// and every validation decision; the local modules keep only rendering.
//
// The core was built from `core/dsh.ts` with one entry point on purpose: two
// bundles would each carry their own AsyncLocalStorage instance and stop
// seeing the scope root.

import * as core from '../dist/core.js'

const withRoot = (root, operation) => core.runWithProjectRoot(root, operation)

/** Active or archived topic, whichever exists. */
function readTopicCore(id) {
  if (core.hasArchivedTopic(id)) {
    const archived = core.readArchivedTopic(id)
    return { topic: archived.topic, notes: archived.notes, archived: true, integrity: archived.integrity }
  }
  const topic = core.listOpenTopics().find((candidate) => candidate.id === id)
  if (!topic) throw new Error(`Board topic "${id}" not found`)
  return { topic, notes: core.readNotes(id), archived: false }
}

export function openTopic(root, id, goal, options = {}) {
  return withRoot(root, () => core.openTopic(id, goal, { actor: options.actor, relations: options.relations }))
}

export function postNote(root, id, options = {}) {
  const { author = 'agent', content, ...rest } = options
  return withRoot(root, () => core.postNote(id, author, content, rest))
}

export function closeTopic(root, id, { actor } = {}) {
  return withRoot(root, () => core.closeTopic(id, { actor }))
}

/**
 * Core returns `ready` for a legacy topic unconditionally: in pi the tag-based
 * rule lives in `extensions/convergence.ts`, not in core. This runtime has no
 * extension hook, so the rule is restored here.
 */
export function assessCloseReadiness(root, id) {
  return withRoot(root, () => {
    const { topic, notes } = readTopicCore(id)
    const legacy = !topic.createdBy && !notes.some((note) => note.kind !== undefined)
    if (!legacy) return core.assessCloseReadiness(id)
    const tagged = notes.some((note) => Array.isArray(note.tags) && note.tags.includes('convergence'))
    return tagged
      ? { ready: true, legacy: true, convergence: undefined }
      : { ready: false, legacy: true, reason: 'legacy topic has no note tagged "convergence"' }
  })
}

export function readTopicCore_(root, id) {
  return withRoot(root, () => readTopicCore(id))
}

// --- knowledge: writes and audit go through core; rendering stays local ------

export function addEntry(projectRoot, entryPath, content, sourceLink, description, scope) {
  withRoot(projectRoot, () => core.addEntry(entryPath, content, sourceLink, description, scope))
  // Core returns void; the tool echoes the path it wrote, not a JSON dump.
  return entryPath
}

export function markConflict(projectRoot, entryPath, newSourceLink, description, scope) {
  withRoot(projectRoot, () => core.markConflict(entryPath, newSourceLink, description, scope))
  return entryPath
}

export function auditIndex(projectRoot, scope) {
  return withRoot(projectRoot, () => core.auditIndex(scope))
}

/** True when the core bundle is present and exposes the expected surface. */
export function engineStatus() {
  const missing = ['openTopic', 'postNote', 'closeTopic', 'addEntry', 'runWithProjectRoot'].filter(
    (name) => typeof core[name] !== 'function',
  )
  return { ok: missing.length === 0, missing }
}
