import { randomInt } from 'node:crypto'
import { isDelegatedChild, resolveEffectiveAllowedTools } from './gate.js'
import { encodeRecordKey } from './state-store.js'

export const SESSION_TOOLS_DOMAIN = 'dsh_orchestrator_session_tools'
export const SESSION_TOOLS_TABLE = 'session_allowed_tools'
export const SESSION_TOOLS_PACKAGE = '@sshirkit/dsh-orchestrator'
export const SESSION_TOOLS_NAMESPACE = 'orchestratorSession'

const LEGACY_RECORD_FIELDS = ['sessionId', 'allowedTools', 'revision', 'updatedAt']
const RECORD_FIELDS = ['sessionId', 'config', 'revision', 'updatedAt']
const STATE_FIELDS = ['sessionId', 'enabled', 'allowedTools', 'config', 'revision', 'storageReady']
const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  worktreeIsolationEnabled: true,
  readOnlyEnabled: false,
  peerReadOnlyConsultEnabled: false,
  mainRoute: null,
  workerRoute: null,
  superviseIntervalSeconds: 600,
  superviseMaxNoticesPerChild: 3,
  superviseUnlimited: false,
  allowedTools: Object.freeze([]),
})
const CONFIG_FIELDS = Object.keys(CONFIG_DEFAULTS)
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

function objectRecord(value) {
  const prototype = value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
  return prototype === Object.prototype || prototype === null
}

