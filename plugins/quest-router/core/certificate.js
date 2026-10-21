import { readFileSync } from 'node:fs'
import { fileHash, hash, projectPath } from './store.js'

/** Validate every immutable receipt reference, live evidence, pins, and upstream version. */
export function validCertificate(store, id, checks, seen = new Set()) {
  if (seen.has(id)) return false
  try {
    const state = store.read(id).state, certificate = state.certificate
    if (state.status !== 'accepted' || !certificate) return false
    if (checks !== undefined && (!Object.hasOwn(checks, state.contract.check) || state.contract.verifierHash !== hash(JSON.stringify(checks[state.contract.check])))) return false
    const matches = (ref, live = false) => {
      if (!ref || fileHash(projectPath(store.root, ref.path)) !== ref.sha256) return false
      return !live || !ref.originalPath || fileHash(projectPath(store.root, ref.originalPath)) === ref.sha256
    }
    if (![certificate.ref, certificate.verification, ...state.contract.inputs].every(ref => matches(ref))) return false
    const verification = JSON.parse(readFileSync(projectPath(store.root, certificate.verification.path), 'utf8'))
    if (![verification.logs?.stdout, verification.logs?.stderr].every(ref => matches(ref))) return false
    if (!certificate.evidence.every(f => f.evidence.every(ref => matches(ref, true)))) return false
    if (!Object.entries(certificate.verifierPins).every(([name, expected]) => fileHash(projectPath(store.root, name)) === expected)) return false
    return Object.entries(certificate.dependencies).every(([dep, digest]) =>
      store.read(dep).state.certificate?.digest === digest && validCertificate(store, dep, checks, new Set(seen).add(id)))
  } catch { return false }
}
