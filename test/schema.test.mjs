import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelegateTool } from '../lib/delegate.js'
import { createOrchestrateTool } from '../lib/orchestrate.js'
import {
  SchemaError,
  assertObjectSchema,
  assertSupportedSchema,
  validateJsonSchemaValue,
} from '../lib/schema.js'

// Tool parameter/output schemas are authored in the host's value-schema DSL:
// per-property `required: true`, explicit `additionalProperties`, and the
// author-only `json` node for arbitrary JSON values. `required: [...]` arrays are
// a raw JSON Schema construct and are not accepted here.
const ANNOTATIONS = ['description', 'title', 'default', 'examples']
const ALLOWED = {
  json: ['type'],
  object: ['type', 'properties', 'additionalProperties'],
  array: ['type', 'items'],
  string: ['type', 'enum', 'const'],
  number: ['type', 'enum', 'const'],
  integer: ['type', 'enum', 'const'],
  boolean: ['type', 'enum', 'const'],
  null: ['type', 'enum', 'const'],
}

function walk(node, path, problems, property = false) {
  if (node === undefined || node === null) {
    problems.push(`${path}: schema is missing`)
    return
  }
  if (typeof node !== 'object' || Array.isArray(node)) {
    problems.push(`${path}: schema must be an object`)
    return
  }
  if (Object.hasOwn(node, 'oneOf')) {
    if ('type' in node) problems.push(`${path}: oneOf cannot be combined with type`)
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) problems.push(`${path}.oneOf needs at least two branches`)
    else node.oneOf.forEach((branch, index) => walk(branch, `${path}.oneOf[${index}]`, problems, false))
    return
  }
  const type = node.type
  const allowed = ALLOWED[type]
  if (allowed === undefined) {
    problems.push(`${path}: type ${String(type)} is not supported`)
    return
  }
  const keys = [...allowed, ...ANNOTATIONS, ...(property ? ['required'] : [])]
  for (const key of Object.keys(node)) {
    if (!keys.includes(key)) problems.push(`${path}.${key} is not supported on ${type}`)
  }
  if (property && Object.hasOwn(node, 'required') && node.required !== true) {
    problems.push(`${path}.required must be true when present`)
  }
  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') problems.push(`${path}.additionalProperties must be explicit`)
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      walk(child, `${path}.properties.${name}`, problems, true)
    }
  } else if (type === 'array' && Object.hasOwn(node, 'items')) {
    walk(node.items, `${path}.items`, problems, false)
  }
}

const route = { provider: 'p', model: 'm' }
const config = {
  workerProvider: { get: () => route.provider },
  workerModel: { get: () => route.model },
  workerReasoningEffort: { get: () => '' },
}

function authorProblems(tool) {
  const problems = []
  walk({ type: 'object', additionalProperties: false, properties: tool.parameters }, 'parameters', problems)
  walk(tool.output.schema, 'schema', problems)
  return problems
}

test('delegate schemas stay inside the host author dialect', () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config })
  assert.deepEqual(authorProblems(tool), [])
  assert.equal(tool.parameters.description.required, true)
  assert.equal(tool.parameters.prompt.required, true)
  assert.equal('required' in tool.parameters.cwd, false)
  assert.equal(JSON.stringify(tool.parameters).includes('"required":['), false)
  assert.equal(JSON.stringify(tool.output.schema).includes('"required":['), false)
})

