// Shared primitives for the pi-harness bridge.
// Everything here is runtime-neutral Node.js: no DSH imports, no pi imports.

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const BOARD_DIRNAME = '.pi-board'
export const KNOWLEDGE_DIRNAME = 'knowledge'
export const HANDOFF_DIRNAME = 'handoff'

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf-8').digest('hex')
}

export function shortId() {
  return randomUUID()
}

export function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function readText(path) {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** Atomic replace: write a sibling temp file, then rename over the target. */
export function atomicWrite(path, content) {
  ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf-8', flag: 'wx' })
    renameSync(temp, path)
  } finally {
    if (exists(temp)) {
      try {
        unlinkSync(temp)
      } catch {
        /* best effort */
      }
    }
  }
}

export function appendLine(path, line) {
  ensureDir(dirname(path))
  appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, 'utf-8')
}

export function listFiles(dir, extension) {
  try {
    return readdirSync(dir)
      .filter((name) => (extension ? name.endsWith(extension) : true))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

export function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Bound a string by UTF-8 bytes without splitting a surrogate pair. */
export function truncateBytes(text, maxBytes) {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid), 'utf-8') <= maxBytes) low = mid
    else high = mid - 1
  }
  const cut = value.slice(0, low)
  return `${cut}\n[truncated: ${Buffer.byteLength(value, 'utf-8') - Buffer.byteLength(cut, 'utf-8')} bytes withheld from this view; read the file for the complete content]`
}

export function oneLine(value, maxChars = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 1)}…`
}

/** True when `child` is inside `parent` (path-segment aware). */
export function isInside(parent, child) {
  const rel = resolve(child).slice(resolve(parent).length)
  return resolve(child) === resolve(parent) || rel.startsWith(sep)
}

const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/i

/**
 * Home directory as seen from the project's own world. A WSL-hosted project
 * must resolve `~/.pi-harness` inside that distro, not the Windows profile,
 * or the global knowledge tier silently splits in two.
 */
export function homeFor(path) {
  const match = WSL_UNC.exec(String(path))
  if (match) {
    const segments = match[1].split('\\')
    const homeIndex = segments.indexOf('home')
    if (homeIndex >= 0 && segments.length > homeIndex + 1) {
      const distro = String(path).split('\\')[3]
      return `\\\\wsl.localhost\\${distro}\\home\\${segments[homeIndex + 1]}`
    }
  }
  return homedir()
}

/** Nearest ancestor containing `.git`; falls back to the project directory. */
export function nearestGitRoot(startDir) {
  let current = resolve(startDir)
  while (true) {
    if (exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(startDir)
    current = parent
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * Cooperative writer lock compatible with pi-harness: a JSON record created by
 * hard-linking a fully written candidate file into place, so a crash can never
 * leave an unparseable lock. A provably dead owner may be reclaimed.
 */
export function withTopicLock(topicPath, operation, { timeoutMs = 5000 } = {}) {
  const lockPath = `${topicPath}.lock`
  ensureDir(dirname(lockPath))
  const start = Date.now()
  while (true) {
    const token = randomUUID()
    const record = JSON.stringify({
      version: 1,
      pid: process.pid,
      processStart: null,
      token,
      acquiredAt: Date.now(),
    })
    const candidate = `${lockPath}.candidate.${process.pid}.${token}`
    let acquired = false
    try {
      writeFileSync(candidate, record, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
      try {
        linkSync(candidate, lockPath)
        acquired = true
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    } finally {
      try {
        unlinkSync(candidate)
      } catch {
        /* candidate already consumed */
      }
    }
    if (acquired) {
      try {
        return operation()
      } finally {
        const current = readText(lockPath)
        if (current) {
          try {
            if (JSON.parse(current).token === token) unlinkSync(lockPath)
          } catch {
            /* a foreign malformed lock is left for a human */
          }
        }
      }
    }
    // Stale reclaim: only when the recorded owner is provably gone.
    const held = readText(lockPath)
    if (held) {
      try {
        const parsed = JSON.parse(held)
        if (Number.isInteger(parsed?.pid) && !processAlive(parsed.pid)) {
          const observed = readText(lockPath)
          if (observed === held) unlinkSync(lockPath)
          continue
        }
      } catch {
        /* legacy plain-PID lock */
        const pid = Number(held.trim())
        if (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
          const observed = readText(lockPath)
          if (observed === held) unlinkSync(lockPath)
          continue
        }
      }
    }
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `Timed out waiting for the board writer lock on "${topicPath}" (another process holds it and is not provably dead)`,
      )
    }
  }
}

export function openExclusive(path, content) {
  ensureDir(dirname(path))
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, content, 'utf-8')
  } finally {
    closeSync(fd)
  }
}

export { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync }
