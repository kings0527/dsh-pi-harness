import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const hash = value => createHash('sha256').update(value).digest('hex')
export const clone = value => JSON.parse(JSON.stringify(value))
export const idOf = value => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) throw new Error('id must be a lowercase path segment (max 80 chars)')
  return value
}

/** Resolve a project file without traversing symlinks or leaving the project. */
export function projectPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Expected a project-relative path')
  const target = resolve(root, name)
  const rel = relative(resolve(root), target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes project')
  let current = resolve(root)
  for (const part of rel.split(sep)) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Symlink not allowed: ${name}`)
  }
  return target
}

/** Append-only case journal. Hashes detect damage; they are not an access-control mechanism. */
export class Store {
  constructor(root) {
    this.root = resolve(root)
    this.base = projectPath(this.root, '.quest-router')
  }

  dir(id) { return projectPath(this.root, `.quest-router/cases/${idOf(id)}`) }

  read(id) {
    const file = join(this.dir(id), 'events.jsonl')
    if (!existsSync(file)) throw new Error(`Unknown quest ${id}`)
    const text = readFileSync(file, 'utf8')
    if (!text.endsWith('\n')) throw new Error(`Incomplete journal: ${id}; inspect before recovery`)
    let seq = 0, previous = null, state
    for (const line of text.trimEnd().split('\n')) {
      const record = JSON.parse(line)
      const { digest, ...body } = record
      if (body.seq !== ++seq || body.previous !== previous || hash(JSON.stringify(body)) !== digest) throw new Error(`Journal integrity failure: ${id}#${seq}`)
      state = body.state
      previous = digest
    }
    return { seq, digest: previous, state: clone(state) }
  }

  write(id, type, update, expectedSeq) {
    const dir = this.dir(id)
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, 'writer.lock')
    try { mkdirSync(lock) } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Quest ${id} is locked; do not auto-break a live writer lock`)
      throw error
    }
    try {
      const file = join(dir, 'events.jsonl')
      const before = existsSync(file) ? this.read(id) : { seq: 0, digest: null, state: null }
      if (expectedSeq !== undefined && before.seq !== expectedSeq) throw new Error(`Quest changed concurrently: ${id}`)
      const state = update(before.state)
      const body = { seq: before.seq + 1, previous: before.digest, type, time: Date.now(), state }
      const record = { ...body, digest: hash(JSON.stringify(body)) }
      const fd = openSync(file, 'a')
      try { appendFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
      return clone(state)
    } finally { rmdirSync(lock) }
  }

  list() {
    const dir = projectPath(this.root, '.quest-router/cases')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(id => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id)).map(id => this.read(id).state)
  }

  blob(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    const sha256 = hash(bytes)
    const name = `.quest-router/blobs/${sha256}`
    const path = projectPath(this.root, name)
    mkdirSync(projectPath(this.root, '.quest-router/blobs'), { recursive: true })
    try { writeFileSync(path, bytes, { flag: 'wx' }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (hash(readFileSync(path)) !== sha256) throw new Error('Blob integrity failure')
    }
    return { path: name, sha256, bytes: bytes.length }
  }

  capture(name) {
    const file = projectPath(this.root, name)
    if (!lstatSync(file).isFile()) throw new Error(`Evidence must be a regular file: ${name}`)
    return { originalPath: name, ...this.blob(readFileSync(file)) }
  }
}
