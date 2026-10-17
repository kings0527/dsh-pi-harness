// Tiered long-term knowledge, byte-compatible with pi-harness.
//
//   <project>/knowledge/          scope=project   (default)
//   <git-root>/knowledge/         scope=workspace
//   ~/.pi-harness/knowledge/      scope=global
//
// Canonical entry format:
//   <content>
//
//   ---
//
//   来源: <source>
//
// index.md holds `path | description` rows; `[SUPERSEDED] path | ...` marks a
// retired row. Real projects also use free-form indexes, so the catalog falls
// back to a bounded read of index.md instead of pretending it is empty.

import { dirname, join, resolve } from 'node:path'
import {
  ensureDir,
  exists,
  homeFor,
  isInside,
  listFiles,
  mtimeOf,
  nearestGitRoot,
  oneLine,
  readText,
  truncateBytes,
  atomicWrite,
} from './util.js'

export const SCOPES = ['project', 'workspace', 'global']
const RETIRED = /^\[(SUPERSEDED|ARCHIVED|DEPRECATED)\]\s*/i
const STATUS_BY_TAG = { SUPERSEDED: 'superseded', ARCHIVED: 'archived', DEPRECATED: 'deprecated' }

export function workspaceRoot(projectRoot) {
  return nearestGitRoot(projectRoot)
}

export function knowledgeRoot(projectRoot, scope = 'project') {
  if (scope === 'global') return join(homeFor(projectRoot), '.pi-harness', 'knowledge')
  if (scope === 'workspace') return join(workspaceRoot(projectRoot), 'knowledge')
  return join(projectRoot, 'knowledge')
}

export function indexPath(projectRoot, scope = 'project') {
  return join(knowledgeRoot(projectRoot, scope), 'index.md')
}

/** Distinct storage roots for the three scopes, deduplicated and scope-labelled. */
export function scopeRoots(projectRoot) {
  const roots = []
  for (const scope of SCOPES) {
    const root = knowledgeRoot(projectRoot, scope)
    const existing = roots.find((entry) => entry.root === resolve(root))
    if (existing) existing.scopes.push(scope)
    else roots.push({ root: resolve(root), scopes: [scope] })
  }
  return roots
}

export function parseIndex(root) {
  const path = join(root, 'index.md')
  const raw = readText(path)
  if (raw === null) return []
  const entries = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--') || trimmed.startsWith('|')) continue
    const tag = RETIRED.exec(trimmed)
    const status = tag ? STATUS_BY_TAG[tag[1].toUpperCase()] : 'active'
    const row = tag ? trimmed.slice(tag[0].length) : trimmed
    const pipe = row.indexOf('|')
    if (pipe === -1) continue
    const entryPath = row.slice(0, pipe).trim().replace(/^`|`$/g, '')
    const description = row.slice(pipe + 1).trim()
    if (entryPath && description) entries.push({ path: entryPath, description, status })
  }
  return entries
}

export function auditIndex(root) {
  const issues = []
  for (const entry of parseIndex(root)) {
    const full = safeJoin(root, entry.path)
    if (full === null) issues.push({ path: entry.path, reason: 'invalid' })
    else if (!exists(full)) issues.push({ path: entry.path, reason: 'missing' })
  }
  return issues
}

