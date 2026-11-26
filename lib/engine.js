// Storage engine: pi-harness core (bundled to ../dist/core.js) for every write
// and every validation decision; the local modules keep only rendering.
//
// The core was built from `core/dsh.ts` with one entry point on purpose: two
// bundles would each carry their own AsyncLocalStorage instance and stop
// seeing the scope root.

import * as core from '../dist/core.js'
import { homeFor } from './util.js'

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

export function hasArchivedTopic(root, id) {
  return withRoot(root, () => core.hasArchivedTopic(id))
}

export function listOpenTopics(root) {
  return withRoot(root, () => core.listOpenTopics())
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

// --- Live Sideline Field & Flux (shared byte-for-byte with pi-harness) -------

export const PULSE_KINDS = core.PULSE_KINDS
export const COGNITIVE_LENSES = core.COGNITIVE_LENSES
export const FLUX_DISCIPLINE = core.FLUX_DISCIPLINE
export const emptySidelineCursor = core.emptySidelineCursor
export const extractToolTrace = core.extractToolTrace
export const resolveLens = core.resolveLens
export const pickStartingLenses = core.pickStartingLenses
export const resolveFluxModels = core.resolveFluxModels
export const isFluxDisabled = core.isFluxDisabled
export const isGitRepository = core.isGitRepository
export const inspectWorktreeChanges = core.inspectWorktreeChanges
export const removeTentacleWorktree = core.removeTentacleWorktree

export function openField(root, fieldId, goal, options = {}) {
  return withRoot(root, () => core.openField(fieldId, goal, { rootCwd: root, ...options }))
}

export function getFieldMeta(root, fieldId) {
  return withRoot(root, () => core.getFieldMeta(fieldId))
}

export function listFields(root) {
  return withRoot(root, () => core.listFields())
}

export function closeField(root, fieldId, options = {}) {
  return withRoot(root, () => core.closeField(fieldId, options))
}

export function artifactsDir(root, fieldId) {
  return withRoot(root, () => core.artifactsDir(fieldId))
}

export function listArtifacts(root, fieldId) {
  return withRoot(root, () => core.listArtifacts(fieldId))
}

export function updatePresence(root, fieldId, update) {
  return withRoot(root, () => core.updatePresence(fieldId, update))
}

export function listPresences(root, fieldId, options = {}) {
  return withRoot(root, () => core.listPresences(fieldId, options))
}

export function markPresenceDone(root, fieldId, actorId, status = 'done') {
  return withRoot(root, () => core.markPresenceDone(fieldId, actorId, status))
}

export function claimResource(root, fieldId, resource, holder) {
  return withRoot(root, () => core.claimResource(fieldId, resource, holder))
}

export function releaseResource(root, fieldId, resource, actorId) {
  return withRoot(root, () => core.releaseResource(fieldId, resource, actorId))
}

export function releaseAllResources(root, fieldId, actorId) {
  return withRoot(root, () => core.releaseAllResources(fieldId, actorId))
}

export function listResources(root, fieldId) {
  return withRoot(root, () => core.listResources(fieldId))
}

export function postPulse(root, fieldId, input) {
  return withRoot(root, () => core.postPulse(fieldId, input))
}

export function readPulses(root, fieldId, sinceSeq) {
  return withRoot(root, () => core.readPulses(fieldId, sinceSeq))
}

export function buildSidelineDelta(root, fieldId, selfActorId, cursor, options = {}) {
  return withRoot(root, () => core.buildSidelineDelta(fieldId, selfActorId, cursor, options))
}

export function buildFieldSnapshot(root, fieldId, options = {}) {
  return withRoot(root, () => core.buildFieldSnapshot(fieldId, options))
}

export function buildCollectiveBoardSummary(root, fieldId, outcomes) {
  return withRoot(root, () => core.buildCollectiveBoardSummary(fieldId, outcomes))
}

export function createTentacleWorktree(root, fieldId, label) {
  return withRoot(root, () => core.createTentacleWorktree(root, fieldId, label))
}

export function getFluxConfig(root) {
  return withRoot(root, () => core.getFluxConfig({ globalHome: homeFor(root) }))
}

export function setFluxConfig(root, config, scope = 'global') {
  return withRoot(root, () => core.setFluxConfig(config, scope, { globalHome: homeFor(root) }))
}

export function clearProjectFluxConfig(root) {
  return withRoot(root, () => core.clearProjectFluxConfig())
}

export function hasProjectFluxConfig(root) {
  return withRoot(root, () => core.hasProjectFluxConfig())
}

export function getGlobalFluxPath(root) {
  return core.getGlobalFluxPath({ globalHome: homeFor(root) })
}

export function getProjectFluxPath(root) {
  return withRoot(root, () => core.getProjectFluxPath())
}

/** True when the core bundle is present and exposes the expected surface. */
export function engineStatus() {
  const missing = [
    'openTopic',
    'postNote',
    'closeTopic',
    'addEntry',
    'runWithProjectRoot',
    'openField',
    'postPulse',
    'buildSidelineDelta',
    'getFluxConfig',
  ].filter((name) => typeof core[name] !== 'function')
  return { ok: missing.length === 0, missing }
}
