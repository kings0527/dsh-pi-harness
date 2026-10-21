// Keyless demonstration: simulated model calls, real subprocess verification and persistent receipts.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Quest } from '../core/quest.js'
import { hash } from '../core/store.js'

const root = mkdtempSync(join(tmpdir(), 'quest-demo-'))
const verifier = readFileSync(fileURLToPath(new URL('./verify.mjs', import.meta.url)), 'utf8')
writeFileSync(join(root, 'verify.mjs'), verifier)
const config = {
  routes: [
    { id: 'flash', provider: 'simulation', model: 'flash', reasoningEffort: 'high', tier: 0, cost: 1 },
    { id: 'alternative', provider: 'simulation', model: 'alternative', reasoningEffort: 'max', tier: 1, cost: 4 },
  ],
  checks: { exit: { command: process.execPath, args: ['verify.mjs'], pins: { 'verify.mjs': hash(verifier) } } },
}
const quest = new Quest(root, config, async request => {
  console.log(`attempt ${request.number}: ${request.plan.routeId} / ${request.plan.method}`)
  const experiment = {
    hypothesis: 'A missing witness blocks the next step', discriminatingTest: `Run the independent witness verifier using ${request.plan.method}`,
    expectedObservation: 'A reproducible witness with value 42',
  }
  request.commitExperiment(experiment)
  if (request.plan.routeId === 'alternative') writeFileSync(join(root, 'exit-witness.json'), JSON.stringify({ value: 42, reproduced: true }))
  return { stopReason: 'completed', structured: {
    ...experiment, conclusion: 'The exit witness satisfies the configured check.',
    limitations: ['This is a simulated routing demonstration, not evidence about real model rankings.'],
  } }
})
quest.create({ id: 'step-eight', objective: 'Enter step nine', entry: 'Mainline premise snapshot', exit: 'Pinned verifier accepts the witness', check: 'exit' }, 'demo')
console.log(JSON.stringify(await quest.run('step-eight', 'demo'), null, 2))
console.log(`Inspect artifacts: node cli.js inspect ${root} step-eight`)