function safeJoin(root, entryPath, { allowIndex = false } = {}) {
  if (!entryPath || entryPath.includes('\0') || /[\r\n|]/.test(entryPath)) return null
  if (/^[A-Za-z]:|^\//.test(entryPath)) return null
  const full = resolve(root, entryPath)
  if (!isInside(root, full)) return null
  // index.md is writable only through updateIndex; reading it is legitimate and
  // is how a caller inspects a hand-written catalog.
  if (!allowIndex && resolve(full) === resolve(root, 'index.md')) return null
  return full
}

export function readEntry(root, entryPath) {
  const full = safeJoin(root, entryPath, { allowIndex: true })
  if (full === null) throw new Error(`Knowledge path escapes the selected root: "${entryPath}"`)
  const text = readText(full)
  if (text === null) throw new Error(`Knowledge entry not found: ${entryPath}`)
  return text
}

/** `## Always` / `## Areas` in a root KNOWLEDGE.md, per pi-harness ADR-0017. */
export function rootSections(dir) {
  const text = readText(join(dir, 'KNOWLEDGE.md'))
  if (!text) return { always: '', areas: '', rest: '' }
  let always = ''
  let areas = ''
  const rest = []
  let current = 'rest'
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      const title = heading[1].trim().toLowerCase()
      current = title === 'always' ? 'always' : title === 'areas' ? 'areas' : 'rest'
      continue
    }
    if (current === 'always') always += `${always ? '\n' : ''}${line}`
    else if (current === 'areas') areas += `${areas ? '\n' : ''}${line}`
    else rest.push(line)
  }
  return { always: always.trim(), areas: areas.trim(), rest: rest.join('\n').trim() }
}

export function fileTree(root, maxDepth = 2, limit = 80) {
  const rows = []
  const walk = (dir, depth, prefix) => {
    if (rows.length >= limit || depth > maxDepth) return
    for (const file of listFiles(dir).sort()) {
      if (rows.length >= limit) return
      const name = file.split(/[\\/]/).pop()
      if (name === 'index.md') continue
      const text = readText(file)
      if (text === null) {
        const children = listFiles(file)
        if (children.length) {
          rows.push(`${prefix}${name}/`)
          walk(file, depth + 1, `  ${prefix}`)
        }
      } else {
        rows.push(`${prefix}${name} (${Math.max(1, Math.round(Buffer.byteLength(text, 'utf-8') / 1024))}K)`)
      }
    }
  }
  walk(root, 0, '')
  return rows
}

const FREEFORM_HEADER =
  'free-form index (no `path | description` rows). Read the file itself before relying on any line above.'

/**
 * Bounded catalog text for one root. Canonical pi indexes render as rows; a
 * free-form index renders as its opening lines plus an explicit note, so a
 * project whose KB was hand-written still hands over instead of going dark.
 */
export function catalog(root, { maxBytes = 6000 } = {}) {
  const index = join(root, 'index.md')
  if (!exists(index)) {
    const tree = fileTree(root, 1, 24)
    if (!tree.length) return ''
    return truncateBytes(`files (no index.md):\n${tree.join('\n')}`, maxBytes)
  }
  const rows = parseIndex(root)
  const raw = readText(index) ?? ''
  if (rows.length === 0) {
    const head = raw.split('\n').filter((line) => line.trim()).slice(0, 80).join('\n')
    return truncateBytes(`${FREEFORM_HEADER}\n\n${head}`, maxBytes)
  }
  const live = rows.filter((row) => row.status === 'active').map((row) => `${row.path} | ${oneLine(row.description, 200)}`)
  const retired = rows
    .filter((row) => row.status !== 'active')
    .map((row) => `[${row.status.toUpperCase()}] ${row.path} | ${oneLine(row.description, 160)}`)
  const parts = [live.join('\n')]
  if (retired.length) {
    parts.push(
      `retired (folded — superseded/archived/deprecated; consult only when a task explicitly needs the history):\n${retired.join('\n')}`,
    )
  }
  return truncateBytes(parts.filter(Boolean).join('\n\n'), maxBytes)
}

export function scopeCatalog(projectRoot) {
  const sections = []
  for (const { root, scopes } of scopeRoots(projectRoot)) {
    const label = scopes.join('+')
    if (!exists(root)) {
      sections.push(`knowledge(${label}:${root}): absent (created on first distill)`)
      continue
    }
    const body = catalog(root)
    const areas = rootSections(root)
    const parts = [`knowledge(${label}:${root}):`]
    if (areas.always) parts.push(`rules:\n${areas.always}`)
    if (areas.areas) parts.push(`areas:\n${areas.areas}`)
    if (body) parts.push(body)
    if (parts.length === 1) parts.push('empty')
    sections.push(parts.join('\n'))
  }
  return sections.join('\n\n')
}

