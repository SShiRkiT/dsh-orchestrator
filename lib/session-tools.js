import { randomInt } from 'node:crypto'
import { isDelegatedChild, resolveEffectiveAllowedTools } from './gate.js'
import { encodeRecordKey } from './state-store.js'

export const SESSION_TOOLS_DOMAIN = 'dsh_orchestrator_session_tools'
export const SESSION_TOOLS_TABLE = 'session_allowed_tools'
export const SESSION_TOOLS_PACKAGE = '@sshirkit/dsh-orchestrator'
export const SESSION_TOOLS_NAMESPACE = 'orchestratorSession'

const RECORD_FIELDS = ['sessionId', 'allowedTools', 'revision', 'updatedAt']
const STATE_FIELDS = ['sessionId', 'enabled', 'allowedTools', 'revision', 'storageReady']
const ownersKey = Symbol.for('@sshirkit/dsh-orchestrator/session-tools-domain-owners')
const owners = globalThis[ownersKey] ??= new WeakMap()
const cordisOriginal = Symbol.for('cordis.original')

function reserveDomain(facility) {
  const key = facility[cordisOriginal] ?? facility
  const previous = owners.get(key)
  let release
  const hold = new Promise((resolve) => { release = resolve })
  const tail = Promise.resolve(previous).then(() => hold)
  owners.set(key, tail)
  void tail.then(() => {
    if (owners.get(key) === tail) owners.delete(key)
  })
  return { previous, release }
}

function nonempty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

const parseSessionId = (value) => nonempty(value, 'sessionId')

function parseNames(value) {
  if (!Array.isArray(value)) throw new TypeError('allowedTools must be an array')
  const names = new Set()
  for (const name of value) names.add(nonempty(name, 'tool name'))
  return [...names]
}

function parseRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('revision must be a non-negative safe integer')
  }
  return value
}

function fields(value, names) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || !names.every((key) => Object.hasOwn(value, key))) {
    throw new TypeError(`expected record with fields ${names.join(', ')}`)
  }
}

function parseRecord(value) {
  fields(value, RECORD_FIELDS)
  const allowedTools = parseNames(value.allowedTools)
  if (allowedTools.length !== value.allowedTools.length) throw new TypeError('duplicate stored tool name')
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new TypeError('invalid updatedAt')
  return {
    sessionId: parseSessionId(value.sessionId),
    allowedTools,
    revision: parseRevision(value.revision),
    updatedAt: value.updatedAt,
  }
}

function parseResult(value) {
  if (value?.ok === false) {
    fields(value, ['ok', 'error'])
    fields(value.error, ['code', 'message'])
    nonempty(value.error.code, 'error code')
    nonempty(value.error.message, 'error message')
    return value
  }
  fields(value, STATE_FIELDS)
  if (typeof value.enabled !== 'boolean' || typeof value.storageReady !== 'boolean') {
    throw new TypeError('enabled and storageReady must be booleans')
  }
  parseSessionId(value.sessionId)
  parseNames(value.allowedTools)
  parseRevision(value.revision)
  return value
}

/** Client mirror lives in the host's non-ESM web bundle. Keep contract parity tested. */
export function createSessionToolsDescriptors() {
  const codec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
  const parameter = (name, typeSymbol, parse) => ({
    name, wire: name, source: 'json', codec: codec(typeSymbol, parse),
  })
  const session = parameter('sessionId', 'SessionId', parseSessionId)
  const names = parameter('allowedTools', 'OrchestratorToolNames', parseNames)
  const revision = parameter('expectedRevision', 'OrchestratorToolsRevision', parseRevision)
  const result = codec('OrchestratorSessionToolsResult', parseResult)
  return Object.entries({ get: [session], set: [session, names, revision], clear: [session, revision] })
    .map(([method, parameters]) => ({
      id: `${SESSION_TOOLS_PACKAGE}/${SESSION_TOOLS_NAMESPACE}/${method}`,
      service: SESSION_TOOLS_NAMESPACE,
      namespace: SESSION_TOOLS_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters,
      result,
    }))
}

