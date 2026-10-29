/**
 * The JSON Schema subset accepted for a stage's `schema`, plus a small validator
 * for stage outputs.
 *
 * The host compiles tool *parameter* schemas with its own author-facing dialect
 * (per-property `required: true`). A stage schema is different: it is a plain JSON
 * Schema value passed through to the worker, so it accepts the documented subset
 * below. Both tree shapes are checked, so a bad stage schema fails the whole call
 * before any worker starts.
 *
 * Supported node shapes, recursively:
 * - `{ type: 'object', properties?, required?, additionalProperties? }`
 * - `{ type: 'array', items? }`
 * - `{ type: 'string' | 'number' | 'integer' | 'boolean' | 'null', enum?, const? }`
 * - `{ oneOf: [schema, ...] }` (two or more branches, no sibling constraints)
 * - annotation-only nodes (`description`, `title`, `default`, `examples`) accept any
 *   JSON value.
 * Unknown keywords are rejected rather than ignored: a silently ignored constraint
 * would make a stage look validated when it is not.
 */

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])
/** Constraints that would silently change the meaning of a `oneOf` node. */
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

export class SchemaError extends Error {
  constructor(violations) {
    super(`unsupported stage schema: ${violations.join('; ')}`)
    this.name = 'SchemaError'
    this.violations = violations
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The host's lossless-JSON boundary: finite numbers, no -0, dense arrays, plain records. */
export function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonValue(value[index], seen)) return false
      }
      return true
    }
    if (!isPlainObject(value)) return false
    for (const key of Object.keys(value)) {
      if (!isJsonValue(value[key], seen)) return false
    }
    return true
  } finally {
    seen.delete(value)
  }
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    case 'integer':
      return Number.isInteger(value) && !Object.is(value, -0)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

function inspectNode(node, path, violations, seen) {
  if (!isPlainObject(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  if (seen.has(node)) {
    violations.push(`${path} must not be circular`)
    return
  }
  seen.add(node)
  try {
    for (const key of Object.keys(node)) {
      if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
        violations.push(`${path}.${key} is not a supported keyword`)
      }
    }
    for (const annotation of ANNOTATIONS) {
      if (!Object.hasOwn(node, annotation)) continue
      if (!isJsonValue(node[annotation])) {
        violations.push(`${path}.${annotation} must be a lossless JSON value`)
      } else if ((annotation === 'description' || annotation === 'title') && typeof node[annotation] !== 'string') {
        violations.push(`${path}.${annotation} must be a string`)
      }
    }

    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')

    if (hasType && hasOneOf) {
      violations.push(`${path} cannot combine "type" and "oneOf"`)
      return
    }

    if (hasOneOf) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside "oneOf"`)
      }
      const branches = node.oneOf
      if (!Array.isArray(branches) || branches.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        branches.forEach((branch, index) => inspectNode(branch, `${path}.oneOf[${index}]`, violations, seen))
      }
      return
    }

    if (!hasType) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported without "type" or "oneOf"`)
      }
      return
    }

    const type = node.type
    if (typeof type !== 'string' || !TYPES.includes(type)) {
      violations.push(`${path}.type must be one of ${TYPES.join(', ')}`)
      return
    }

    if (Object.hasOwn(node, 'properties') && type !== 'object') {
      violations.push(`${path}.properties is only supported on "object"`)
    }
    if (Object.hasOwn(node, 'required') && type !== 'object') {
      violations.push(`${path}.required is only supported on "object"`)
    }
    if (Object.hasOwn(node, 'additionalProperties') && type !== 'object') {
      violations.push(`${path}.additionalProperties is only supported on "object"`)
    }
    if (Object.hasOwn(node, 'items') && type !== 'array') {
      violations.push(`${path}.items is only supported on "array"`)
    }
    if (Object.hasOwn(node, 'enum') && !SCALAR_TYPES.has(type)) {
      violations.push(`${path}.enum is only supported on scalar types`)
    }
    if (Object.hasOwn(node, 'const') && !SCALAR_TYPES.has(type)) {
      violations.push(`${path}.const is only supported on scalar types`)
    }

    if (type === 'object') {
      const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined
      if (properties !== undefined) {
        if (!isPlainObject(properties)) {
          violations.push(`${path}.properties must be an object of schemas`)
        } else {
          for (const [name, child] of Object.entries(properties)) {
            inspectNode(child, `${path}.properties.${name}`, violations, seen)
          }
        }
      }
      if (Object.hasOwn(node, 'required')) {
        const required = node.required
        if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
          violations.push(`${path}.required must be an array of strings`)
        } else {
          const declared = isPlainObject(properties) ? properties : {}
          for (const name of required) {
            if (!Object.hasOwn(declared, name)) {
              violations.push(`${path}.required names "${name}" which is not declared in properties`)
            }
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
    }

    if (type === 'array' && Object.hasOwn(node, 'items')) {
      inspectNode(node.items, `${path}.items`, violations, seen)
    }

    if (SCALAR_TYPES.has(type)) {
      if (Object.hasOwn(node, 'enum')) {
        const allowed = node.enum
        if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((value) => scalarMatches(type, value))) {
          violations.push(`${path}.enum must be a non-empty array of ${type} values`)
        }
      }
      if (Object.hasOwn(node, 'const')) {
        const value = node.const
        if (!scalarMatches(type, value)) {
          violations.push(`${path}.const must be a ${type} value`)
        } else if (Array.isArray(node.enum) && node.enum.every((entry) => scalarMatches(type, entry))) {
          if (!node.enum.includes(value)) violations.push(`${path}.const must also appear in enum`)
        }
      }
    }
  } finally {
    seen.delete(node)
  }
}

