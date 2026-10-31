import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as core from '../dist/core.js'
import * as engine from '../lib/engine.js'
import { knowledgeRoot } from '../lib/knowledge.js'
import { boardTool, knowledgeTool } from '../lib/tools.js'
import { prepareCore } from '../scripts/prepare-core.mjs'
import { fixture } from './fixtures.js'

test('Windows project/workspace/global readers and writers resolve identical roots', (t) => {
  const f = fixture(t)
  const sub = join(f.root, 'subproject')
  mkdirSync(sub)
  for (const scope of ['project', 'workspace', 'global']) {
    assert.equal(core.runWithProjectRoot(sub, () => core.getKnowledgeRoot(scope)), knowledgeRoot(sub, scope))
  }
})

test('both WSL UNC spellings use the same Linux home for global reads and writes', () => {
  for (const project of [String.raw`\\wsl.localhost\Ubuntu-26.04\home\audit\git\project`, String.raw`\\wsl$\Ubuntu-26.04\home\audit\git\project`]) {
    const readRoot = knowledgeRoot(project, 'global')
    const writeRoot = core.runWithProjectRoot(project, () => core.getKnowledgeRoot('global'))
    assert.equal(writeRoot, readRoot)
    assert.match(writeRoot, /home\\audit\\\.pi-harness\\knowledge$/)
    assert.ok(!writeRoot.startsWith(homedir()))
  }
})

test('unscoped core home resolution remains unchanged', () => {
  assert.equal(core.getKnowledgeRoot('global'), join(homedir(), '.pi-harness', 'knowledge'))
})

test('overlapping async project scopes do not share storage roots', async (t) => {
  const a = fixture(t)
  const b = fixture(t)
  const roots = await Promise.all([a.root, b.root].map((root) => core.runWithProjectRoot(root, async () => {
    await Promise.resolve()
    return core.getKnowledgeRoot('project')
  })))
  assert.deepEqual(roots, [knowledgeRoot(a.root), knowledgeRoot(b.root)])
})

test('core build patch is reproducible, idempotent and rejects unknown resolver layouts', () => {
  const source = 'function getKnowledgeRoot(scope = "project") {\n  assertScope(scope);\n  return legacy(scope);\n}\n'
  const patched = prepareCore(source)
  assert.match(patched, /return dshKnowledgeRoot\(dshRoot, scope\)/)
  assert.equal(prepareCore(patched), patched)
  const actual = readFileSync(new URL('../dist/core.js', import.meta.url), 'utf-8')
  assert.equal(prepareCore(actual), actual)
  assert.throws(() => prepareCore('unknown'), /Unknown pi core/)
})

test('project/global writes read back from the same tool and retain global provenance', async (t) => {
  const f = fixture(t)
  const tool = knowledgeTool({ getProjectRoot: () => f.root })
  for (const scope of ['project', 'global']) {
    const path = `roundtrip-${scope}.md`
    await tool.execute({ action: 'add', path, scope, content: `FACT_${scope}`, source: 'audit#1', description: 'Round trip' })
    assert.match((await tool.execute({ action: 'read', path, scope })).text, new RegExp(`FACT_${scope}`))
    assert.equal((await tool.execute({ action: 'audit', scope })).text.includes('no dead rows'), true)
  }
  const events = readFileSync(join(f.root, '.pi-board', 'events.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.details?.scope === 'global'))
})

test('verification errors never write a note; evidence and targeted claim verification succeed', async (t) => {
  const f = fixture(t)
  const tool = boardTool({ getProjectRoot: () => f.root })
  const exec = { agent: { id: 'audit', session: {} } }
  await tool.execute({ action: 'open', topic: 'audit', goal: 'Verify validation contracts' }, exec)
  await tool.execute({ action: 'post', topic: 'audit', kind: 'evidence', content: 'Observed test result' }, exec)
  const path = join(f.root, '.pi-board', 'topics', 'audit.jsonl')
  const before = readFileSync(path, 'utf-8')
  await assert.rejects(tool.execute({ action: 'post', topic: 'audit', kind: 'verification', content: 'Invalid' }, exec), /requires at least one target/)
  await assert.rejects(tool.execute({ action: 'post', topic: 'audit', kind: 'verification', targets: [{ topic: 'audit', seq: 1 }], content: 'Invalid' }, exec), /target must be claim/)
  assert.equal(readFileSync(path, 'utf-8'), before)
  await tool.execute({ action: 'post', topic: 'audit', kind: 'claim', content: 'A proposition', material: true }, exec)
  const receipt = await tool.execute({ action: 'post', topic: 'audit', kind: 'verification', targets: [{ topic: 'audit', seq: 2 }], content: 'Verified' }, exec)
  assert.match(receipt.text, /Posted #3/)
  assert.equal(engine.readTopicCore_(f.root, 'audit').topic.status, 'open')
})
