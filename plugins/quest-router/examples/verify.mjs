// A deterministic toy oracle. Replace this with a task-specific reproduction checker.
import { existsSync, readFileSync } from 'node:fs'

let body = ''
for await (const chunk of process.stdin) body += chunk
JSON.parse(body) // The real checker can use contract and candidate fields, but never trust a success claim.
const path = 'exit-witness.json'
const witness = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
const accepted = witness?.value === 42 && witness?.reproduced === true
console.log(JSON.stringify({ accepted, facts: accepted ? [{ key: 'exit-witness-reproduced', value: true, evidencePaths: [path] }] : [] }))
