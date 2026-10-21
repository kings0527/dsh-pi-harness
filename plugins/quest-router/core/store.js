import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, constants, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const hash = value => createHash('sha256').update(value).digest('hex')
export const clone = value => JSON.parse(JSON.stringify(value))
export const idOf = value => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) throw new Error('id must be a lowercase path segment (max 80 chars)')
  return value
}

/** Reject links, including dangling links. This is path hygiene, not a sandbox. */
export function projectPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Expected a project-relative path')
  const target = resolve(root, name), rel = relative(resolve(root), target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes project')
  let current = resolve(root)
  for (const part of rel.split(sep)) {
    current = join(current, part)
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink not allowed: ${name}`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return target
}

export function openRegular(file, flags = constants.O_RDONLY) {
  const fd = openSync(file, flags | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { if (!fstatSync(fd).isFile()) throw new Error(`Expected regular file: ${file}`) }
  catch (error) { closeSync(fd); throw error }
  return fd
}

function copyHash(fd, output) {
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
  let bytes = 0, n
  while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
    digest.update(buffer.subarray(0, n)); bytes += n
    if (output !== undefined) for (let offset = 0; offset < n;) offset += writeSync(output, buffer, offset, n - offset)
  }
  return { sha256: digest.digest('hex'), bytes }
}

export function fileHash(file) {
  const fd = openRegular(file)
  try { return copyHash(fd).sha256 } finally { closeSync(fd) }
}

/** A damaged case is reported separately; its verified prefix is used only for conservative accounting. */
export class Store {
  constructor(root) { this.root = resolve(root); this.base = projectPath(this.root, '.quest-router') }
  dir(id) { return projectPath(this.root, `.quest-router/cases/${idOf(id)}`) }
  journal(id) { return projectPath(this.root, `.quest-router/cases/${idOf(id)}/events.jsonl`) }

  read(id) {
    const file = this.journal(id)
    if (!existsSync(file)) throw new Error(`Unknown quest ${id}`)
    const fd = openRegular(file)
    let text
    try { text = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
    let seq = 0, previous = null, state
    try {
      for (const line of text.split('\n').slice(0, -1)) {
        const record = JSON.parse(line), { digest, ...body } = record
        if (body.seq !== seq + 1 || body.previous !== previous || hash(JSON.stringify(body)) !== digest) throw new Error(`Journal integrity failure: ${id}#${seq + 1}`)
        state = body.state; seq++; previous = digest
      }
      if (!text.endsWith('\n') || !seq) throw new Error(`Incomplete journal: ${id}; inspect before recovery`)
      return { seq, digest: previous, state: clone(state) }
    } catch (error) { error.prefix = state ? clone(state) : null; throw error }
  }

  write(id, type, update, expectedSeq) {
    const dir = this.dir(id)
    mkdirSync(dir, { recursive: true })
    const lock = projectPath(this.root, `.quest-router/cases/${id}/writer.lock`)
    try { mkdirSync(lock) } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Quest ${id} is locked; do not auto-break a live writer lock`)
      throw error
    }
    try {
      const file = this.journal(id), before = existsSync(file) ? this.read(id) : { seq: 0, digest: null, state: null }
      if (expectedSeq !== undefined && before.seq !== expectedSeq) throw new Error(`Quest changed concurrently: ${id}`)
      const state = update(before.state)
      const body = { seq: before.seq + 1, previous: before.digest, type, time: Date.now(), state }
      const record = { ...body, digest: hash(JSON.stringify(body)) }
      const fd = openRegular(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT)
      try { appendFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
      return clone(state)
    } finally { rmdirSync(lock) }
  }

  scan() {
    const dir = projectPath(this.root, '.quest-router/cases'), states = [], damaged = []
    if (existsSync(dir)) for (const id of readdirSync(dir).filter(id => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id))) {
      try { states.push(this.read(id).state) }
      catch (error) { damaged.push({ id, status: 'corrupt', reason: error.message, owner: error.prefix?.owner ?? null }) }
    }
    return { states, damaged }
  }
  list() { return this.scan().states }

  /** Called while holding runner.lock. Reserve before dispatch; cancellation never refunds a lease. */
  reserveAttempt(owner, limit, caseLimit) {
    const dir = projectPath(this.root, '.quest-router/budgets')
    mkdirSync(dir, { recursive: true })
    const path = projectPath(this.root, `.quest-router/budgets/${hash(owner)}.json`)
    let used = 0
    if (existsSync(path)) {
      const fd = openRegular(path)
      let record
      try { record = JSON.parse(readFileSync(fd, 'utf8')) } finally { closeSync(fd) }
      const { digest, ...body } = record
      if (body.owner !== owner || !Number.isSafeInteger(body.used) || body.used < 0 || hash(JSON.stringify(body)) !== digest) throw new Error('Session budget integrity failure; inspect before recovery')
      used = body.used
    }
    const { states, damaged } = this.scan()
    // A legacy damaged case may have unobservable attempts: charge its entire per-case allowance.
    const observed = states.filter(s => s.owner === owner).reduce((n, s) => n + s.attempts.length, 0)
      + damaged.filter(s => s.owner === null || s.owner === owner).length * caseLimit
    used = Math.max(used, observed)
    if (used >= limit) return false
    const body = { owner, used: used + 1 }, temporary = `${path}.${randomUUID()}.tmp`
    const fd = openRegular(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    try { writeFileSync(fd, JSON.stringify({ ...body, digest: hash(JSON.stringify(body)) })); fsyncSync(fd) } finally { closeSync(fd) }
    try { renameSync(temporary, path) } finally { if (existsSync(temporary)) unlinkSync(temporary) }
    return true
  }

  blob(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    const sha256 = hash(bytes), name = `.quest-router/blobs/${sha256}`, path = projectPath(this.root, name)
    mkdirSync(projectPath(this.root, '.quest-router/blobs'), { recursive: true })
    try {
      const fd = openRegular(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (fileHash(path) !== sha256) throw new Error('Blob integrity failure')
    }
    return { path: name, sha256, bytes: bytes.length }
  }

  capture(name) {
    const source = openRegular(projectPath(this.root, name))
    let target, temporary
    try {
      mkdirSync(projectPath(this.root, '.quest-router/blobs'), { recursive: true })
      temporary = projectPath(this.root, `.quest-router/blobs/.capture-${randomUUID()}`)
      target = openRegular(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
      const ref = copyHash(source, target)
      fsyncSync(target); closeSync(target); target = undefined
      const path = `.quest-router/blobs/${ref.sha256}`, destination = projectPath(this.root, path)
      try { linkSync(temporary, destination) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (fileHash(destination) !== ref.sha256) throw new Error('Blob integrity failure')
      }
      return { originalPath: name, path, ...ref }
    } finally { closeSync(source); if (target !== undefined) closeSync(target); if (temporary && existsSync(temporary)) unlinkSync(temporary) }
  }
}
