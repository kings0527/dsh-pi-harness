import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../index.js'
import { findKnowledgeScope, scopeCatalog, readEntry } from '../lib/knowledge.js'
import { buildDelta, buildReference } from '../lib/reference.js'
import { knowledgeTool } from '../lib/tools.js'
import { fixture, host } from './fixtures.js'

const ROOT_KNOWLEDGE = '# Project knowledge\nROOT_BODY\n\n## Always\nROOT_RULE\n\n## Areas\nROOT_NAVIGATION\n'

test('project KNOWLEDGE navigation is automatic even without a knowledge directory', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'KNOWLEDGE.md'), ROOT_KNOWLEDGE)
  const built = buildReference(f.root)
  assert.match(built.text, /Project-wide Always rules/)
  assert.match(built.text, /ROOT_NAVIGATION/)
  assert.ok(!built.text.includes('ROOT_BODY'))
  const tool = knowledgeTool({ getProjectRoot: () => f.root })
  assert.match((await tool.execute({ action: 'read', path: '@scope/KNOWLEDGE.md' })).text, /ROOT_RULE/)
})

test('root KNOWLEDGE changes invalidate an otherwise unchanged reference', (t) => {
  const f = fixture(t)
  const before = buildReference(f.root)
  writeFileSync(join(f.root, 'KNOWLEDGE.md'), ROOT_KNOWLEDGE)
  assert.match(buildDelta(f.root, before).text, /ROOT_NAVIGATION/)
})

test('scope discovery is nearest, workspace-bounded and ignores dependency/metadata reads', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'src', 'feature'), { recursive: true })
  writeFileSync(join(f.root, 'KNOWLEDGE.md'), ROOT_KNOWLEDGE)
  writeFileSync(join(f.root, 'src', 'KNOWLEDGE.md'), '# Feature\nDIRECTORY_BODY')
  assert.equal(findKnowledgeScope(f.root, 'src/feature/main.js'), join(f.root, 'src'))
  assert.equal(findKnowledgeScope(f.root, '../outside/file.js'), null)
  assert.equal(findKnowledgeScope(f.root, 'node_modules/pkg/main.js'), null)
  assert.equal(findKnowledgeScope(f.root, '.git/config'), null)
  assert.equal(findKnowledgeScope(f.root, 'README.md'), null)
})

test('successful file access activates directory knowledge in the next step of the same turn', async (t) => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'src'))
  writeFileSync(join(f.root, 'src', 'KNOWLEDGE.md'), '# Source\nDIRECTORY_BODY')
  const h = host(f.root)
  apply(h.ctx, { doctrine: false })
  await h.step()
  const outcome = { value: { path: 'src/main.js' }, isError: false }
  assert.equal(await h.dispatch('tools/execute', { name: 'read', arguments: { file_path: 'src/main.js' } }, async () => outcome), outcome)
  const next = await h.step({ turn: 1, step: 1 })
  assert.equal(next.messages.length, 1)
  assert.match(next.messages[0].content[0].text, /@scope\/src\/KNOWLEDGE.md/)
  assert.equal((await h.step({ turn: 1, step: 2 })).messages.length, 0)
})

test('failed reads do not activate knowledge or change the tool outcome', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'KNOWLEDGE.md'), ROOT_KNOWLEDGE)
  const h = host(f.root)
  apply(h.ctx, { doctrine: false })
  await h.step()
  const failed = { isError: true, content: [{ type: 'text', text: 'not found' }] }
  assert.equal(await h.dispatch('tools/execute', { name: 'read', arguments: { file_path: 'src/main.js' } }, async () => failed), failed)
  assert.equal((await h.step({ turn: 1, step: 1 })).messages.length, 0)
})

test('root body activates on use and cannot leak through an equal-length sibling path', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'KNOWLEDGE.md'), ROOT_KNOWLEDGE)
  assert.match(scopeCatalog(f.root, { activeScopes: [f.root] }), /ROOT_BODY/)
  mkdirSync(join(f.root, 'knowledge'))
  mkdirSync(join(f.root, 'sensitive'))
  writeFileSync(join(f.root, 'sensitive', 'secret.md'), 'OUTSIDE')
  assert.throws(() => readEntry(join(f.root, 'knowledge'), '../sensitive/secret.md'), /escapes/)
})

test('long active knowledge remains addressable and reads back in full', async (t) => {
  const f = fixture(t)
  const body = 'directory detail '.repeat(2000) + 'DIRECTORY_TAIL'
  writeFileSync(join(f.root, 'KNOWLEDGE.md'), `# Scope\n${body}\n## Always\n${'rule '.repeat(2000)}ROOT_RULE_TAIL`)
  const built = buildReference(f.root, { activeScopes: [f.root] })
  assert.match(built.text, /@scope\/KNOWLEDGE.md/)
  const tool = knowledgeTool({ getProjectRoot: () => f.root })
  const full = (await tool.execute({ action: 'read', path: '@scope/KNOWLEDGE.md', limit: 0 })).text
  assert.match(full, /DIRECTORY_TAIL/)
  assert.match(full, /ROOT_RULE_TAIL/)
})

test('knowledge read pages by default and limit=0 reads the complete file', async (t) => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'knowledge'))
  writeFileSync(join(f.root, 'knowledge', 'large.md'), Array.from({ length: 500 }, (_, i) => `LINE_${i}`).join('\n'))
  const tool = knowledgeTool({ getProjectRoot: () => f.root })
  const first = (await tool.execute({ action: 'read', path: 'large.md' })).text
  assert.match(first, /Continue with offset=200/)
  assert.ok(!first.includes('LINE_499'))
  assert.match((await tool.execute({ action: 'read', path: 'large.md', limit: 0 })).text, /LINE_499/)
  const page = (await tool.execute({ action: 'read', path: 'large.md', offset: 498, limit: 800 })).text
  assert.match(page, /LINE_498/)
  assert.match(page, /LINE_499/)
  assert.ok(!page.includes('LINE_0\n'))
})

test('knowledge read preserves section headings as pi does', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'KNOWLEDGE.md'), '# Root\n## Always\nRULE\n## Interface\nAPI_DETAIL\n## Limitations\nLIMIT_DETAIL')
  const tool = knowledgeTool({ getProjectRoot: () => f.root })
  const full = (await tool.execute({ action: 'read', path: '@scope/KNOWLEDGE.md' })).text
  assert.match(full, /## Interface\nAPI_DETAIL/)
  assert.match(full, /## Limitations\nLIMIT_DETAIL/)
})

test('automatic directory knowledge does not follow workspace junctions outside its scope', (t) => {
  const f = fixture(t)
  const outside = fixture(t)
  writeFileSync(join(outside.root, 'KNOWLEDGE.md'), '# Outside\nOUTSIDE_PRIVATE_DATA')
  symlinkSync(outside.root, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(findKnowledgeScope(f.root, 'linked/main.js'), null)
  assert.ok(!scopeCatalog(f.root, { activeScopes: [join(f.root, 'linked')] }).includes('OUTSIDE_PRIVATE_DATA'))
})