test('orchestrate schemas stay inside the host author dialect and expose the stated inputs', () => {
  const tool = createOrchestrateTool({ defineTool: (d) => d, subagents: {}, config })
  assert.deepEqual(authorProblems(tool), [])
  assert.deepEqual(Object.keys(tool.parameters).sort(), [
    'cwd',
    'items',
    'maxConcurrency',
    'model',
    'provider',
    'reasoning_effort',
    'stages',
  ])
  assert.equal(tool.parameters.items.required, true)
  assert.equal(tool.parameters.items.items.type, 'json')
  assert.equal(tool.parameters.stages.required, true)
  const stage = tool.parameters.stages.items
  assert.equal(stage.type, 'object')
  assert.deepEqual(Object.keys(stage.properties).sort(), ['name', 'prompt', 'schema'])
  assert.equal(stage.properties.name.required, true)
  assert.equal(stage.properties.prompt.required, true)
  assert.equal('required' in stage.properties.schema, false)
  // A route override is spelled like the native subagent tool, and only the call accepts one.
  for (const key of ['provider', 'model', 'reasoning_effort']) {
    assert.equal(tool.parameters[key].type, 'string')
    assert.equal('required' in tool.parameters[key], false)
  }
  const stageText = JSON.stringify(stage.properties)
  assert.equal(stageText.includes('"provider"'), false)
  assert.equal(stageText.includes('"model"'), false)
  assert.equal(tool.isConcurrencySafe(), true)
})

test('the raw stage-schema subset accepts object roots with the documented keywords', () => {
  const schema = {
    type: 'object',
    properties: {
      answer: { type: 'integer', enum: [1, 2, 3] },
      detail: { type: 'string', const: 'x' },
      tags: { type: 'array', items: { type: 'string' } },
      nested: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      choice: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['answer'],
    additionalProperties: false,
  }
  assert.deepEqual(assertObjectSchema(schema), schema)
  assert.deepEqual(validateJsonSchemaValue(schema, { answer: 1 }), [])
})

test('the raw stage-schema subset rejects shapes it would otherwise silently ignore', () => {
  // Root object-ness is enforced for stage schemas specifically.
  assert.throws(() => assertObjectSchema({ type: 'array', items: { type: 'string' } }), /type must be "object"/)
  const cases = [
    [{ properties: {} }, /properties is not supported without "type" or "oneOf"/],
    [{ type: 'object', 'x-unknown': true }, /x-unknown is not a supported keyword/],
    [{ type: 'object', properties: { a: { type: 'object' } }, required: ['a', 'b'] }, /required names "b"/],
    [{ type: 'object', properties: {}, additionalProperties: 'no' }, /additionalProperties must be a boolean/],
    [{ oneOf: [{ type: 'string' }] }, /at least two schemas/],
    [{ type: 'object', oneOf: [{ type: 'object' }, { type: 'null' }] }, /cannot combine/],
    [{ type: 'string', enum: [1] }, /enum must be a non-empty array of string values/],
    [{ type: 'string', default: undefined }, /default must be a lossless JSON value/],
    [{ type: 'string', examples: [() => 1] }, /examples must be a lossless JSON value/],
    [{ type: 'object', properties: {}, enum: [{}] }, /enum is only supported on scalar types/],
    [{ type: 'array', const: [] }, /const is only supported on scalar types/],
  ]
  for (const [schema, pattern] of cases) {
    assert.throws(() => assertSupportedSchema(schema), (error) => error instanceof SchemaError && pattern.test(error.message))
  }
})

test('validateJsonSchemaValue reports type, required and additionalProperties violations', () => {
  const schema = {
    type: 'object',
    properties: {
      answer: { type: 'integer' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
    },
    required: ['answer'],
    additionalProperties: false,
  }
  assert.match(validateJsonSchemaValue(schema, { answer: 'x' }).join('\n'), /value\.answer must be a integer/)
  assert.match(validateJsonSchemaValue(schema, {}).join('\n'), /missing required property "answer"/)
  assert.match(validateJsonSchemaValue(schema, { answer: 1, mode: 'other' }).join('\n'), /must be one of/)
  assert.match(validateJsonSchemaValue(schema, { answer: 1, extra: true }).join('\n'), /not a declared property/)
})

test('oneOf requires exactly one matching branch', () => {
  const schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  assert.deepEqual(validateJsonSchemaValue(schema, 'x'), [])
  assert.deepEqual(validateJsonSchemaValue(schema, [], 'value'), ['value must match exactly one oneOf branch (matched 0)'])
  const overlapping = { oneOf: [{ type: 'integer' }, { type: 'number' }] }
  assert.match(validateJsonSchemaValue(overlapping, 1).join('\n'), /matched 2/)
})
