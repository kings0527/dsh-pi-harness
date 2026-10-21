#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Store, hash } from './core/store.js'
import { validCertificate } from './core/certificate.js'
import { configuration } from './core/policy.js'

const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'pin') console.log(hash(readFileSync(resolve(args[0]))))
  else if (command === 'status') {
    const option = args.indexOf('--config')
    const config = option < 0 ? undefined : configuration(JSON.parse(readFileSync(resolve(args[option + 1]), 'utf8')))
    const positional = option < 0 ? args : args.slice(0, option)
    const store = new Store(positional[0] ?? process.cwd())
    const scan = store.scan(), states = positional[1] ? [store.read(positional[1]).state] : scan.states
    const rows = states.map(state => {
      const valid = state.status === 'accepted' && validCertificate(store, state.id, config?.checks)
      const status = state.status !== 'accepted' ? state.status : !valid ? 'stale' : config ? 'accepted' : 'unverified'
      return { id: state.id, status, storedStatus: state.status, configurationChecked: !!config, owner: state.owner, epoch: state.epoch, attempts: state.attempts.length, reason: state.reason, certificate: valid ? state.certificate.ref : null }
    })
    console.log(JSON.stringify({ cases: rows, damaged: scan.damaged }, null, 2))
  } else if (command === 'inspect') console.log(JSON.stringify(new Store(args[0] ?? process.cwd()).read(args[1]), null, 2))
  else {
    console.log('Usage:\n  node cli.js pin <verifier-file>\n  node cli.js status <project-root> [quest-id] [--config config.json]\n  node cli.js inspect <project-root> <quest-id>\n\nWithout --config, intact accepted receipts are unverified because the current verifier configuration is unknown. Inspect is read-only. Establish child outcome before recovering a crash lock or journal.')
    if (command) process.exitCode = 1
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