/** Throw a `SchemaError` unless `schema` stays inside the supported subset. */
export function assertSupportedSchema(schema, path = 'schema') {
  const violations = []
  inspectNode(schema, path, violations, new Set())
  if (violations.length > 0) throw new SchemaError(violations)
  return schema
}

/** A stage schema must be object-rooted; text-only stages omit the schema entirely. */
export function assertObjectSchema(schema, path = 'schema') {
  assertSupportedSchema(schema, path)
  if (!isPlainObject(schema) || !Object.hasOwn(schema, 'type') || schema.type !== 'object') {
    throw new SchemaError([`${path}.type must be "object"`])
  }
  return schema
}

function property(path, key) {
  return `${path}.${key}`
}

function checkValue(node, value, path, violations) {
  if (!isPlainObject(node)) return

  const branches = node.oneOf
  if (Array.isArray(branches)) {
    let matches = 0
    for (const branch of branches) {
      if (validateJsonSchemaValue(branch, value, path).length === 0) matches += 1
    }
    if (matches !== 1) violations.push(`${path} must match exactly one oneOf branch (matched ${matches})`)
    return
  }

  const type = node.type
  if (typeof type !== 'string') return

  switch (type) {
    case 'object': {
      if (!isPlainObject(value)) {
        violations.push(`${path} must be an object`)
        return
      }
      const properties = isPlainObject(node.properties) ? node.properties : {}
      for (const name of Array.isArray(node.required) ? node.required : []) {
        if (!Object.hasOwn(value, name) || value[name] === undefined) {
          violations.push(`missing required property "${name}" at ${path}`)
        }
      }
      for (const [name, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, name) || value[name] === undefined) continue
        checkValue(child, value[name], property(path, name), violations)
      }
      if (node.additionalProperties === false) {
        for (const name of Object.keys(value)) {
          if (!Object.hasOwn(properties, name)) {
            violations.push(`"${name}" is not a declared property (additionalProperties: false) at ${path}`)
          }
        }
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path} must be an array`)
        return
      }
      if (Object.hasOwn(node, 'items')) {
        value.forEach((item, index) => checkValue(node.items, item, `${path}[${index}]`, violations))
      }
      return
    }
    default:
      break
  }

  if (!scalarMatches(type, value)) {
    violations.push(`${path} must be a ${type}`)
    return
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    violations.push(`${path} must be one of ${JSON.stringify(node.enum)}`)
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    violations.push(`${path} must be ${JSON.stringify(node.const)}`)
  }
}

/**
 * Validate a value against a schema already accepted by `assertSupportedSchema`.
 * Returns human-readable violations; an empty array means valid.
 */
export function validateJsonSchemaValue(schema, value, path = 'value') {
  const violations = []
  checkValue(schema, value, path, violations)
  return violations
}