export function addEntry(root, entryPath, content, source, description) {
  const full = safeJoin(root, entryPath)
  if (full === null) throw new Error(`Invalid knowledge path: "${entryPath}" (must be a relative path inside the root)`)
  if (!source || !String(source).trim() || /[\r\n]/.test(String(source))) {
    throw new Error('A knowledge entry needs a single-line source (provenance is enforced, not suggested)')
  }
  if (!description || !String(description).trim() || /[\r\n]/.test(String(description))) {
    throw new Error('A knowledge entry needs a single-line description for the index row')
  }
  if (exists(full)) {
    throw new Error(`Entry "${entryPath}" already exists — use action=conflict for contradicting evidence, or pick a new path`)
  }
  ensureDir(dirname(full))
  const body = `${String(content).trim()}\n\n---\n\n来源: ${String(source).trim()}\n`
  atomicWrite(full, body)
  updateIndex(root, entryPath, description)
  return full
}

function updateIndex(root, entryPath, description) {
  ensureDir(root)
  const path = join(root, 'index.md')
  const current = readText(path) ?? ''
  const lines = current.split('\n')
  let found = false
  const updated = lines.map((line) => {
    const pipe = line.indexOf('|')
    if (pipe === -1) return line
    const rawPath = line.slice(0, pipe).trim()
    const tag = RETIRED.exec(rawPath)
    const indexed = (tag ? rawPath.slice(tag[0].length) : rawPath).trim().replace(/^`|`$/g, '')
    if (indexed !== entryPath) return line
    found = true
    return `${entryPath} | ${description}`
  })
  const trimmed = current.trimEnd()
  atomicWrite(path, found ? updated.join('\n') : `${trimmed}${trimmed ? '\n' : ''}${entryPath} | ${description}\n`)
}

export function markConflict(root, entryPath, newSource, conflictDescription) {
  const full = safeJoin(root, entryPath)
  if (full === null) throw new Error(`Invalid knowledge path: "${entryPath}"`)
  const current = readText(full)
  if (current === null) throw new Error(`Knowledge entry not found: ${entryPath}`)
  if (!newSource || /[\r\n]/.test(String(newSource))) throw new Error('A conflict needs a single-line source')
  if (!conflictDescription?.trim()) throw new Error('A conflict needs a description of the contradicting evidence')
  const block =
    `\n\n## ⚠️ CONFLICT (${new Date().toISOString()})\n\n` +
    `**New evidence contradicts this entry.**\n\n${conflictDescription.trim()}\n\n来源: ${String(newSource).trim()}\n`
  atomicWrite(full, current + block)
  return full
}

export function search(root, query, { limit = 40 } = {}) {
  const needle = String(query ?? '')
  if (!needle.trim()) throw new Error('A search needs a non-empty query')
  const normalized = needle.toLowerCase()
  const results = []
  const files = listFilesRecursive(root)
  for (const file of files) {
    if (results.length >= limit) break
    const text = readText(file)
    if (text === null) continue
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(normalized)) continue
      results.push(`${file.slice(root.length + 1).replace(/\\/g, '/')}:${index + 1}: ${lines[index].trim().slice(0, 240)}`)
      if (results.length >= limit) break
    }
  }
  return results
}

function listFilesRecursive(root, { maxDepth = 6, limit = 800 } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= limit) return
    for (const file of listFiles(dir)) {
      if (out.length >= limit) return
      const name = file.split(/[\\/]/).pop()
      if (name === 'index.md') continue
      const text = readText(file)
      if (text !== null) out.push(file)
      else {
        const children = listFiles(file)
        if (children.length) walk(file, depth + 1)
      }
    }
  }
  walk(root, 0)
  return out
}

export function knowledgeSummary(projectRoot) {
  const rows = []
  for (const { root, scopes } of scopeRoots(projectRoot)) {
    if (!exists(root)) continue
    const entries = parseIndex(root).filter((entry) => entry.status === 'active').length
    rows.push({ scopes, root, entries, files: listFilesRecursive(root).length, mtime: mtimeOf(join(root, 'index.md')) })
  }
  return rows
}