export function parseSessionRoute(value, field) {
  if (value === null) return null
  if (!objectRecord(value) || !Object.hasOwn(value, 'provider') || !Object.hasOwn(value, 'model') ||
      Object.keys(value).some((key) => !['provider', 'model', 'reasoningEffort'].includes(key))) {
    throw new TypeError(`${field} must be a route with provider, model and optional reasoningEffort, or null`)
  }
  const provider = nonempty(value.provider, `${field}.provider`).trim()
  const model = nonempty(value.model, `${field}.model`).trim()
  if (Object.hasOwn(value, 'reasoningEffort') && typeof value.reasoningEffort !== 'string') {
    throw new TypeError(`${field}.reasoningEffort must be a string`)
  }
  const reasoningEffort = value.reasoningEffort?.trim()
  return { provider, model, ...(reasoningEffort && { reasoningEffort }) }
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer in ${min}..${max}`)
  }
  return value
}

export function parseSessionConfigPatch(value) {
  if (!objectRecord(value)) throw new TypeError('config must be an object')
  const patch = {}
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(CONFIG_DEFAULTS, key)) throw new TypeError(`unknown config field: ${key}`)
    if (typeof CONFIG_DEFAULTS[key] === 'boolean') {
      if (typeof item !== 'boolean') throw new TypeError(`${key} must be a boolean`)
      patch[key] = item
    } else if (key === 'mainRoute' || key === 'workerRoute') {
      patch[key] = parseSessionRoute(item, key)
    } else if (key === 'allowedTools') {
      patch[key] = parseNames(item)
    } else {
      patch[key] = key === 'superviseIntervalSeconds' ? integer(item, key, 10, 86400) : integer(item, key, 0, 20)
    }
  }
  return patch
}

function parseRecord(value) {
  const legacy = value != null && Object.hasOwn(value, 'allowedTools')
  fields(value, legacy ? LEGACY_RECORD_FIELDS : RECORD_FIELDS)
  const config = legacy ? { allowedTools: parseNames(value.allowedTools) } : parseSessionConfigPatch(value.config)
  const storedNames = legacy ? value.allowedTools : value.config.allowedTools
  if (config.allowedTools?.length !== storedNames?.length) throw new TypeError('duplicate stored tool name')
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new TypeError('invalid updatedAt')
  return {
    sessionId: parseSessionId(value.sessionId),
    config,
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
  fields(value.config, CONFIG_FIELDS)
  const config = parseSessionConfigPatch(value.config)
  const allowedTools = parseNames(value.allowedTools)
  if (allowedTools.length !== value.allowedTools.length || allowedTools.length !== value.config.allowedTools.length ||
      !allowedTools.every((name, index) => config.allowedTools[index] === name)) {
    throw new TypeError('allowedTools must match config.allowedTools exactly')
  }
  parseRevision(value.revision)
  return { ...value, allowedTools, config }
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
  const config = parameter('config', 'OrchestratorSessionConfigPatch', parseSessionConfigPatch)
  const result = codec('OrchestratorSessionToolsResult', parseResult)
  const methods = { get: [session], set: [session, names, revision], setConfig: [session, config, revision],
    clear: [session, revision] }
  return Object.entries(methods)
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

export function rootSessionIdOf(subject) {
  if (typeof subject === 'string') return subject
  const session = subject?.session
  const header = session?.header
  const id = session?.id ?? subject?.sessionId ?? subject?.id
  return isDelegatedChild(subject) ? header?.rootSessionId ?? header?.parentSession ?? id : id
}

export function createSessionTools({
  facility, ctx = {}, logger, globalConfigFor = () => ({}), globalAllowedFor, onConfigChanged,
} = {}) {
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

  function parentRootId(subject) {
    const lookup = (id) => optionalService(ctx, 'agents')?.get?.(id) ?? {
      session: optionalService(ctx, 'sessions')?.get?.(id), sessionId: id,
    }
    let agent = typeof subject === 'string' ? lookup(subject) : subject
    if (!isDelegatedChild(agent)) return rootSessionIdOf(agent)
    try {
      const rootId = optionalService(ctx, 'subagents')?.rootOf?.(agent)?.id
      if (rootId) return rootId
    } catch {
      // Creation and cold recovery can resolve the parent before the runtime owner is registered.
    }
    const seen = new Set()
    while (isDelegatedChild(agent)) {
      const id = rootSessionIdOf(agent)
      if (!id || seen.has(id)) return undefined
      seen.add(id)
      agent = lookup(id)
    }
    return rootSessionIdOf(agent)
  }

  function resolveSessionConfig(subject) {
    const global = { ...CONFIG_DEFAULTS, mainRoute: currentMainRoute(), ...globalConfigFor() }
    // A profile written by an older release may still carry a fractional interval.
    for (const [field, min, max] of [['superviseIntervalSeconds', 10, 86400], ['superviseMaxNoticesPerChild', 0, 20]]) {
      if (!Number.isInteger(global[field]) || global[field] < min || global[field] > max) global[field] = CONFIG_DEFAULTS[field]
    }
    const patch = records.get(parentRootId(subject))?.config
    const config = {
      ...global,
      ...patch,
      mainRoute: patch?.mainRoute ?? global.mainRoute,
      workerRoute: patch?.workerRoute ?? global.workerRoute,
      allowedTools: parseNames(patch?.allowedTools ?? globalAllowedFor?.() ?? global.allowedTools),
    }
    return parseSessionConfigPatch(config)
  }

  function getSessionOverride(sessionId) {
    const row = records.get(sessionId)
    return {
      active: row !== undefined,
      allowedTools: [...(row?.config.allowedTools ?? [])],
      revision: row?.revision ?? clearedRevisions.get(sessionId) ?? initialRevision,
    }
  }

  function resolveAllowedTools(subject, { globalAllowed, allowAgentTeam, catalog, defaultAllowed } = {}) {
    // Undefined means no main-agent whitelist; the existing child mask takes over.
    if (isDelegatedChild(subject)) return undefined
    const override = records.get(parentRootId(subject))?.config
    return resolveEffectiveAllowedTools(override?.allowedTools ?? globalAllowed, {
      defaults: defaultAllowed, allowAgentTeam, availableTools: catalog,
    })
  }

  function currentMainRoute() {
    try {
      const route = optionalService(ctx, 'agentDefaultModel')?.currentSelection?.()
      return route === undefined ? null : parseSessionRoute(route, 'mainRoute')
    } catch {
      return null
    }
  }

  function selectMainRoute(agent, route) {
    if (stopping || !agent || isDelegatedChild(agent) || route === null) return
    try {
      // The host captures the selection once per step; select does not disturb a prepared request.
      agent.model?.select?.(route)
    } catch (error) {
      warn(`cannot select session main route for ${agent.id}: ${errorMessage(error)}`)
    }
  }

  function restoreMainRoute(agent) {
    const route = records.get(rootSessionIdOf(agent))?.config?.mainRoute
    if (route) selectMainRoute(agent, route)
  }

  function state(sessionId) {
    const { active, revision } = getSessionOverride(sessionId)
    const config = resolveSessionConfig(sessionId)
    return {
      sessionId,
      enabled: active,
      allowedTools: config.allowedTools,
      config,
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
      const previous = records.get(sessionId)
      const changes = value ?? {}
      if (changes.mainRoute) {
        try {
          await optionalService(ctx, 'llm')?.resolveCallConfig?.({ ...changes.mainRoute })
        } catch (error) {
          return failure('INVALID_MAIN_ROUTE', errorMessage(error))
        }
        if (stopping) return failure('STORAGE_UNAVAILABLE', storageError)
      }
      const key = encodeRecordKey(sessionId)
      try {
        const revision = parseRevision(before.revision + 1)
        if (operation === 'clear') {
          parseRecord(records.get(sessionId))
          if (await table.delete(key) === false) throw new Error('Session tools deletion was not confirmed')
          records.delete(sessionId)
          clearedRevisions.set(sessionId, revision)
        } else {
          const row = parseRecord({ sessionId, config: { ...previous?.config, ...changes }, revision, updatedAt: Date.now() })
          if (await table.put(key, row) === false) throw new Error('Session tools write was not confirmed')
          records.set(sessionId, row)
          clearedRevisions.delete(sessionId)
        }
      } catch (error) {
        if (error?.code === 'unknown-state') {
          storageReady = false
          storageError = errorMessage(error)
        }
        return failure('STORAGE_WRITE_FAILED', errorMessage(error))
      }
      if (!stopping) {
        if (operation === 'clear' || Object.hasOwn(changes, 'mainRoute')) {
          const agent = optionalService(ctx, 'agents')?.get?.(sessionId)
          selectMainRoute(agent, changes.mainRoute ?? currentMainRoute())
        }
        try {
          onConfigChanged?.(sessionId)
        } catch (error) {
          warn(`cannot refresh session config for ${sessionId}: ${errorMessage(error)}`)
        }
      }
      return state(sessionId)
    })
    tail = next.then(() => {}, () => {})
    return next
  }

  function setConfig(sessionId, config, expectedRevision) {
    try {
      return write('set', parseSessionId(sessionId), parseRevision(expectedRevision), parseSessionConfigPatch(config))
    } catch (error) {
      return Promise.resolve(failure('INVALID_ARGUMENT', errorMessage(error)))
    }
  }

  function set(sessionId, allowedTools, expectedRevision) {
    return setConfig(sessionId, { allowedTools }, expectedRevision)
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

  return {
    ready, close, get, set, setConfig, clear, getSessionOverride, resolveAllowedTools, resolveSessionConfig,
    currentMainRoute, selectMainRoute, restoreMainRoute, resolveRootId: parentRootId,
  }
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
    const service = {
      get: controller.get, set: controller.set, setConfig: controller.setConfig, clear: controller.clear,
    }
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
