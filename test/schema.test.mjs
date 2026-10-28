import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelegateTool } from '../lib/delegate.js'

// The host compiles tool schemas with a restricted value-schema DSL. These are the
// only node shapes it accepts; `required` (in any position) is not among them.
const ANNOTATIONS = ['description', 'title', 'default', 'examples']
const ALLOWED = {
  object: ['type', 'properties', 'additionalProperties'],
  array: ['type', 'items'],
  string: ['type', 'enum', 'const'],
  number: ['type', 'enum', 'const'],
  integer: ['type', 'enum', 'const'],
  boolean: ['type', 'enum', 'const'],
  null: ['type', 'enum', 'const'],
}

function walk(node, path, problems) {
  if (node === undefined || node === null) return
  const type = node.type
  const allowed = ALLOWED[type]
  if (allowed === undefined) {
    problems.push(`${path}: type ${String(type)} is not supported`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key) && !ANNOTATIONS.includes(key)) problems.push(`${path}.${key} is not supported on ${type}`)
  }
  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') problems.push(`${path}.additionalProperties must be explicit`)
    for (const [name, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${name}`, problems)
  }
}

test('delegate schemas stay inside the host value-schema dialect', () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: { workerProvider: { get: () => '' }, workerModel: { get: () => '' }, workerReasoningEffort: { get: () => '' } } })
  const problems = []
  walk({ type: 'object', additionalProperties: false, properties: tool.parameters }, 'parameters', problems)
  walk(tool.output.schema, 'schema', problems)
  assert.deepEqual(problems, [])
  assert.equal(JSON.stringify(tool.parameters).includes('required'), false)
  assert.equal(JSON.stringify(tool.output.schema).includes('required'), false)
})
