import { execFile, spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, mkdirSync, readFileSync } from 'node:fs'
import { fileHash, openRegular, projectPath } from './store.js'

export function assertPins(root, check) {
  for (const [name, expected] of Object.entries(check.pins)) {
    if (fileHash(projectPath(root, name)) !== expected) throw new Error(`Verifier pin changed: ${name}`)
  }
}

/** Do not release workspace ownership until timeout cleanup has reached its force-kill barrier. */
async function execute(check, store, input, config, signal, out, err) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(check.command, check.args, { cwd: store.root, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', out, err] })
    let expired = false, closed = false, code, failure, cleaning = false, cleanupDone = false, forceTimer
    const killGroup = sig => {
      if (!child.pid) return false
      try { process.kill(-child.pid, sig); return true }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error; return false }
    }
    const settle = () => {
      if (!closed || !cleanupDone) return
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', stop)
      if (failure) reject(failure)
      else resolve({ code, expired })
    }
    const cleanup = () => {
      if (cleaning) return
      cleaning = true
      if (process.platform === 'win32') {
        if (!closed && child.pid) {
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], error => {
            if (error && !closed) failure ??= error
            cleanupDone = true; settle()
          })
        } else { cleanupDone = true; settle() }
        return
      }
      if (!killGroup('SIGTERM')) { cleanupDone = true; settle(); return }
      // A direct child closing does not cancel this timer: descendants may ignore TERM.
      forceTimer = setTimeout(() => { killGroup('SIGKILL'); cleanupDone = true; settle() }, config.killGraceMs)
    }
    const stop = () => { expired = true; cleanup() }
    const timer = setTimeout(stop, config.checkTimeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    child.on('error', error => { failure ??= error; closed = true; cleanup(); settle() })
    child.on('close', status => { code = status; closed = true; cleanup(); settle() })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { failure ??= error; cleanup() } })
    child.stdin.end(JSON.stringify(input))
    if (signal?.aborted) stop()
  })
}

/** Full logs are streamed to immutable blobs; only bounded stdout JSON enters memory. */
export async function runCheck(store, check, config, input, signal) {
  assertPins(store.root, check)
  const dirName = `.quest-router/checks/${input.id}-${input.epoch}-${input.number}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  mkdirSync(projectPath(store.root, dirName), { recursive: true })
  const outName = `${dirName}/stdout`, errName = `${dirName}/stderr`
  let out, err, outcome, failure
  try {
    out = openRegular(projectPath(store.root, outName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    err = openRegular(projectPath(store.root, errName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    outcome = await execute(check, store, input, config, signal, out, err)
  } catch (error) { failure = error }
  finally { if (out !== undefined) closeSync(out); if (err !== undefined) closeSync(err) }
  if (out === undefined || err === undefined) throw failure
  const logs = { stdout: store.capture(outName), stderr: store.capture(errName) }
  if (signal?.aborted) throw new Error('Verifier cancelled; result is not admissible')
  if (failure) throw new Error(`Verifier failed: ${failure.message}; logs: ${outName}, ${errName}`)
  if (outcome.expired || outcome.code !== 0) throw new Error(`Verifier infrastructure failure (exit=${outcome.code}, timeout=${outcome.expired}); logs: ${outName}, ${errName}`)
  assertPins(store.root, check)
  const fd = openRegular(projectPath(store.root, outName))
  let result
  try {
    if (fstatSync(fd).size > config.maxCheckBytes) throw new Error(`Verifier JSON exceeds maxCheckBytes; full log: ${outName}`)
    result = JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
  if (!result || typeof result.accepted !== 'boolean' || !Array.isArray(result.facts) || result.facts.length > 100) throw new Error('Verifier must return {accepted:boolean, facts:[{key,value,evidencePaths}]}')
  const keys = new Set()
  const facts = result.facts.map(fact => {
    if (!fact || typeof fact.key !== 'string' || !fact.key || fact.key.length > 128 || keys.has(fact.key)) throw new Error('Invalid or duplicate verifier fact key')
    keys.add(fact.key)
    if (!['string', 'number', 'boolean'].includes(typeof fact.value) || (typeof fact.value === 'number' && !Number.isFinite(fact.value))) throw new Error('Fact value must be a finite scalar')
    if (!Array.isArray(fact.evidencePaths) || !fact.evidencePaths.length) throw new Error('Every verified fact needs file evidence')
    return { key: fact.key, value: fact.value, evidence: fact.evidencePaths.map(path => store.capture(path)) }
  })
  if (result.accepted && !facts.length) throw new Error('Acceptance needs at least one evidence-bearing fact')
  return { accepted: result.accepted, facts, logs }
}
