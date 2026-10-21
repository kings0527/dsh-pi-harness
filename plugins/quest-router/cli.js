#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Store, hash } from './core/store.js'

const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'pin') {
    console.log(hash(readFileSync(resolve(args[0]))))
  } else if (command === 'status') {
    const store = new Store(args[0] ?? process.cwd())
    const states = args[1] ? [store.read(args[1]).state] : store.list()
    console.log(JSON.stringify(states.map(state => ({ id: state.id, status: state.status, owner: state.owner, epoch: state.epoch, attempts: state.attempts.length, reason: state.reason, certificate: state.certificate?.ref ?? null })), null, 2))
  } else if (command === 'inspect') {
    const store = new Store(args[0] ?? process.cwd())
    console.log(JSON.stringify(store.read(args[1]), null, 2))
  } else {
    console.log('Usage:\n  node cli.js pin <verifier-file>\n  node cli.js status <project-root> [quest-id]\n  node cli.js inspect <project-root> <quest-id>\n\nInspect is read-only. Crash recovery must first establish the child outcome and inspect runner.lock and the case journal.')
    if (command) process.exitCode = 1
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
