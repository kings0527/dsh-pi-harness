// Session handoffs — the "open this directory and continue" contract.
//
// pi-harness keeps handoffs at `<project-root>/handoff/`. Existing projects
// also carry a root `HANDOFF.md`, so both are discoverable here.

import { join } from 'node:path'
import { ensureDir, exists, listFiles, mtimeOf, oneLine, readText, truncateBytes, atomicWrite } from './util.js'

export function handoffDir(projectRoot) {
  return join(projectRoot, 'handoff')
}

function rootHandoffs(projectRoot) {
  return listFiles(projectRoot).filter((path) => /[\\/]HANDOFF[^\\/]*\.md$/i.test(path))
}

export function listHandoffs(projectRoot) {
  const fromDir = listFiles(handoffDir(projectRoot), '.md').map((path) => ({
    path,
    name: path.split(/[\\/]/).pop(),
    mtime: mtimeOf(path),
  }))
  const fromRoot = rootHandoffs(projectRoot).map((path) => ({
    path,
    name: path.split(/[\\/]/).pop(),
    mtime: mtimeOf(path),
  }))
  return [...fromDir, ...fromRoot].sort((a, b) => b.mtime - a.mtime)
}

export function latestHandoff(projectRoot) {
  return listHandoffs(projectRoot)[0]
}

export function readHandoff(projectRoot, name) {
  const all = listHandoffs(projectRoot)
  const match = name ? all.find((entry) => entry.name === name) : all[0]
  if (!match) throw new Error(`No handoff found in ${projectRoot} (looked under handoff/ and root HANDOFF*.md)`)
  return { ...match, content: readText(match.path) ?? '' }
}

function slugify(value) {
  return String(value ?? 'session')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'session'
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function writeHandoff(projectRoot, { title, content, slug, agent = 'deepseek-harness' } = {}) {
  const dir = handoffDir(projectRoot)
  ensureDir(dir)
  const name = `${stamp()}-${slugify(slug || title || 'session')}.md`
  const path = join(dir, name)
  if (exists(path)) throw new Error(`Handoff "${name}" already exists; choose a different slug`)
  const heading = title?.trim() || 'Session handoff'
  const body = content?.trim()
    ? content.trim()
    : [
        `# ${heading}`,
        '',
        `- date: ${new Date().toISOString()}`,
        `- agent: ${agent}`,
        '- status: open',
        '',
        '## Goal',
        '',
        '_(what this session was asked to achieve)_',
        '',
        '## Done',
        '',
        '_(verified facts, with evidence paths)_',
        '',
        '## Next',
        '',
        '_(the exact next action, including files and commands)_',
        '',
        '## Evidence',
        '',
        '_(board topics, knowledge entries, commands, artifacts)_',
        '',
      ].join('\n')
  atomicWrite(path, body.endsWith('\n') ? body : `${body}\n`)
  return { path, name, bytes: Buffer.byteLength(body, 'utf-8') }
}

/** Compact pointer for the per-turn reference; never inlines the whole handoff. */
export function handoffPointer(projectRoot, { maxBytes = 1200, knowledgeMtime = 0 } = {}) {
  const latest = latestHandoff(projectRoot)
  if (!latest) return ''
  const text = readText(latest.path) ?? ''
  const firstHeading = text.split('\n').find((line) => line.startsWith('#')) ?? latest.name
  const nextSection = /##\s+(?:Next|下一步|接下来)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(text)
  const next = nextSection ? oneLine(nextSection[1], 400) : ''
  const relative = latest.path.slice(projectRoot.length + 1).replace(/\\/g, '/')
  // A handoff older than the knowledge base is a trap: the reader follows it and
  // misses conclusions recorded afterwards. Say so instead of ranking them equally.
  const staleNotice =
    knowledgeMtime > latest.mtime + 60_000
      ? `\nnote: knowledge was updated after this handoff (${new Date(knowledgeMtime).toISOString()}); prefer the knowledge base for current state.`
      : ''
  return truncateBytes(
    `latest handoff: ${relative} (${new Date(latest.mtime).toISOString()}) — ${oneLine(firstHeading.replace(/^#+\s*/, ''), 120)}` +
      (next ? `\nnext: ${next}` : '') +
      staleNotice +
      `\nread it with the handoff tool before continuing.`,
    maxBytes,
  )
}
