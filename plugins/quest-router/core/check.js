import { spawn } from 'node:child_process'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { hash, projectPath } from './store.js'

export function assertPins(root, check) {
  for (const [name, expected] of Object.entries(check.pins)) {
    if (hash(readFileSync(projectPath(root, name))) !== expected) throw new Error(`Verifier pin changed: ${name}`)
  }
}

/** Run only a host-configured verifier, with full logs on disk and bounded JSON parsing. */
export async function runCheck(store, check, config, input, signal) {
  assertPins(store.root, check)
  const dirName = `.quest-router/checks/${input.id}-${input.epoch}-${input.number}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  mkdirSync(projectPath(store.root, dirName), { recursive: true })
  const outName = `${dirName}/stdout`, errName = `${dirName}/stderr`
  const out = openSync(projectPath(store.root, outName), 'wx'), err = openSync(projectPath(store.root, errName), 'wx')
  let outcome
  try {
    outcome = await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return }
      const child = spawn(check.command, check.args, { cwd: store.root, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', out, err] })
      let expired = false, killTimer, finished = false
      const kill = sig => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig)
          else child.kill(sig)
        } catch (error) { if (error.code !== 'ESRCH') reject(error) }
      }
      const stop = () => { expired = true; kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 1000) }
      const timer = setTimeout(stop, config.checkTimeoutMs)
      signal?.addEventListener('abort', stop, { once: true })
      const finish = (code, error) => {
        if (finished) return
        finished = true
        clearTimeout(timer); clearTimeout(killTimer)
        signal?.removeEventListener('abort', stop)
        if (error) reject(error)
        else resolve({ code, expired })
      }
      child.on('error', error => finish(null, error))
      child.on('close', code => finish(code))
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(null, error) })
      child.stdin.end(JSON.stringify(input))
    })
  } finally { closeSync(out); closeSync(err) }
  const logs = { stdout: store.capture(outName), stderr: store.capture(errName) }
  if (signal?.aborted) throw new Error('Verifier cancelled; result is not admissible')
  if (outcome.expired || outcome.code !== 0) throw new Error(`Verifier infrastructure failure (exit=${outcome.code}, timeout=${outcome.expired}); logs: ${outName}, ${errName}`)
  assertPins(store.root, check)
  if (lstatSync(projectPath(store.root, outName)).size > config.maxCheckBytes) throw new Error(`Verifier JSON exceeds maxCheckBytes; full log: ${outName}`)
  const result = JSON.parse(readFileSync(projectPath(store.root, outName), 'utf8'))
  if (typeof result.accepted !== 'boolean' || !Array.isArray(result.facts) || result.facts.length > 100) throw new Error('Verifier must return {accepted:boolean, facts:[{key,value,evidencePaths}]}')
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