const domainSpec = {
  name: SESSION_TOOLS_DOMAIN,
  version: 1,
  layout: 'single',
  tables: { [SESSION_TOOLS_TABLE]: { valueSchema: { parse: parseRecord } } },
}

const errorMessage = (error) => typeof error?.message === 'string' ? error.message : String(error)
const failure = (code, message) => ({ ok: false, error: { code, message } })
const isMissing = (error) => ['SESSION_QUERY_SESSION_NOT_FOUND', 'not-found', 'session-not-found'].includes(error?.code)

function optionalService(ctx, name) {
  try {
    return ctx.get?.(name) ?? ctx[name]
  } catch {
    return undefined
  }
}

/** A live lookup wins; cold sessions can still be addressed by their durable ID. */
async function checkSession(ctx, id) {
  const sessions = optionalService(ctx, 'sessions')
  const liveLookup = typeof sessions?.get === 'function' || typeof sessions?.has === 'function'
  if (typeof sessions?.get === 'function' ? await sessions.get(id) : await sessions?.has?.(id)) return true
  const query = optionalService(ctx, 'sessionQuery')
  if (typeof query?.inspectSession === 'function') {
    try {
      return Boolean(await query.inspectSession(id, () => true))
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }
  return liveLookup ? false : undefined
}

function idOf(subject) {
  return typeof subject === 'string' ? subject : subject?.session?.id ?? subject?.sessionId
}

export function createSessionTools({ facility, ctx = {}, logger, globalAllowedFor = () => [] } = {}) {
  const records = new Map()
  const clearedRevisions = new Map()
  // No tombstones on disk: a new incarnation chooses a different token for an absent row,
  // so a stale client cannot reuse the pre-clear token after a restart (ABA).
  const initialRevision = randomInt(1, 2 ** 48 - 1)
  const reservation = typeof facility?.open === 'function' ? reserveDomain(facility) : undefined
  let domain
  let table
  let storageReady = false
  let stopping = false
  let tail = Promise.resolve()
  let closing
  let storageError = 'Session tools storage is unavailable'

  const warn = (message) => {
    try { logger?.warn?.(`orchestrator: ${message}`) } catch { /* Diagnostics cannot stop teardown. */ }
  }

  const ready = (async () => {
    if (!reservation) return
    await reservation.previous
    if (stopping) return
    try {
      domain = await facility.open(domainSpec)
      const opened = domain.table(SESSION_TOOLS_TABLE)
      const hydrated = new Map()
      for (const [key, value] of opened.entries()) {
        const row = parseRecord(value)
        if (encodeRecordKey(row.sessionId) !== key) throw new Error('Session tools record key does not match its sessionId')
        hydrated.set(row.sessionId, row)
      }
      if (stopping) return
      for (const [id, row] of hydrated) records.set(id, row)
      table = opened
      storageReady = true
    } catch (error) {
      storageError = errorMessage(error)
      warn(`session tools storage could not open: ${storageError}`)
    }
  })()

  function getSessionOverride(sessionId) {
    const row = records.get(sessionId)
    return {
      active: row !== undefined,
      allowedTools: row ? [...row.allowedTools] : [],
      revision: row?.revision ?? clearedRevisions.get(sessionId) ?? initialRevision,
    }
  }

  function resolveAllowedTools(subject, { globalAllowed, allowAgentTeam, catalog, defaultAllowed } = {}) {
    // Undefined means no main-agent whitelist; the existing child mask takes over.
    if (isDelegatedChild(subject)) return undefined
    const override = records.get(idOf(subject))
    return resolveEffectiveAllowedTools(override?.allowedTools ?? globalAllowed, {
      defaults: defaultAllowed, allowAgentTeam, availableTools: catalog,
    })
  }

  function state(sessionId) {
    const { active, allowedTools, revision } = getSessionOverride(sessionId)
    return {
      sessionId,
      enabled: active,
      allowedTools: active ? allowedTools : [...globalAllowedFor()],
      revision,
      storageReady: storageReady && !stopping,
    }
  }

  async function validateSession(sessionId) {
    try {
      if (await checkSession(ctx, sessionId) === false) return failure('SESSION_NOT_FOUND', 'Session does not exist')
    } catch (error) {
      return failure('SESSION_LOOKUP_FAILED', errorMessage(error))
    }
    return undefined
  }

  async function get(sessionId) {
    try { parseSessionId(sessionId) } catch (error) {
      return failure('INVALID_ARGUMENT', errorMessage(error))
    }
    await ready
    return await validateSession(sessionId) ?? state(sessionId)
  }

  function write(operation, sessionId, expectedRevision, value) {
    if (stopping) return Promise.resolve(failure('STORAGE_UNAVAILABLE', storageError))
    const next = tail.then(async () => {
      await ready
      if (!storageReady || stopping) return failure('STORAGE_UNAVAILABLE', storageError)
      const invalidSession = await validateSession(sessionId)
      if (invalidSession) return invalidSession
      const before = getSessionOverride(sessionId)
      if (before.revision !== expectedRevision) return failure('REVISION_CONFLICT', 'Session tools revision changed; reload and try again')
      if (operation === 'clear' && !before.active) return state(sessionId)
      const key = encodeRecordKey(sessionId)
      try {
        const revision = parseRevision(before.revision + 1)
        if (operation === 'clear') {
          parseRecord(records.get(sessionId))
          if (await table.delete(key) === false) throw new Error('Session tools deletion was not confirmed')
          records.delete(sessionId)
          clearedRevisions.set(sessionId, revision)
        } else {
          const row = parseRecord({ sessionId, allowedTools: value, revision, updatedAt: Date.now() })
          if (await table.put(key, row) === false) throw new Error('Session tools write was not confirmed')
          records.set(sessionId, row)
          clearedRevisions.delete(sessionId)
        }
        return state(sessionId)
      } catch (error) {
        if (error?.code === 'unknown-state') {
          storageReady = false
          storageError = errorMessage(error)
        }
        return failure('STORAGE_WRITE_FAILED', errorMessage(error))
      }
    })
    tail = next.then(() => {}, () => {})
    return next
  }

  function set(sessionId, allowedTools, expectedRevision) {
    try {
      return write('set', parseSessionId(sessionId), parseRevision(expectedRevision), parseNames(allowedTools))
    } catch (error) {
      return Promise.resolve(failure('INVALID_ARGUMENT', errorMessage(error)))
    }
  }

  function clear(sessionId, expectedRevision) {
    try {
      return write('clear', parseSessionId(sessionId), parseRevision(expectedRevision))
    } catch (error) {
      return Promise.resolve(failure('INVALID_ARGUMENT', errorMessage(error)))
    }
  }

  function close() {
    if (closing) return closing
    stopping = true
    closing = Promise.all([ready, tail]).then(() => domain?.close()).finally(() => reservation?.release())
    return closing
  }

  return { ready, close, get, set, clear, getSessionOverride, resolveAllowedTools }
}

export function mountSessionToolsRemote(ctx, controller) {
  let unprovide
  let unregister
  let available = false
  let error
  let closing
  const dispose = () => {
    available = false
    if (closing) return closing
    const release = (disposer) => {
      try { return Promise.resolve(disposer?.()) } catch (error) { return Promise.reject(error) }
    }
    closing = Promise.all([release(unregister), release(unprovide)])
    return closing
  }
  try {
    const typert = optionalService(ctx, 'typert')
    if (typeof typert?.register !== 'function' || typeof ctx.provide !== 'function') {
      return { available, error: 'Typert session tools Remote is unavailable', dispose }
    }
    const service = { get: controller.get, set: controller.set, clear: controller.clear }
    // Gateway checks the ordinary public property and the original object's identity.
    // bindTypertRemote would also add ctx.invocation for a service carrying a ctx;
    // this direct, closure-backed service has no ctx and needs no such accessor.
    service.typertRemote = Object.freeze({
      service, serviceKey: SESSION_TOOLS_NAMESPACE, namespace: SESSION_TOOLS_NAMESPACE,
    })
    unprovide = ctx.provide(SESSION_TOOLS_NAMESPACE, service)
    unregister = typert.register({
      package: SESSION_TOOLS_PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: createSessionToolsDescriptors(),
    })
    available = true
  } catch (cause) {
    error = errorMessage(cause)
    void dispose().catch(() => {})
  }
  return { get available() { return available }, error, dispose }
}
