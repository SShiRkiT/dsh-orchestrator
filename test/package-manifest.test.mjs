import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('peer dependencies support standalone and desktop package versions', () => {
  assert.equal(
    manifest.peerDependencies['@deepseek-ai/dsh-tools'],
    '>=0.0.1-rc.1 <0.1.0 || >=0.2.2-rc.2 <0.2.3-0',
  )
  assert.equal(
    manifest.peerDependencies['@deepseek-ai/dsh-llm'],
    '>=0.0.1-rc.5 <0.1.0 || >=0.2.2-rc.2 <0.2.3-0',
  )
})

test('the manifest keeps host compatibility and optional peer metadata strict', () => {
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '>=3.18.5 <4.0.0')
  assert.deepEqual(manifest.peerDependenciesMeta['@deepseek-ai/dsh-llm'], { optional: true })
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.2 <0.2.3-0')
})
