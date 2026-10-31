// Keep the generated pi core's scoped knowledge roots identical to the DSH
// reader. Unscoped pi behavior remains in the original bundled implementation.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = '// DSH_ROOT_RESOLVER_PATCH v1'
const dependency = "import { knowledgeRoot as dshKnowledgeRoot } from '../lib/knowledge.js';"

export function prepareCore(source) {
  if (source.includes(marker)) {
    if (!source.includes(dependency) || !source.includes('return dshKnowledgeRoot(dshRoot,')) throw new Error('Incomplete DSH knowledge-root patch')
    return source
  }
  const entry = /function getKnowledgeRoot\((\w+)\s*=\s*["']project["']\)\s*\{\r?\n(\s*)assertScope\(\1\);/
  if (!entry.test(source)) throw new Error('Unknown pi core knowledge resolver; review the rebuilt bundle before using it')
  const patched = source.replace(entry, (matched, scope, indent) => `${matched}\n${indent}const dshRoot = scopedProjectRoot();\n${indent}if (dshRoot !== undefined) return dshKnowledgeRoot(dshRoot, ${scope});`)
  return `${marker}\n${dependency}\n${patched}`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = fileURLToPath(new URL('../dist/core.js', import.meta.url))
  const before = readFileSync(path, 'utf-8')
  const after = prepareCore(before)
  if (after !== before) writeFileSync(path, after, 'utf-8')
}
