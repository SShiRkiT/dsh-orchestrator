window.__ModuleLoader__.load({
  id: '@sshirkit/dsh-orchestrator',
  factory: (load) => {
    const module = { exports: {} }
    ;(function (module, exports, require) {
      'use strict'
      const React = require('react')
      // The host's client module loader registers `react-dom` beside `react`; the guard keeps a
      // host that does not from taking the whole bundle down (the list then renders in place).
      let ReactDOM = null
      try {
        ReactDOM = require('react-dom')
      } catch {
        ReactDOM = null
      }

      const NS = 'orchestrator'

      const zh = {
        'route.button': '调度模式',
        'route.title': '主代理与子代理的默认模型',
        'route.main': '主代理',
        'route.worker': '子代理',
        'route.effort': '推理强度',
        'route.effortDefault': '模型默认',
        'route.unset': '未设置',
        'route.loading': '正在加载模型目录…',
        'route.catalogFailed': '无法加载模型目录',
        'route.readonly': '当前不可写，无法保存',
        'route.saveFailed': '保存失败',
        'route.note': '主代理的全局默认模型对新会话生效；子代理从下一次委派起使用新路由，可在任务或阶段中显式覆盖。',
        'route.sessionNote': '主代理的新路由在当前会话的下一步生效；子代理从下一次委派起使用新路由。',
        'route.search': '搜索模型…',
        'route.noMatch': '没有匹配的模型',
        'route.noMatchHint': '换个关键词，或清空搜索看全部',
        'route.selected': '当前选中',
        'route.enable': '启用调度模式',
        'route.enableNote': '开启后主代理只做规划、由子代理执行；已打开的会话也会立即生效。',
        'route.enableFailed': '切换失败',
        'worktreeIsolation.label': '默认启用 Git Worktree 隔离',
        'worktreeIsolation.hint': 'Git 仓库中的写任务默认使用独立 Worktree，delegate 按任务隔离，orchestrate 按条目隔离。非 Git 工作区使用写租约协调共享目录中的写入。',
        'allowed.title': 'Allowed Tools',
        'allowed.search': '搜索工具…',
        'allowed.empty': '没有匹配的工具',
        'allowed.reset': '重置',
        'allowed.session': '仅当前会话',
        'allowed.sessionOn': '面板内所有选项仅对当前会话生效。',
        'allowed.sessionOff': '继承全局默认；编辑将修改全局设置。',
        'allowed.sessionMissing': '没有可用于保存的会话。',
        'allowed.sessionLoading': '正在加载会话设置…',
        'allowed.sessionFailed': '无法加载会话设置',
        'allowed.sessionStorage': '会话设置存储不可用。',
        'more.button': '更多',
        'more.title': '更多调度设置',
        'more.close': '关闭',
        'readOnly.label': '启用只读参数',
        'readOnly.hint': '关闭时隐藏 readOnly 参数，并引导模型用 isolation: "shared" 做只读调研。若开启则推荐配合“子代理平级主动通讯”选项一块开启（对应“允许平级询问”开关）。',
        'peerReadOnlyConsult.label': '允许平级询问',
        'peerReadOnlyConsult.hint': '同一会话中的只读子代理可以共享已读索引并互相咨询，主代理不会收到通知。',
        'allowed.hint': '白名单式驱动：勾选 = 允许主代理使用；未勾选（含新插件工具）= 自动禁用。',
        'allowed.nativeBlocked': '按 ADR-0004 默认禁用；建议改用 delegate / orchestrate。显式勾选可覆盖。',
        'allowed.teamDisabled': '调度模式下禁止主代理调用原生 Team 任务板工具（allowAgentTeam: false）。',
        'supervise.label': '子代理巡检间隔（秒）',
        'supervise.hint': '默认 600 秒（10 分钟）。主代理会按此间隔检查运行中的子代理，运行中修改立即生效。范围 10–86400。',
        'supervise.invalid': '请输入 10–86400 之间的整数',
        'supervise.saveFailed': '保存失败',
        'supervise.readonly': '当前不可写，无法保存',
        'supervise.countLabel': '子代理巡检次数',
        'supervise.unlimitedLabel': '无限次数巡检',
        'supervise.countHint': '默认 3 次，设为 0 关闭巡检。开启右侧无限巡检后强制一直巡检，直至子代理停止、交付或结束。范围 0–20。',
        'supervise.countInvalid': '请输入 0–20 之间的整数',
      }
      const en = {
        'route.button': 'Dispatch',
        'route.title': 'Default models for the main agent and subagents',
        'route.main': 'Main agent',
        'route.worker': 'Subagent',
        'route.effort': 'Reasoning effort',
        'route.effortDefault': 'Model default',
        'route.unset': 'Not set',
        'route.loading': 'Loading the model catalog…',
        'route.catalogFailed': 'Could not load the model catalog',
        'route.readonly': 'Not writable right now, cannot save',
        'route.saveFailed': 'Could not save',
        'route.note': 'The global main agent default applies to new sessions. Subagents use the new route from the next delegation, unless a task or stage overrides it.',
        'route.sessionNote': 'The main agent uses the new route on the next step in this session. Subagents use it from the next delegation.',
        'route.search': 'Search models…',
        'route.noMatch': 'No matching models',
        'route.noMatchHint': 'Try another keyword, or clear the search to see everything',
        'route.selected': 'selected',
        'route.enable': 'Enable dispatch mode',
        'route.enableNote': 'The main agent only plans and delegates the work; an open conversation follows the switch immediately.',
        'route.enableFailed': 'Could not switch',
        'worktreeIsolation.label': 'Enable Git Worktree isolation by default',
        'worktreeIsolation.hint': 'By default, write tasks in Git repositories use separate worktrees: one per delegate task or orchestrate item. Non-Git workspaces use write leases to coordinate writes in the shared directory.',
        'allowed.title': 'Allowed Tools',
        'allowed.search': 'Filter tools…',
        'allowed.empty': 'No matching tools',
        'allowed.reset': 'Reset',
        'allowed.session': 'Only for this session',
        'allowed.sessionOn': 'All settings in this panel apply only to this session.',
        'allowed.sessionOff': 'Inherits global defaults; edits change the global settings.',
        'allowed.sessionMissing': 'No session is available for saving.',
        'allowed.sessionLoading': 'Loading session settings…',
        'allowed.sessionFailed': 'Could not load session settings',
        'allowed.sessionStorage': 'Session settings storage is unavailable.',
        'more.button': 'More',
        'more.title': 'More dispatch settings',
        'more.close': 'Close',
        'readOnly.label': 'Enable the read-only parameter',
        'readOnly.hint': 'When off, readOnly is hidden and models are directed to use isolation: "shared" for read-only research. If enabled, we recommend also turning on "Allow peer consultation" for proactive communication between subagents.',
        'peerReadOnlyConsult.label': 'Allow peer consultation',
        'peerReadOnlyConsult.hint': 'Read-only subagents in the same session can share indexes of what they have read and consult each other without notifying the main agent.',
        'allowed.hint': 'Whitelist-driven: checked = allowed for the main agent; unchecked (including new plugin tools) = blocked automatically.',
        'allowed.nativeBlocked': 'Disabled by default under ADR-0004; prefer delegate / orchestrate. Check explicitly to override.',
        'allowed.teamDisabled': 'In dispatch mode, the main agent cannot call native Team task-board tools (allowAgentTeam: false).',
        'supervise.label': 'Subagent check interval (seconds)',
        'supervise.hint': 'Default 600 seconds (10 minutes). The main agent checks running subagents at this interval; changes apply immediately. Range 10–86400.',
        'supervise.invalid': 'Enter an integer between 10 and 86400',
        'supervise.saveFailed': 'Could not save',
        'supervise.readonly': 'Not writable right now, cannot save',
        'supervise.countLabel': 'Subagent check count',
        'supervise.unlimitedLabel': 'Unlimited checks',
        'supervise.countHint': 'Default 3; set 0 to turn checks off. Turn on Unlimited checks to keep checking until the subagent stops, delivers, or ends. Range 0–20.',
        'supervise.countInvalid': 'Enter an integer between 0 and 20',
      }

      const baseStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
      // A lit control borrows the host's brand and ghost-active fills so it reads right in both themes.
      const onStyle = {
        borderColor: 'var(--dsw-alias-brand-primary, #4d8dff)',
        background: 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, #4d8dff 16%, transparent))',
      }
      // ---- Default routes -------------------------------------------------------------------
      // Two stored routes, each a { provider, model, effort } triple under different field names.
      // The main agent's lives in the host's `agent-default-model` entry (read when an agent is
      // created); the workers' lives in this plugin's own entry (read on every delegation).
      // `clear` says how "no effort" is stored. The main agent's field is optional with no
      // empty value, so its override is removed. The subagent field ships a default in the
      // plugin bundle, and removing the override would bring that default back, so it stores ''.
      const MAIN = {
        ns: 'agent-default-model',
        fields: { provider: 'provider', model: 'model', effort: 'reasoningEffort', clear: 'unset' },
      }
      const WORKER = {
        ns: NS,
        fields: { provider: 'workerProvider', model: 'workerModel', effort: 'workerReasoningEffort', clear: 'empty' },
      }

      const routeKey = (provider, model) => JSON.stringify([provider, model])

      function parseRouteKey(key) {
        try {
          const v = JSON.parse(key)
          return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string'
            ? { provider: v[0], model: v[1] }
            : undefined
        } catch {
          return undefined
        }
      }

      /** Read a stored route out of a config section; absent fields read as empty. */
      function routeOf(fields, value) {
        const get = (name) => (typeof value?.[name] === 'string' ? value[name] : '')
        return { provider: get(fields.provider), model: get(fields.model), effort: get(fields.effort) }
      }

      /** No effort lets the model resolve its own default; `fields.clear` says how that is stored. */
      function routeOps(fields, route) {
        const cleared = fields.clear === 'empty' ? { op: 'set', path: [fields.effort], value: '' } : { op: 'unset', path: [fields.effort] }
        return [
          { op: 'set', path: [fields.provider], value: route.provider },
          { op: 'set', path: [fields.model], value: route.model },
          route.effort === '' ? cleared : { op: 'set', path: [fields.effort], value: route.effort },
        ]
      }

      /** The catalog entry for a stored route, or undefined when it is not offered any more. */
      function findModel(groups, route) {
        for (const group of groups) {
          if (group.id !== route.provider) continue
          const model = group.models.find((m) => m.id === route.model)
          if (model !== undefined) return model
        }
        return undefined
      }

      /**
       * Narrow the catalog to what a free-text query matches. A provider name matches every model it
       * offers; otherwise model ids and display names are matched. An empty query is the whole catalog.
       */
      function filterGroups(groups, query) {
        const needle = query.trim().toLowerCase()
        if (needle === '') return groups
        const hit = (text) => text.toLowerCase().includes(needle)
        const matched = new Map()
        const kept = []
        for (const group of groups) {
          if (hit(group.id) || hit(group.name ?? '')) {
            kept.push(group)
            matched.set(group.id, group.models.length)
            continue
          }
          const models = group.models.filter((model) => hit(model.id) || hit(model.name ?? ''))
          if (models.length === 0) continue
          matched.set(group.id, models.length)
          kept.push(models.length === group.models.length ? group : { ...group, models })
        }
        return kept
      }

      /** How many models a catalog holds, for the match counter next to the filter. */
      function countModels(groups) {
        return groups.reduce((total, group) => total + group.models.length, 0)
      }

      /** Write one route and confirm it landed. Returns an error message, or null on success. */
      async function saveRoute(scope, fields, route, t) {
        const snapshot = scope.getSnapshot()
        if (snapshot.status !== 'ready' || !snapshot.writable) return t('route.readonly')
        try {
          await scope.mutate(routeOps(fields, route), snapshot.revision)
        } catch (reason) {
          // Not `instanceof Error`: remote failures can be plain { code, message } objects.
          return typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('route.saveFailed')
        }
        const stored = routeOf(fields, scope.getSnapshot().value)
        const landed =
          stored.provider === route.provider && stored.model === route.model && stored.effort === route.effort
        return landed ? null : t('route.saveFailed')
      }

      // ---- Supervision interval -------------------------------------------------------------
      // The host stores `superviseIntervalSeconds` as a number with a schema default, so a
      // missing value, a string, a fraction, or a number out of range all read as the default.
      const INTERVAL = { key: 'superviseIntervalSeconds', min: 10, max: 86400, fallback: 600 }

      /** The stored interval when it is a valid integer, else the schema default of 600. */
      function intervalOf(value) {
        const raw = value?.[INTERVAL.key]
        return typeof raw === 'number' && Number.isInteger(raw) && raw >= INTERVAL.min && raw <= INTERVAL.max
          ? raw
          : INTERVAL.fallback
      }

      /**
       * Parse a typed interval. Trimmed text only: digits, no sign, no decimal point, no
       * exponent. An empty field means "back to the default", which is written as 600.
       */
      function parseInterval(text) {
        const trimmed = String(text ?? '').trim()
        if (trimmed === '') return { ok: true, seconds: INTERVAL.fallback, empty: true }
        if (!/^[0-9]+$/.test(trimmed)) return { ok: false, empty: false }
        const seconds = Number(trimmed)
        if (!Number.isSafeInteger(seconds) || seconds < INTERVAL.min || seconds > INTERVAL.max) {
          return { ok: false, empty: false }
        }
        return { ok: true, seconds, empty: false }
      }

      // ---- Supervision notice count ---------------------------------------------------------
      // `superviseMaxNoticesPerChild` caps how many patrol notices one child may trigger; 0
      // turns patrol off entirely. `superviseUnlimited` overrides the cap and keeps checking
      // until the child stops, delivers, or ends. Both are volatile host config fields.
      const PATROL_COUNT = {
        key: 'superviseMaxNoticesPerChild',
        unlimitedKey: 'superviseUnlimited',
        min: 0,
        max: 20,
        fallback: 3,
      }

      /** The stored notice count when it is a valid integer in range, else the default of 3. */
      function patrolCountOf(value) {
        const raw = value?.[PATROL_COUNT.key]
        return typeof raw === 'number' &&
          Number.isInteger(raw) &&
          raw >= PATROL_COUNT.min &&
          raw <= PATROL_COUNT.max
          ? raw
          : PATROL_COUNT.fallback
      }

      /** Whether unlimited patrol is switched on. Only a literal `true` counts. */
      function unlimitedOf(value) {
        return value?.[PATROL_COUNT.unlimitedKey] === true
      }

      /**
       * Parse a typed notice count. Trimmed text only: digits, no sign, no decimal point.
       * An empty field means "back to the default", which is written as 3.
       */
      function parsePatrolCount(text) {
        const trimmed = String(text ?? '').trim()
        if (trimmed === '') return { ok: true, count: PATROL_COUNT.fallback, empty: true }
        if (!/^[0-9]+$/.test(trimmed)) return { ok: false, empty: false }
        const count = Number(trimmed)
        if (!Number.isSafeInteger(count) || count < PATROL_COUNT.min || count > PATROL_COUNT.max) {
          return { ok: false, empty: false }
        }
        return { ok: true, count, empty: false }
      }

      // ---- Allowed tools --------------------------------------------------------------------
      // The base whitelist mirrors DEFAULT_ALLOWED_TOOLS in lib/tool-surface.js. ADR-0004's
      // optional Team tools and default-blocked native tools mirror lib/gate.js.
      // A web client plugin has no API that enumerates host tools — the session remote offers
      // session/model/skill methods only, and configForms exposes this plugin's own config — so
      // the plugin's server half collects the live catalog and publishes it as the volatile
      // `toolCatalog` field of that same config (lib/catalog.js). The panel renders the union
      // of that catalog, this shipped list and the config key; the shipped copy is also
      // the fallback on a host that publishes nothing. A unit test keeps this copy equal to the
      // host constant, so the two cannot drift apart.
      const DEFAULT_ALLOWED_TOOLS = [
        'delegate',
        'orchestrate',
        'delegate_status',
        'worktree_manage',
        'send_message',
        'interrupt_agent',
        'todo_write',
        'ask_user_question',
        'compress',
      ]
      const NATIVE_TEAM_TOOLS = [
        'team_task_create',
        'team_task_list',
        'team_task_get',
        'team_task_update',
      ]
      const DEFAULT_BLOCKED_NATIVE_TOOLS = ['subagent_fork', 'workflow']
      /** The whitelist key the panel reads and writes, and the Team compatibility switch it reads. */
      const ALLOW_KEY = 'allowedTools'
      const ALLOW_AGENT_TEAM_KEY = 'allowAgentTeam'
      /** The read-only config field the host publishes the live catalog into. */
      const CATALOG_KEY = 'toolCatalog'

      /** A string array config field, tolerating a missing or oddly shaped value. */
      function namesOf(value, key) {
        const raw = value?.[key]
        return Array.isArray(raw) ? raw.filter((name) => typeof name === 'string' && name !== '') : []
      }

      /**
       * The live catalog the server half published: every tool the running host offers,
       * including the ones other plugins and MCP servers registered. Absent (or empty) on
       * an older host or before the first publish, which leaves the shipped list alone.
       */
      function catalogOf(value) {
        return namesOf(value, CATALOG_KEY)
      }

      /**
       * The catalog to render. A settings write commits the profile's raw value into every
       * volatile field the Loader was handed (lib/catalog.js), so for the instant between
       * that commit and the plugin publishing the catalog again the panel would read an
       * empty list and drop back to its shipped-name fallback. An empty read is never a real
       * catalog, so the last non-empty one stands in for it.
       */
      function catalogFor(value, remembered) {
        const live = catalogOf(value)
        return live.length > 0 ? live : remembered ?? []
      }

      function shippedToolsOf(catalog, allowAgentTeam = true) {
        const team = allowAgentTeam === false ? [] : NATIVE_TEAM_TOOLS.filter((name) => catalog.includes(name))
        return [...DEFAULT_ALLOWED_TOOLS, ...team]
      }

      /**
       * The base whitelist and registered Team support come first. Other catalog or profile
       * names are listed alphabetically, including native tools a profile can opt in to.
       */
      function toolListOf(value, catalog = catalogOf(value)) {
        const listed = shippedToolsOf(catalog)
        const seen = new Set(listed)
        const extras = new Set()
        for (const name of catalog) {
          if (seen.has(name)) continue
          extras.add(name)
        }
        for (const name of namesOf(value, ALLOW_KEY)) {
          if (seen.has(name)) continue
          extras.add(name)
        }
        return [...listed, ...[...extras].sort((a, b) => a.localeCompare(b))]
      }

      /**
       * Mirrors the host's resolveEffectiveAllowedTools() for the settings catalog. An
       * explicit array replaces the defaults (`[]` included); the Team switch can suppress
       * Team names even when they were explicitly stored.
       */
      function allowedSetOf(value, catalog = catalogOf(value)) {
        const allowAgentTeam = value?.[ALLOW_AGENT_TEAM_KEY]
        if (!Array.isArray(value?.[ALLOW_KEY])) return new Set(shippedToolsOf(catalog, allowAgentTeam))
        const names = namesOf(value, ALLOW_KEY)
        return new Set(allowAgentTeam === false ? names.filter((name) => !NATIVE_TEAM_TOOLS.includes(name)) : names)
      }

      /** Case-insensitive substring match on the tool name; an empty query keeps every row. */
      function filterTools(names, query) {
        const needle = String(query ?? '').trim().toLowerCase()
        if (needle === '') return names
        return names.filter((name) => name.toLowerCase().includes(needle))
      }

      /**
       * A set equal to the current defaults clears the override. While Team is switched
       * off, changing another checkbox must not discard a stored Team preference.
       */
      function allowOps(checked, value, catalog = catalogOf(value)) {
        const allowAgentTeam = value?.[ALLOW_AGENT_TEAM_KEY]
        const next = new Set(checked)
        if (allowAgentTeam === false) {
          for (const name of namesOf(value, ALLOW_KEY)) {
            if (NATIVE_TEAM_TOOLS.includes(name)) next.add(name)
          }
        }
        const list = [...next]
        const defaults = shippedToolsOf(catalog, allowAgentTeam)
        const isDefault = list.length === defaults.length && defaults.every((name) => next.has(name))
        return [isDefault ? { op: 'unset', path: [ALLOW_KEY] } : { op: 'set', path: [ALLOW_KEY], value: list }]
      }

      /** Back to the shipped list: the key cleared, so the schema default applies again. */
      function resetAllowOps() {
        return [{ op: 'unset', path: [ALLOW_KEY] }]
      }

      // The Web ModuleLoader loads this factory as a script, not as ESM. Mirror the
      // host's descriptor browser-side and check the complete wire contract in tests.
      const SESSION_REMOTE_PACKAGE = '@sshirkit/dsh-orchestrator'
      const SESSION_REMOTE = 'orchestratorSession'
      const SESSION_REMOTE_INJECT = `remote.${SESSION_REMOTE}`
      function createSessionToolsDescriptors() {
        const nonempty = (value, field) => {
          if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
          return value
        }
        const parseSession = (value) => nonempty(value, 'sessionId')
        const parseNames = (value) => {
          if (!Array.isArray(value)) throw new TypeError('allowedTools must be an array')
          return [...new Set(Array.from(value, (name) => nonempty(name, 'tool name')))]
        }
        const parseRevision = (value) => {
          if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('revision must be a non-negative safe integer')
          return value
        }
        const isObject = (value) => value !== null && typeof value === 'object'
        const objectRecord = (value) => {
          const prototype = isObject(value) ? Object.getPrototypeOf(value) : undefined
          return prototype === Object.prototype || prototype === null
        }
        const fields = (value, names) => {
          if (!isObject(value) || Array.isArray(value) || Object.keys(value).length !== names.length ||
              !names.every((key) => Object.hasOwn(value, key))) {
            throw new TypeError(`expected record with fields ${names.join(', ')}`)
          }
        }
        const boolean = (value, field) => {
          if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
          return value
        }
        const integer = (value, { key, min, max }) => {
          if (!Number.isInteger(value) || value < min || value > max) {
            throw new TypeError(`${key} must be an integer in ${min}..${max}`)
          }
          return value
        }
        const parseRoute = (value, field) => {
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
        const configParsers = {
          enabled: boolean,
          worktreeIsolationEnabled: boolean,
          readOnlyEnabled: boolean,
          peerReadOnlyConsultEnabled: boolean,
          mainRoute: parseRoute,
          workerRoute: parseRoute,
          superviseIntervalSeconds: (value) => integer(value, INTERVAL),
          superviseMaxNoticesPerChild: (value) => integer(value, PATROL_COUNT),
          superviseUnlimited: boolean,
          allowedTools: parseNames,
        }
        const parseConfigPatch = (value) => {
          if (!objectRecord(value)) throw new TypeError('config must be an object')
          return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if (!Object.hasOwn(configParsers, key)) throw new TypeError(`unknown config field: ${key}`)
            return [key, configParsers[key](item, key)]
          }))
        }
        const parseResult = (value) => {
          if (value?.ok === false) {
            fields(value, ['ok', 'error'])
            fields(value.error, ['code', 'message'])
            nonempty(value.error.code, 'error code')
            nonempty(value.error.message, 'error message')
            return value
          }
          fields(value, ['sessionId', 'enabled', 'allowedTools', 'config', 'revision', 'storageReady'])
          if (typeof value.enabled !== 'boolean' || typeof value.storageReady !== 'boolean') {
            throw new TypeError('enabled and storageReady must be booleans')
          }
          parseSession(value.sessionId)
          fields(value.config, Object.keys(configParsers))
          const config = parseConfigPatch(value.config)
          const allowedTools = parseNames(value.allowedTools)
          if (allowedTools.length !== value.allowedTools.length || allowedTools.length !== value.config.allowedTools.length ||
              !allowedTools.every((name, index) => config.allowedTools[index] === name)) {
            throw new TypeError('allowedTools must match config.allowedTools exactly')
          }
          parseRevision(value.revision)
          return { ...value, allowedTools, config }
        }
        const codec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
        const parameter = (name, typeSymbol, parse) => ({
          name, wire: name, source: 'json', codec: codec(typeSymbol, parse),
        })
        const session = parameter('sessionId', 'SessionId', parseSession)
        const names = parameter('allowedTools', 'OrchestratorToolNames', parseNames)
        const revision = parameter('expectedRevision', 'OrchestratorToolsRevision', parseRevision)
        const config = parameter('config', 'OrchestratorSessionConfigPatch', parseConfigPatch)
        const result = codec('OrchestratorSessionToolsResult', parseResult)
        return Object.entries({
          get: [session], set: [session, names, revision], setConfig: [session, config, revision], clear: [session, revision],
        })
          .map(([method, parameters]) => ({
            id: `${SESSION_REMOTE_PACKAGE}/${SESSION_REMOTE}/${method}`,
            service: SESSION_REMOTE,
            namespace: SESSION_REMOTE,
            method,
            invocation: { kind: 'direct' },
            parameters,
            result,
          }))
      }

      function mountSessionRemote(ctx) {
        const unavailable = () => new Error('Session tools Remote is unavailable')
        let stopped = false
        let service
        let unmount
        let injectFiber
        let injectTimeout
        let closing
        let resolveReady, rejectReady
        const ready = new Promise((resolve, reject) => {
          resolveReady = resolve
          rejectReady = reject
        })
        const setup = Promise.resolve().then(async () => {
          if (stopped || typeof ctx.remote?.$mount !== 'function') throw unavailable()
          unmount = await ctx.remote.$mount({
            package: SESSION_REMOTE_PACKAGE,
            descriptors: createSessionToolsDescriptors(),
          })
          if (typeof unmount !== 'function') throw new Error('Session tools Remote registration was not confirmed')
          if (stopped) return
          if (typeof ctx.inject !== 'function') {
            service = typeof ctx.get === 'function' ? ctx.get(SESSION_REMOTE_INJECT) : ctx.remote?.[SESSION_REMOTE]
            if (!service) throw unavailable()
            resolveReady()
            return
          }

          injectTimeout = setTimeout(() => {
            rejectReady(new Error('Timed out waiting for Session tools Remote injection'))
          }, 5000)
          injectFiber = ctx.inject([SESSION_REMOTE_INJECT], (scopedCtx) => {
            if (stopped) return
            try {
              const injected = scopedCtx.remote[SESSION_REMOTE]
              if (!injected) throw unavailable()
              scopedCtx.on('dispose', () => {
                if (service === injected) service = undefined
              })
              service = injected
              // Cordis fibers are thenable. Wait for activation after the callback binds the service.
              void activation.then(resolveReady, rejectReady)
            } catch (error) {
              rejectReady(error)
            }
          })
        })
        const activation = setup.then(() => injectFiber)
        void activation.catch(rejectReady)
        void ready.then(() => clearTimeout(injectTimeout), () => dispose().catch(() => {}))

        function dispose() {
          if (closing) return closing
          stopped = true
          service = undefined
          clearTimeout(injectTimeout)
          rejectReady(unavailable())
          // Wait only for setup to acquire the handles. Activation may still be pending.
          closing = setup.catch(() => {}).then(async () => {
            try {
              await injectFiber?.dispose?.()
            } finally {
              if (typeof unmount === 'function') await unmount()
            }
          })
          return closing
        }

        return {
          async call(method, sessionId, ...args) {
            await ready
            if (typeof service?.[method] !== 'function') throw unavailable()
            const { ok, value, error } = await service[method](sessionId, ...args)
            if (ok !== true) throw error ?? new Error('Session tools Remote call failed')
            if (value?.ok === false) throw value.error
            if (value?.sessionId !== sessionId) throw new Error('Session tools Remote returned a different session')
            return value
          },
          dispose,
        }
      }

      function toSessionRoute({ provider, model, effort }) {
        if (!provider.trim() || !model.trim()) return null
        return { provider, model, ...(effort.trim() === '' ? {} : { reasoningEffort: effort }) }
      }

      function fromSessionRoute(route) {
        return { provider: route?.provider ?? '', model: route?.model ?? '', effort: route?.reasoningEffort ?? '' }
      }

      function createGlobalSnapshot(plugin, main, worker, catalog = catalogOf(plugin)) {
        return {
          enabled: plugin?.enabled ?? true,
          worktreeIsolationEnabled: worktreeIsolationOf(plugin),
          readOnlyEnabled: plugin?.readOnlyEnabled === true,
          peerReadOnlyConsultEnabled: plugin?.peerReadOnlyConsultEnabled === true,
          mainRoute: toSessionRoute(routeOf(MAIN.fields, main)),
          workerRoute: toSessionRoute(routeOf(WORKER.fields, worker)),
          superviseIntervalSeconds: intervalOf(plugin),
          superviseMaxNoticesPerChild: patrolCountOf(plugin),
          superviseUnlimited: unlimitedOf(plugin),
          allowedTools: [...allowedSetOf(plugin, catalog)],
        }
      }

      function writable(snapshot) {
        return snapshot.status === 'ready' && snapshot.writable === true
      }

      function useSessionConfig(sessionId, remote, open, t) {
        const active = React.useRef(null)
        const [view, setView] = React.useState(null)
        const scoped = remote !== undefined || sessionId !== undefined
        const validId = typeof sessionId === 'string' && sessionId.trim() !== ''
        const available = validId && Boolean(remote)
        const display = view?.sessionId === sessionId && view?.remote === remote ? view : null
        const state = display?.state
        const loading = available && (!display?.loaded || display.loading)
        const saving = display?.saving === true

        const render = (request) => {
          if (active.current === request) setView({ ...request })
        }
        React.useEffect(() => {
          const request = { sessionId, remote, loaded: false, loading: false, saving: false }
          active.current = request
          return () => { if (active.current === request) active.current = null }
        }, [sessionId, remote])
        React.useEffect(() => {
          if (!open || !available) return
          const request = active.current
          if (request.loading || request.saving) return
          request.loading = true
          request.problem = null
          render(request)
          Promise.resolve().then(() => remote.call('get', sessionId)).then((next) => {
            request.state = next
          }, (error) => {
            if (request.state) request.state = { ...request.state, storageReady: false }
            request.problem = error?.message || t('allowed.sessionFailed')
          }).finally(() => {
            request.loaded = true
            request.loading = false
            render(request)
          })
        }, [sessionId, remote, open])

        const write = async (method, config) => {
          const request = active.current
          if (request?.sessionId !== sessionId || request?.remote !== remote ||
              request?.state?.storageReady !== true || request.loading || request.saving) return t('route.readonly')
          request.saving = true
          request.problem = null
          render(request)
          try {
            const { revision } = request.state
            request.state = method === 'clear'
              ? await remote.call('clear', sessionId, revision)
              : await remote.call('setConfig', sessionId, config, revision)
            return null
          } catch (error) {
            if (active.current === request && ['REVISION_CONFLICT', 'STORAGE_UNAVAILABLE', 'STORAGE_WRITE_FAILED'].includes(error?.code)) {
              try {
                request.state = await remote.call('get', sessionId)
              } catch {
                request.state = { ...request.state, storageReady: false }
              }
            }
            request.problem = error?.message || t('route.saveFailed')
            return request.problem
          } finally {
            request.saving = false
            render(request)
          }
        }
        const problem = display?.problem || (scoped && !validId ? t('allowed.sessionMissing')
          : scoped && !remote ? t('allowed.sessionFailed')
            : state?.storageReady === false ? t('allowed.sessionStorage') : null)
        return { state, loading, saving, problem, write }
      }

      const h = React.createElement
      const panelBorder = '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))'
      const popoverSurface = {
        boxSizing: 'border-box',
        borderRadius: '12px',
        border: panelBorder,
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        fontSize: '12px',
      }
      const panelWidth = 574
      // The original left column keeps its width where the viewport allows; the
      // tools sit to its right and neither column can grow outside the viewport.
      const panelStyle = {
        ...popoverSurface,
        position: 'fixed',
        zIndex: 1090,
        width: `min(${panelWidth}px, calc(100vw - 16px))`,
        display: 'flex',
        alignItems: 'stretch',
        overflow: 'hidden',
        visibility: 'hidden',
      }
      const topInsetProbeStyle = {
        position: 'absolute',
        visibility: 'hidden',
        pointerEvents: 'none',
        width: 0,
        height: 'var(--dsh-frame-overlay-top, 0px)',
      }
      const headingRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }
      const sessionSeparatorStyle = { borderTop: panelBorder, marginBlock: '2px' }
      const moreOverlayStyle = {
        position: 'fixed',
        inset: 0,
        zIndex: 1110,
        display: 'grid',
        placeItems: 'center',
        padding: '12px',
        background: 'rgba(0, 0, 0, .25)',
      }
      const morePanelStyle = {
        ...popoverSurface,
        width: 'min(100%, 400px)',
        maxHeight: '100%',
        minHeight: 0,
        display: 'grid',
        gap: '12px',
        padding: '14px',
        overflowY: 'auto',
      }

      function portalToBody(node) {
        if (node === null || typeof ReactDOM?.createPortal !== 'function' || typeof document === 'undefined' || !document.body) {
          return node
        }
        return ReactDOM.createPortal(node, document.body)
      }
      const panelColumnStyle = {
        flex: '340 1 0px',
        minWidth: 0,
        minHeight: 0,
        padding: '12px',
        display: 'grid',
        // One column pinned to the column's own width: with the implicit `auto` track a vertical
        // scrollbar ate ~15px and the grid then overflowed sideways, which is what drew a
        // horizontal scrollbar along the bottom of the left column.
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: '8px',
        alignContent: 'start',
        boxSizing: 'border-box',
        // Only reachable under the `maxHeight` guard above, where the column is shorter than
        // its own grid content. Vertical only: the grid track above keeps the width in check.
        overflowY: 'auto',
        overflowX: 'hidden',
        // The divider is the original panel's own outline, kept as its right border.
        borderRight: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
      }
      const allowedColumnStyle = {
        flex: '232 1 0px',
        minWidth: 0,
        overflow: 'hidden auto',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: 0,
        boxSizing: 'border-box',
        // `contain: size` is the load-bearing part. The popover is a row flex box with an auto
        // height, so it sizes its cross axis from the children's intrinsic heights, and CSS
        // Flexbox §9.9.1 measures a column container's intrinsic main size from the children's
        // max-content contributions: neither `flex-basis: 0` nor `height: 0` stops fifty tool
        // rows from reporting ~1400px there. Size containment makes this column measure its
        // own height as 0 (padding only) during that pass, so the left column alone decides the
        // popover height; the stretch alignment then hands the column that exact height, and
        // the row stack inside scrolls.
        contain: 'size',
      }
      // The rows live in a card that mirrors the model dropdown: a search row on top and a
      // scrolling option list under it.
      //
      // The card grows into whatever height the stretched column is given and never reports a
      // content height of its own: `flex: 1 1 0px` (a definite basis, not a percentage, so it
      // cannot degrade to `content` while the column's height is still indefinite) plus the
      // size containment repeated here keep a fifty-tool catalog from stretching the popover.
      const allowedListBoxStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '6px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        flex: '1 1 0px',
        minHeight: '84px',
        boxSizing: 'border-box',
        contain: 'size',
      }
      const allowedListStyle = {
        display: 'grid',
        // One column pinned to the box's own width: an implicit `auto` track would be sized
        // by the longest unbreakable tool name and scroll the list sideways.
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: '2px',
        alignContent: 'start',
        // Same reasoning one level down: a zero pixel basis keeps the row stack out of the
        // card's intrinsic height, and the rows scroll inside it instead.
        flex: '1 1 0px',
        minHeight: 0,
        overflowY: 'auto',
        paddingRight: '2px',
        contain: 'size',
      }
      // One row per tool: the checkbox leads, so a long tool name can never push it out of
      // the 232px column; the name then takes whatever width is left and ellipsises.
      const allowedRowStyle = (allowed) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: allowed ? 600 : 400,
        // The row is a grid item with an automatic minimum size, which long content would
        // otherwise widen past the column; zero lets the name truncate instead.
        minWidth: 0,
      })
      const allowedNameStyle = {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const allowedCheckboxStyle = (editable) => ({
        flex: 'none',
        margin: 0,
        cursor: editable ? 'pointer' : 'default',
        accentColor: 'var(--dsw-alias-brand-primary, #4d8dff)',
      })
      const resetLinkStyle = (enabled) => ({
        border: 'none',
        background: 'transparent',
        color: enabled ? 'var(--dsw-alias-link, var(--dsw-alias-brand-primary, #4d8dff))' : 'var(--dsw-alias-label-tertiary, inherit)',
        font: 'inherit',
        fontSize: '11px',
        padding: 0,
        cursor: enabled ? 'pointer' : 'default',
        flex: 'none',
      })
      // The switch track: the host's own off-track token keeps the grey readable in both
      // themes; the on-colour is fixed so it reads the same in light and dark.
      const switchTrackStyle = (on, focused, disabled) => ({
        boxSizing: 'border-box',
        position: 'relative',
        display: 'block',
        width: '36px',
        height: '20px',
        padding: '2px',
        borderRadius: '999px',
        background: on
          ? '#C6FFD5'
          : 'var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 26%, transparent))',
        transition: 'background-color 160ms ease',
        boxShadow: focused ? '0 0 0 2px var(--dsw-alias-brand-primary, #4d8dff)' : 'none',
        opacity: disabled ? 0.5 : 1,
      })
      // A white knob with a hairline ring stays visible on the light-green track in the
      // light theme, where a bare white circle would otherwise nearly disappear.
      const switchKnobStyle = (on) => ({
        display: 'block',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0, 0, 0, .35), 0 0 0 1px rgba(0, 0, 0, .14)',
        transform: on ? 'translateX(16px)' : 'translateX(0)',
        transition: 'transform 160ms ease',
      })
      const selectStyle = {
        width: '100%',
        height: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        padding: '0 6px',
        colorScheme: 'light dark',
      }
      // The filter sits above the two rows; `colorScheme` keeps the native clear button theme-aware.
      const searchStyle = {
        flex: 1,
        minWidth: 0,
        height: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-fill-tertiary, color-mix(in srgb, currentColor 6%, transparent))',
        color: 'inherit',
        font: 'inherit',
        padding: '0 8px',
        boxSizing: 'border-box',
        colorScheme: 'light dark',
      }

      const modelButtonStyle = {
        width: '100%',
        minHeight: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        padding: '0 8px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        textAlign: 'left',
      }
      // The list hangs off the row button, so it paints above the effort select underneath.
      // Positioned fixed: the popover that hosts it clips its children (`overflow: hidden`),
      // so an absolutely positioned list would be cut off at the popover's edge. The
      // placement is measured per open; this is the fallback for a host without a layout.
      const dropdownStyle = {
        position: 'fixed',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        // Above the docked composer's own menus, so a list portalled to the body still paints
        // over the panel that owns the row.
        zIndex: 1100,
        maxHeight: '260px',
        overflowY: 'auto',
        padding: '6px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        display: 'grid',
        gap: '2px',
      }

      /**
       * Where the model list opens, and how tall it may be.
       *
       * The list hangs off a row button inside a popover that itself sits above the
       * composer, so "always below" runs past the bottom of the window and hides its last
       * options. Given the button's viewport rect, open downward while the preferred height
       * fits there, flip upward when that side has more room, and cap the height to the
       * space that is really available so the list scrolls instead of being clipped. A
       * `null` rect (no layout, as in a unit test) leaves the caller on its static style.
       */
      function popupPlacement(rect, viewportHeight, { gap = 4, margin = 8, preferred = 260, minimum = 80 } = {}) {
        const top = rect?.top
        const bottom = rect?.bottom
        if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(viewportHeight)) return null
        const below = viewportHeight - bottom - gap - margin
        const above = top - gap - margin
        const side = below >= preferred || below >= above ? 'down' : 'up'
        const room = side === 'down' ? below : above
        return {
          side,
          maxHeight: Math.max(Math.min(preferred, room), minimum),
          top: side === 'down' ? bottom + gap : 'auto',
          bottom: side === 'up' ? viewportHeight - top + gap : 'auto',
          left: rect.left,
          width: rect.width,
        }
      }

      /** Available height above the trigger, within the viewport's safe band. */
      function panelRoom(triggerTop, viewportHeight, topSafe = 56) {
        if (![triggerTop, viewportHeight, topSafe].every(Number.isFinite)) return null
        return Math.max(0, Math.min(triggerTop - 8, viewportHeight - 8) - topSafe)
      }

      function panelPlacement(rect, viewportHeight, viewportWidth, topSafe = 56, panelHeight = 0) {
        if (![rect?.top, rect?.bottom, viewportHeight, topSafe].every(Number.isFinite)) return null
        const limit = viewportHeight - 8
        const spaceAbove = panelRoom(rect.top, viewportHeight, topSafe)
        const downTop = Math.max(topSafe, rect.bottom + 8)
        const spaceBelow = Math.max(0, limit - downTop)
        const side = spaceAbove >= 320 || spaceAbove >= spaceBelow ? 'up' : 'down'
        // The actual room also wins in tiny windows: a visual minimum would cross a safe edge.
        const maxHeight = side === 'up' ? spaceAbove : spaceBelow
        const height = panelHeight > 0 ? Math.min(panelHeight, maxHeight) : maxHeight
        const top = side === 'up' ? Math.max(topSafe, Math.min(rect.top - 8, limit) - height) : downTop
        const right = Number.isFinite(rect.right) ? rect.right : 348
        const maxLeft = Number.isFinite(viewportWidth) ? Math.max(8, viewportWidth - panelWidth - 8) : Infinity
        const left = Math.min(Math.max(8, right - 340), maxLeft)
        return { side, top, left, maxHeight }
      }

      function panelStyleOf(placement) {
        if (placement === null) return panelStyle
        const { top, left, maxHeight } = placement
        return { ...panelStyle, top, left, maxHeight, visibility: maxHeight >= 2 ? 'visible' : 'hidden' }
      }

      function frameTopSafe(rect, probe, viewportHeight) {
        const styleOf = typeof window.getComputedStyle === 'function' ? window.getComputedStyle.bind(window) : null
        const inset = styleOf && document.documentElement
          ? styleOf(document.documentElement).getPropertyValue('--dsh-frame-overlay-top').trim() : ''
        // The host also publishes this token as calc(...); the browser resolves it on the probe.
        const token = /^\d+(?:\.\d+)?px$/.test(inset) ? Number.parseFloat(inset) : probe?.getBoundingClientRect?.().height
        let topSafe = Math.max(56, token || 0)
        const headers = document.querySelectorAll?.('header, [role="banner"], [data-conversation-header], [data-app-titlebar]') ?? []
        for (const header of headers) {
          const box = header.getBoundingClientRect()
          if (box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top > topSafe || box.bottom >= viewportHeight ||
              box.right <= rect.right - panelWidth || box.left >= rect.right + 232) continue
          const style = styleOf?.(header)
          if (style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') continue
          topSafe = Math.max(topSafe, box.bottom)
        }
        return topSafe
      }

      const useLayoutEffect = React.useLayoutEffect ?? React.useEffect

      function usePanelPlacement(open, anchor, panel, probe) {
        const [placement, setPlacement] = React.useState(null)
        useLayoutEffect(() => {
          if (!open) {
            setPlacement(null)
            return undefined
          }
          const trigger = anchor.current
          if (!trigger?.getBoundingClientRect || typeof window === 'undefined') return undefined
          const measure = () => {
            const rect = trigger.getBoundingClientRect()
            const viewportHeight = window.innerHeight
            const topSafe = frameTopSafe(rect, probe.current, viewportHeight)
            const panelHeight = panel.current?.getBoundingClientRect?.().height
            const next = panelPlacement(rect, viewportHeight, window.innerWidth, topSafe, panelHeight)
            if (next === null) return
            setPlacement((current) => current !== null && Object.keys(next).every((key) => next[key] === current[key]) ? current : next)
          }
          measure()
          window.addEventListener?.('resize', measure)
          window.addEventListener?.('scroll', measure, true)
          const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
          if (observer) {
            observer.observe(trigger)
            if (panel.current) observer.observe(panel.current)
            if (probe.current) observer.observe(probe.current)
          }
          return () => {
            window.removeEventListener?.('resize', measure)
            window.removeEventListener?.('scroll', measure, true)
            observer?.disconnect()
          }
        }, [open])
        return placement
      }

      /** The style for a measured placement, or the static fallback when there is none. */
      function dropdownStyleOf(placement) {
        if (placement === null) return dropdownStyle
        return Object.assign({}, dropdownStyle, {
          top: placement.top,
          bottom: placement.bottom,
          left: placement.left,
          right: 'auto',
          width: placement.width,
          maxHeight: placement.maxHeight + 'px',
        })
      }
      const filterRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        position: 'sticky',
        top: 0,
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        paddingBottom: '4px',
      }
      const groupStyle = {
        padding: '6px 8px 2px',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '11px',
        fontWeight: 600,
      }
      const optionStyle = (active, selected) => ({
        border: 'none',
        borderRadius: '6px',
        padding: '5px 8px',
        font: 'inherit',
        textAlign: 'left',
        color: 'inherit',
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: selected ? 600 : 400,
        background: selected
          ? 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, currentColor 12%, transparent))'
          : active
            ? 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent))'
            : 'transparent',
      })

      /** Re-render when a config scope changes, and return its current snapshot. */
      function useScope(scope) {
        const [, bump] = React.useReducer((n) => n + 1, 0)
        React.useEffect(() => scope.subscribe(() => bump()), [scope])
        return scope.getSnapshot()
      }

      /** Subscribe to a host snapshot store without requiring a newer React API. */
      function useExternalSnapshot(store) {
        const [, bump] = React.useReducer((n) => n + 1, 0)
        React.useEffect(() => {
          if (store === undefined || typeof store.subscribe !== 'function') return undefined
          return store.subscribe(() => bump())
        }, [store])
        return store !== undefined && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined
      }

      /** Resolve a usable per-session host directory, or leave the caller on the RPC fallback. */
      function resolveModelDirectory(modelDirectories, sessionId) {
        if (
          modelDirectories === undefined ||
          sessionId === undefined ||
          sessionId === null ||
          sessionId === '' ||
          typeof modelDirectories.directoryFor !== 'function'
        ) return undefined
        try {
          const directory = modelDirectories.directoryFor(sessionId)
          const store = directory?.store
          return store !== undefined && typeof store.subscribe === 'function' && typeof store.getSnapshot === 'function'
            ? directory
            : undefined
        } catch {
          return undefined
        }
      }

      /** Read host model-directory lifecycle and groups. */
      function useModelDirectory(directory) {
        const snapshot = useExternalSnapshot(directory?.store)
        if (directory === undefined || snapshot === undefined) {
          return { groups: undefined, loading: false, error: null }
        }
        return {
          groups: Array.isArray(snapshot.groups) ? snapshot.groups : [],
          loading: snapshot.status === 'idle' || snapshot.status === 'loading',
          error: typeof snapshot.error === 'string' && snapshot.error !== '' ? snapshot.error : null,
        }
      }

      /**
       * The subagent check interval. Edits stay local until blur or Enter; invalid input is
       * rejected without writing and the shown value snaps back to the stored one. The panel's
       * effective config keeps the field in step with a value changed anywhere else.
       */
      function SuperviseIntervalField({ config, editable, saveField, t }) {
        const current = intervalOf(config)
        const [draft, setDraft] = React.useState(String(current))
        const [hint, setHint] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const alive = React.useRef(true)
        const shown = React.useRef(current)

        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])
        // Follow the stored value when it changed somewhere else.
        React.useEffect(() => {
          if (shown.current === current) return
          shown.current = current
          setDraft(String(current))
        }, [current])
        // The warning is transient; a successful commit also clears it.
        React.useEffect(() => {
          if (hint === null || typeof setTimeout !== 'function') return undefined
          const timer = setTimeout(() => {
            if (alive.current) setHint(null)
          }, 4000)
          return () => clearTimeout(timer)
        }, [hint])

        const reject = (message) => {
          setHint(message)
          setDraft(String(current))
        }

        const commit = async () => {
          if (busy) return
          const parsed = parseInterval(draft)
          if (!parsed.ok) {
            reject(t('supervise.invalid'))
            return
          }
          // Same value: no mutate, just put the field back in its canonical form.
          if (parsed.seconds === current) {
            setDraft(String(current))
            setHint(null)
            return
          }
          if (!editable) {
            reject(t('supervise.readonly'))
            return
          }
          setBusy(true)
          try {
            const failure = await saveField(INTERVAL.key, parsed.seconds)
            if (!alive.current) return
            if (failure === null) setHint(null)
            else reject(failure)
          } finally {
            if (alive.current) setBusy(false)
          }
        }

        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h(
            'label',
            { style: { display: 'grid', gap: '4px' } },
            h('span', { style: { fontWeight: 600 } }, t('supervise.label')),
            h('input', {
              // Plain text keeps non-numeric input observable: a number input sanitizes "abc"
              // to an empty value, which this field would then read as "use the default".
              type: 'text',
              inputMode: 'numeric',
              min: INTERVAL.min,
              max: INTERVAL.max,
              step: 1,
              value: draft,
              disabled: busy || !editable,
              'aria-label': t('supervise.label'),
              style: selectStyle,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => commit(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  return commit()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(String(current))
                  setHint(null)
                }
                return undefined
              },
            }),
          ),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.3 } }, t('supervise.hint')),
          hint === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, hint),
        )
      }

      /**
       * The subagent patrol notice count, plus the unlimited switch beside it. The count is
       * editable only while unlimited patrol is off; switching unlimited on locks the field
       * and keeps the patrol running until the child stops, delivers, or ends. Edits stay
       * local until blur or Enter, and invalid input is rejected without writing.
       */
      function SuperviseCountField({ config, editable, saveField, t }) {
        const current = patrolCountOf(config)
        const unlimited = unlimitedOf(config)
        const [draft, setDraft] = React.useState(String(current))
        const [hint, setHint] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const alive = React.useRef(true)
        const shown = React.useRef(current)

        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])
        // Follow the stored value when it changed somewhere else.
        React.useEffect(() => {
          if (shown.current === current) return
          shown.current = current
          setDraft(String(current))
        }, [current])
        // The warning is transient; a successful commit also clears it.
        React.useEffect(() => {
          if (hint === null || typeof setTimeout !== 'function') return undefined
          const timer = setTimeout(() => {
            if (alive.current) setHint(null)
          }, 4000)
          return () => clearTimeout(timer)
        }, [hint])

        const reject = (message) => {
          setHint(message)
          setDraft(String(current))
        }

        const commit = async () => {
          if (busy) return
          const parsed = parsePatrolCount(draft)
          if (!parsed.ok) {
            reject(t('supervise.countInvalid'))
            return
          }
          // Same value: no mutate, just put the field back in its canonical form.
          if (parsed.count === current) {
            setDraft(String(current))
            setHint(null)
            return
          }
          if (!editable) {
            reject(t('supervise.readonly'))
            return
          }
          setBusy(true)
          try {
            const failure = await saveField(PATROL_COUNT.key, parsed.count)
            if (!alive.current) return
            if (failure === null) setHint(null)
            else reject(failure)
          } finally {
            if (alive.current) setBusy(false)
          }
        }

        const toggleUnlimited = async (on) => {
          if (busy) return
          if (!editable) {
            setHint(t('supervise.readonly'))
            return
          }
          setBusy(true)
          try {
            const failure = await saveField(PATROL_COUNT.unlimitedKey, on)
            if (!alive.current) return
            setHint(failure)
            // Turning unlimited on discards an uncommitted draft: the field is locked now.
            if (failure === null && on) setDraft(String(current))
          } finally {
            if (alive.current) setBusy(false)
          }
        }

        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h('span', { style: { fontWeight: 600 } }, t('supervise.countLabel')),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('input', {
              // Plain text keeps non-numeric input observable: a number input sanitizes "abc"
              // to an empty value, which this field would then read as "use the default".
              type: 'text',
              inputMode: 'numeric',
              min: PATROL_COUNT.min,
              max: PATROL_COUNT.max,
              step: 1,
              value: draft,
              disabled: unlimited || busy || !editable,
              'aria-label': t('supervise.countLabel'),
              style: {
                ...selectStyle,
                flex: '1 1 auto',
                minWidth: 0,
                opacity: unlimited ? 0.5 : 1,
                cursor: unlimited ? 'not-allowed' : undefined,
              },
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => commit(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  return commit()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(String(current))
                  setHint(null)
                }
                return undefined
              },
            }),
            h(
              'div',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
              h(
                'span',
                { style: { whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary, inherit)' } },
                t('supervise.unlimitedLabel'),
              ),
              h(EnableSwitch, {
                checked: unlimited,
                disabled: busy || !editable,
                onChange: toggleUnlimited,
                label: t('supervise.unlimitedLabel'),
              }),
            ),
          ),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.3 } }, t('supervise.countHint')),
          hint === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, hint),
        )
      }

      /**
       * The dispatch switch. A real checkbox with role="switch" gives Space-to-toggle and
       * the platform focus semantics for free; Enter is handled explicitly because a native
       * checkbox ignores it. The track and knob are inline styles (this bundle ships no
       * stylesheet), so the focus ring is state-driven rather than a :focus-visible rule.
       */
      function EnableSwitch({ checked, disabled, onChange, label }) {
        const [focused, setFocused] = React.useState(false)
        return h(
          'label',
          {
            style: {
              position: 'relative',
              display: 'inline-flex',
              flex: '0 0 auto',
              alignItems: 'center',
              cursor: disabled ? 'default' : 'pointer',
            },
          },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            checked,
            disabled,
            style: {
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              margin: 0,
              opacity: 0,
              cursor: 'inherit',
            },
            onChange: (event) => onChange(event.target.checked),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return undefined
              event.preventDefault()
              if (!disabled) onChange(!checked)
              return undefined
            },
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
          }),
          h(
            'span',
            { 'aria-hidden': true, 'data-switch': checked ? 'on' : 'off', style: switchTrackStyle(checked, focused, disabled) },
            h('span', { style: switchKnobStyle(checked) }),
          ),
        )
      }

      function worktreeIsolationOf(config) {
        return config?.worktreeIsolationEnabled !== false
      }

      const hintStyle = { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.3 }
      const alertStyle = { color: 'var(--dsw-alias-label-error, #ff7b72)' }
      const moreFields = [
        ['worktreeIsolationEnabled', 'worktreeIsolation'],
        ['readOnlyEnabled', 'readOnly'],
        ['peerReadOnlyConsultEnabled', 'peerReadOnlyConsult'],
      ]

      function SettingSwitch({ checked, disabled, onChange, label, hint, field }) {
        return h(
          'div',
          { 'data-setting': field, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h(
            'div',
            { style: { display: 'grid', gap: '2px', flex: '1 1 auto', minWidth: 0 } },
            h('span', { style: { fontWeight: 600 } }, label),
            h('span', { style: hintStyle }, hint),
          ),
          h(EnableSwitch, { checked, disabled, onChange, label }),
        )
      }

      function MoreSettingsPanel({ overlayRef, dialogRef, onClose, config, editable, saveField, problem, t }) {
        const closeButton = React.useRef(null)
        React.useEffect(() => { closeButton.current?.focus?.({ preventScroll: true }) }, [])
        return portalToBody(h(
          'div',
          {
            ref: overlayRef,
            'data-overlay': 'more-settings',
            style: moreOverlayStyle,
            onClick: (event) => { if (event.target === event.currentTarget) onClose() },
          },
          h(
            'div',
            {
              ref: dialogRef,
              role: 'dialog',
              'aria-modal': true,
              'aria-label': t('more.title'),
              'data-panel': 'more-settings',
              style: morePanelStyle,
            },
            h(
              'div',
              { style: headingRowStyle },
              h('strong', null, t('more.title')),
              h('button', { ref: closeButton, type: 'button', style: baseStyle, onClick: onClose }, t('more.close')),
            ),
            moreFields.map(([field, prefix]) => h(SettingSwitch, {
              key: field,
              field,
              checked: config[field],
              disabled: !editable,
              onChange: (checked) => saveField(field, checked),
              label: t(`${prefix}.label`),
              hint: t(`${prefix}.hint`),
            })),
            problem ? h('div', { role: 'alert', style: alertStyle }, problem) : null,
          ),
        ))
      }

      /**
       * The right-hand column: one checkbox per tool the host offers, searched by name.
       * Whitelist-driven — checked means the main agent may use the tool, and everything
       * else, including a tool some plugin or MCP server registers later, is blocked for it.
       * Every change writes the single allow key from the checkbox state, so the stored
       * config always describes exactly what the panel shows.
       */
      function AllowedToolsPanel({
        t, config, pluginValue, catalog, editable, session, canChangeSession, onSessionChange,
        moreTrigger, moreOpen, onMore, saveTools, resetTools,
      }) {
        const [query, setQuery] = React.useState('')
        // Shipped order first, then the catalog/config extras alphabetically, so a row
        // keeps its place when the live catalog changes.
        const value = { ...pluginValue, [ALLOW_KEY]: config.allowedTools }
        const names = toolListOf(value, catalog)
        const allowed = allowedSetOf(value, catalog)
        const teamEnabled = pluginValue?.[ALLOW_AGENT_TEAM_KEY] !== false
        const visible = filterTools(names, query)
        const sessionEnabled = session.state?.enabled === true

        const toggle = (name, on) => {
          // Preserve latent Team settings when ordinary checkboxes are edited; the
          // hard Team switch still filters what is shown and what the backend permits.
          const next = new Set(sessionEnabled ? config.allowedTools : allowed)
          if (on) next.add(name)
          else next.delete(name)
          return saveTools([...next])
        }

        return h(
          'div',
          { style: allowedColumnStyle, 'data-panel': 'allowed-tools' },
          h(
            'div',
            { 'data-scope': 'session-tools', style: { display: 'grid', gap: '4px' } },
            h(
              'div',
              { style: { ...headingRowStyle, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, t('allowed.session')),
              h(EnableSwitch, {
                checked: sessionEnabled,
                disabled: !canChangeSession,
                label: t('allowed.session'),
                onChange: onSessionChange,
              }),
              h('button', {
                ref: moreTrigger,
                type: 'button',
                'data-action': 'more-settings',
                'aria-haspopup': 'dialog',
                'aria-expanded': moreOpen,
                style: { ...baseStyle, marginInlineStart: 'auto', height: '24px' },
                onClick: onMore,
              }, t('more.button')),
            ),
            h('span', { style: hintStyle }, session.loading ? t('allowed.sessionLoading')
              : t(sessionEnabled ? 'allowed.sessionOn' : 'allowed.sessionOff')),
            session.problem ? h('div', { role: 'alert', style: alertStyle }, session.problem) : null,
          ),
          h('div', { role: 'separator', style: sessionSeparatorStyle }),
          h(
            'div',
            { style: headingRowStyle },
            h('span', { style: { fontWeight: 600 }, title: t('allowed.hint') }, t('allowed.title')),
            h('button', {
              type: 'button',
              style: resetLinkStyle(editable),
              disabled: !editable,
              onClick: resetTools,
            }, t('allowed.reset')),
          ),
          h(
            'div',
            { style: allowedListBoxStyle },
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('allowed.search'),
              'aria-label': t('allowed.search'),
              'data-search': 'allowed-tools',
              // `searchStyle` grows inside the dropdown's flex row; here it sits in a flex
              // column, so an explicit height keeps it a one-line box instead of stretching.
              style: Object.assign({}, searchStyle, { flex: 'none', height: '28px', width: '100%' }),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'div',
              { style: allowedListStyle, role: 'group', 'aria-label': t('allowed.title') },
              visible.length === 0
                ? h(
                    'div',
                    { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } },
                    t('allowed.empty'),
                  )
                : visible.map((name) => {
                    const teamDisabled = !teamEnabled && NATIVE_TEAM_TOOLS.includes(name)
                    const disabled = !editable || teamDisabled
                    const hint = teamDisabled
                      ? t('allowed.teamDisabled')
                      : DEFAULT_BLOCKED_NATIVE_TOOLS.includes(name) ? t('allowed.nativeBlocked') : undefined
                    return h(
                      'label',
                      { key: name, style: allowedRowStyle(allowed.has(name)), 'data-tool': name },
                      h('input', {
                        type: 'checkbox',
                        checked: allowed.has(name),
                        disabled,
                        'aria-label': name,
                        style: allowedCheckboxStyle(!disabled),
                        onChange: (event) => toggle(name, event.target.checked),
                      }),
                      h('span', { style: allowedNameStyle, title: hint === undefined ? name : `${name}: ${hint}` }, name),
                    )
                  }),
            ),
          ),
        )
      }

      function contains(ref, target) {
        return Boolean(ref.current?.contains?.(target))
      }

      /** One row: the current model, and the searchable list that opens in place. */
      function RouteRow({ label, route, groups, disabled, onChange, listRef, t }) {
        const [open, setOpen] = React.useState(false)
        const [active, setActive] = React.useState(0)
        const [query, setQuery] = React.useState('')
        const [placement, setPlacement] = React.useState(null)
        const box = React.useRef(null)
        // Portalled to the body, the list is no longer a DOM descendant of `box`, so it needs a
        // ref of its own for the outside-click test and for scrolling itself.
        const localListBox = React.useRef(null)
        const listBox = listRef ?? localListBox
        const searchInput = React.useRef(null)
        const options = React.useRef(new Map())
        const model = findModel(groups, route)
        const known = model !== undefined
        const key = route.provider !== '' && route.model !== '' ? routeKey(route.provider, route.model) : ''
        const efforts = model?.reasoning?.efforts ?? []
        const visible = filterGroups(groups, query)
        const items = []
        if (!known && key !== '') items.push({ kind: 'unknown' })
        items.push({ kind: 'unset' })
        for (const group of visible) {
          items.push({ kind: 'group', group })
          for (const entry of group.models) items.push({ kind: 'model', provider: group.id, model: entry })
        }

        const dismiss = () => {
          setOpen(false)
          setActive(0)
        }
        const choose = (item) => {
          // A different model offers different efforts, so the stored effort is dropped.
          if (item.kind === 'unset') onChange({ provider: '', model: '', effort: '' })
          else if (item.kind === 'model') onChange({ provider: item.provider, model: item.model.id, effort: '' })
          dismiss()
        }
        // Group headers are plain text, so keyboard movement skips them.
        const move = (step) => {
          if (items.length === 0) return
          let next = active
          for (let hop = 0; hop < items.length; hop += 1) {
            next = (next + step + items.length) % items.length
            if (items[next].kind !== 'group') break
          }
          setActive(next)
        }

        React.useEffect(() => {
          setActive(0)
        }, [query])
        React.useEffect(() => {
          if (!open) return undefined
          const outside = (event) => {
            if (contains(box, event.target) || contains(listBox, event.target)) return
            dismiss()
          }
          document.addEventListener('pointerdown', outside, true)
          return () => document.removeEventListener('pointerdown', outside, true)
        }, [open])
        // Anchor the list to the button and keep it inside the window: it opens upward when
        // there is more room above, and its height is capped to the room on that side so the
        // last option stays reachable by scrolling instead of being clipped by the popover.
        React.useEffect(() => {
          if (!open) {
            setPlacement(null)
            return undefined
          }
          const node = box.current
          if (!node?.getBoundingClientRect || typeof window === 'undefined') return undefined
          const measure = () => {
            const next = popupPlacement(node.getBoundingClientRect(), window.innerHeight)
            if (next !== null) setPlacement(next)
          }
          measure()
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          window.addEventListener('resize', measure)
          window.addEventListener('scroll', measure, true)
          return () => {
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
          }
        }, [open])
        // Focus the filter without letting the browser scroll anything to reveal it: the docked
        // composer is a scroll container, and a plain `autoFocus` scrolls it to the field on the
        // first frame, which drags the whole panel up and to the left.
        React.useEffect(() => {
          if (!open) return
          const field = searchInput.current
          if (field !== null && field !== undefined && typeof field.focus === 'function') {
            field.focus({ preventScroll: true })
          }
        }, [open])
        // Keyboard movement can walk past the visible slice of a capped list. Only the list may
        // scroll itself: `scrollIntoView` also scrolls every ancestor scroll container, which
        // moves the composer's `scrollBody` / `viewArea` and clips the panel.
        React.useEffect(() => {
          if (!open) return
          const node = options.current.get(active)
          if (node === null || node === undefined) return
          const list = listBox.current
          const measurable =
            list !== null &&
            list !== undefined &&
            typeof list.scrollTop === 'number' &&
            typeof list.clientHeight === 'number' &&
            typeof node.offsetTop === 'number' &&
            typeof node.offsetHeight === 'number'
          if (measurable) {
            const top = node.offsetTop
            const bottom = top + node.offsetHeight
            if (top < list.scrollTop) list.scrollTop = top
            else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
            return
          }
          // A host without layout (a unit test stub) still gets the old nearest-edge behaviour.
          if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
        }, [open, active, query])
        const renderItem = (item, index) => {
          if (item.kind === 'group') {
            return h('div', { key: 'g:' + item.group.id, style: groupStyle }, item.group.name ?? item.group.id)
          }
          const isUnset = item.kind === 'unset'
          const isModel = item.kind === 'model'
          const itemKey = isUnset ? 'unset' : isModel ? routeKey(item.provider, item.model.id) : 'unknown'
          const selected = isUnset ? key === '' : isModel ? key === itemKey : true
          const text = isUnset ? t('route.unset') : isModel ? item.model.name ?? item.model.id : key
          return h(
            'button',
            {
              key: itemKey,
              ref: (node) => {
                if (node === null || node === undefined) options.current.delete(index)
                else options.current.set(index, node)
              },
              type: 'button',
              role: 'option',
              'aria-selected': selected,
              style: optionStyle(active === index, selected),
              onMouseEnter: () => setActive(index),
              onClick: () => choose(item),
            },
            text,
          )
        }
        // The host's composer ancestors declare `container-type` / `will-change: transform`, which
        // makes them the containing block of a `position: fixed` child: a list rendered in place
        // would be laid out from the composer's top-left corner instead of the viewport its
        // placement was measured against, and it would land far down and to the right. The body
        // has no such ancestor, so the measured rect applies as written.
        const listboxNode = open
          ? h(
              'div',
              {
                ref: listBox,
                style: dropdownStyleOf(placement),
                role: 'listbox',
                'aria-label': label + ' · ' + t('route.search'),
                'data-side': placement?.side,
                onKeyDown: (event) => {
                  if (event.key !== 'Escape') return
                  event.preventDefault()
                  event.stopPropagation()
                  dismiss()
                },
              },
              h(
                'div',
                { style: filterRowStyle },
                h('input', {
                  type: 'search',
                  ref: searchInput,
                  value: query,
                  placeholder: t('route.search'),
                  'aria-label': t('route.search'),
                  style: searchStyle,
                  onChange: (event) => setQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      move(1)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      move(-1)
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      if (items[active] !== undefined && items[active].kind !== 'group') choose(items[active])
                    }
                  },
                }),
                h(
                  'span',
                  { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', whiteSpace: 'nowrap' } },
                  countModels(visible) + '/' + countModels(groups),
                ),
              ),
              items.length === 0
                ? h(
                    'div',
                    { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } },
                    t('route.noMatch') + ' · ' + t('route.noMatchHint'),
                  )
                : items.map(renderItem),
            )
          : null
        const listbox = portalToBody(listboxNode)
        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h('div', { style: { fontWeight: 600 } }, label),
          h(
            'div',
            { ref: box, style: { position: 'relative' } },
            h(
              'button',
              {
                type: 'button',
                style: modelButtonStyle,
                disabled,
                'aria-haspopup': 'listbox',
                'aria-expanded': open,
                'aria-label': label,
                onClick: () => (open ? dismiss() : setOpen(true)),
              },
              h(
                'span',
                { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                known
                  ? model.name ?? route.model
                  : route.model !== ''
                    ? route.model
                    : t('route.unset'),
              ),
              h(
                'span',
                { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none' } },
                open ? '▴' : '▾',
              ),
            ),
            listbox,
          ),
          efforts.length === 0
            ? null
            : h(
                'select',
                {
                  style: selectStyle,
                  value: route.effort,
                  disabled,
                  'aria-label': label + ' · ' + t('route.effort'),
                  onChange: (event) => onChange({ ...route, effort: event.target.value }),
                },
                h('option', { value: '' }, t('route.effortDefault')),
                efforts.map((e) => h('option', { key: e.id, value: e.id }, e.name ?? e.id)),
              ),
        )
      }
      /** Button plus panel: pick the default model and effort for the main agent and for workers. */
      function RoutePicker({ t, scopes, orch, loadCatalog, modelDirectories, sessionId, sessionRemote }) {
        const [open, setOpen] = React.useState(false)
        const [moreOpen, setMoreOpen] = React.useState(false)
        const anchor = React.useRef(null)
        const panel = React.useRef(null)
        const probe = React.useRef(null)
        const mainList = React.useRef(null)
        const workerList = React.useRef(null)
        const moreTrigger = React.useRef(null)
        const moreOverlay = React.useRef(null)
        const moreDialog = React.useRef(null)
        const placement = usePanelPlacement(open, anchor, panel, probe)
        const [fallbackGroups, setFallbackGroups] = React.useState(undefined)
        const [catalogError, setCatalogError] = React.useState(null)
        const [saveError, setSaveError] = React.useState(null)
        const [globalSaving, setGlobalSaving] = React.useState(false)
        const globalBusy = React.useRef(false)
        const loader = React.useRef(loadCatalog)
        loader.current = loadCatalog
        const main = useScope(scopes.main)
        const worker = useScope(scopes.worker)
        const plugin = useScope(orch)
        const session = useSessionConfig(sessionId, sessionRemote, open, t)
        const sessionEnabled = session.state?.enabled === true
        const rememberedCatalog = React.useRef([])
        const catalog = catalogFor(plugin.value, rememberedCatalog.current)
        if (catalog.length > 0) rememberedCatalog.current = catalog
        const globalConfig = createGlobalSnapshot(plugin.value, main.value, worker.value, catalog)
        const config = sessionEnabled ? session.state.config : globalConfig
        const editing = !session.loading && !session.saving && !globalSaving
        const editable = (snapshot) => editing && (sessionEnabled ? session.state.storageReady : writable(snapshot))
        const pluginEditable = editable(plugin)
        const globalConfigReady = [main, worker, plugin].every((snapshot) => snapshot.status === 'ready')
        const canChangeSession = editing && session.state?.storageReady === true && (sessionEnabled || globalConfigReady)
        const fieldScope = sessionEnabled ? `session:${sessionId}` : 'global'
        const directory = resolveModelDirectory(modelDirectories, sessionId)
        const directoryState = useModelDirectory(directory)
        const usingDirectory = directory !== undefined
        const groups = usingDirectory ? directoryState.groups : fallbackGroups
        const catalogProblem = usingDirectory ? directoryState.error : catalogError

        React.useEffect(() => {
          if (usingDirectory || !open) return undefined
          let live = true
          setCatalogError(null)
          Promise.resolve().then(() => {
            if (typeof loader.current !== 'function') throw new Error('model catalog loader unavailable')
            return loader.current()
          }).then(
            (response) => {
              if (!live) return
              if (response?.ok === true && Array.isArray(response.value?.groups)) {
                setFallbackGroups(response.value.groups)
                return
              }
              setCatalogError(t('route.catalogFailed'))
            },
            () => {
              if (live) setCatalogError(t('route.catalogFailed'))
            },
          )
          return () => {
            live = false
          }
        }, [open, usingDirectory])

        const runGlobal = async (operation, fallbackMessage) => {
          if (!editing || globalBusy.current) return t('route.readonly')
          globalBusy.current = true
          setGlobalSaving(true)
          setSaveError(null)
          try {
            const failure = await operation()
            setSaveError(failure)
            return failure
          } catch (error) {
            const failure = error?.message || fallbackMessage
            setSaveError(failure)
            return failure
          } finally {
            globalBusy.current = false
            setGlobalSaving(false)
          }
        }

        const mutatePlugin = (operations, confirm = () => true, failure = t('route.saveFailed')) => runGlobal(async () => {
          const current = orch.getSnapshot()
          if (!writable(current)) return t('route.readonly')
          const result = await orch.mutate(operations(current.value), current.revision)
          return result !== false && confirm(orch.getSnapshot().value) ? null : failure
        }, failure)

        const saveField = (key, value) => {
          if (!pluginEditable || globalBusy.current) return t('route.readonly')
          if (sessionEnabled) return session.write('setConfig', { [key]: value })
          return mutatePlugin(() => [{ op: 'set', path: [key], value }], (current) => current?.[key] === value)
        }

        const readGlobalConfig = () => {
          const value = orch.getSnapshot().value
          return createGlobalSnapshot(value, scopes.main.getSnapshot().value, scopes.worker.getSnapshot().value,
            catalogFor(value, rememberedCatalog.current))
        }
        const changeSession = (on) => {
          if (!canChangeSession || globalBusy.current || on === sessionEnabled) return
          setSaveError(null)
          // Clearing resumes the current global route as well as the other global settings.
          return on ? session.write('setConfig', readGlobalConfig()) : session.write('clear')
        }
        const resetTools = () => pluginEditable && (sessionEnabled
          ? session.write('setConfig', { allowedTools: readGlobalConfig().allowedTools })
          : mutatePlugin(resetAllowOps))
        const saveTools = (tools) => pluginEditable && (sessionEnabled
          ? session.write('setConfig', { allowedTools: tools })
          : mutatePlugin((value) => allowOps(tools, value, catalogFor(value, rememberedCatalog.current))))

        const write = (which, route) => {
          if (!editing || globalBusy.current) return
          if (sessionEnabled) {
            const key = which === 'main' ? 'mainRoute' : 'workerRoute'
            return session.write('setConfig', { [key]: toSessionRoute(route) })
          }
          const fields = which === 'main' ? MAIN.fields : WORKER.fields
          return runGlobal(() => saveRoute(scopes[which], fields, route, t), t('route.saveFailed'))
        }

        const close = () => {
          setMoreOpen(false)
          setOpen(false)
        }
        const closeMore = () => {
          setMoreOpen(false)
          moreTrigger.current?.focus?.({ preventScroll: true })
        }
        React.useEffect(() => {
          if (!open || typeof document === 'undefined') return undefined
          const outside = (event) => {
            const target = event.target
            if ([anchor, panel, mainList, workerList, moreTrigger, moreDialog, moreOverlay].some((ref) => contains(ref, target))) return
            if (moreOpen) closeMore()
            else close()
          }
          const escape = (event) => {
            if (event.key !== 'Escape') return
            if (!moreOpen && (mainList.current || workerList.current || event.target?.type === 'text')) return
            event.preventDefault()
            event.stopPropagation()
            if (moreOpen) closeMore()
            else {
              close()
              anchor.current?.focus?.({ preventScroll: true })
            }
          }
          document.addEventListener('pointerdown', outside, true)
          document.addEventListener('keydown', escape, true)
          return () => {
            document.removeEventListener('pointerdown', outside, true)
            document.removeEventListener('keydown', escape, true)
          }
        }, [open, moreOpen])

        const showLoading = catalogProblem === null && (
          groups === undefined || (usingDirectory && directoryState.loading && groups.length === 0)
        )
        const modelRows = ['main', 'worker'].map((which) => h(RouteRow, {
          key: `${which}:${fieldScope}`,
          label: t(`route.${which}`),
          route: fromSessionRoute(config[`${which}Route`]),
          groups: groups ?? [],
          disabled: !editable(which === 'main' ? main : worker) || groups === undefined || showLoading,
          listRef: which === 'main' ? mainList : workerList,
          onChange: (route) => write(which, route),
          t,
        }))
        return h(
          'span',
          { style: { display: 'inline-flex' } },
          h(
            'button',
            {
              ref: anchor,
              type: 'button',
              style: Object.assign({}, baseStyle, open ? onStyle : null),
              onClick: () => (open ? close() : setOpen(true)),
              title: t('route.title'),
              'aria-label': t('route.title'),
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
            },
            h('span', null, t('route.button')),
          ),
          open ? h('span', { ref: probe, style: topInsetProbeStyle, 'aria-hidden': true }) : null,
          open
            ? portalToBody(h(
                'div',
                {
                  ref: panel,
                  style: panelStyleOf(placement),
                  role: 'dialog',
                  'aria-label': t('route.title'),
                  'data-panel': 'orchestrator-settings',
                  'data-side': placement?.side,
                },
                h(
                  'div',
                  { style: panelColumnStyle },
                  h(SettingSwitch, {
                    field: 'enabled',
                    checked: config.enabled,
                    disabled: !pluginEditable,
                    onChange: (checked) => saveField('enabled', checked),
                    label: t('route.enable'),
                    hint: t('route.enableNote'),
                  }),
                  modelRows,
                  showLoading ? h('div', null, t('route.loading')) : null,
                  h(SuperviseIntervalField, { key: `interval:${fieldScope}`, config, editable: pluginEditable, saveField, t }),
                  h(SuperviseCountField, { key: `count:${fieldScope}`, config, editable: pluginEditable, saveField, t }),
                  catalogProblem ? h('div', { style: alertStyle, role: 'alert' }, catalogProblem) : null,
                  saveError ? h('div', { style: alertStyle, role: 'alert' }, saveError) : null,
                  !sessionEnabled && (!writable(main) || !writable(worker) || !writable(plugin))
                    ? h('div', { style: hintStyle }, t('route.readonly'))
                    : null,
                  h('div', { style: hintStyle }, t(sessionEnabled ? 'route.sessionNote' : 'route.note')),
                ),
                h(AllowedToolsPanel, {
                  key: sessionId,
                  t,
                  config,
                  pluginValue: plugin.value,
                  catalog,
                  editable: pluginEditable,
                  session,
                  canChangeSession,
                  onSessionChange: changeSession,
                  moreTrigger,
                  moreOpen,
                  onMore: () => setMoreOpen(true),
                  saveTools,
                  resetTools,
                }),
              ))
            : null,
          open && moreOpen
            ? h(MoreSettingsPanel, {
                overlayRef: moreOverlay,
                dialogRef: moreDialog,
                onClose: closeMore,
                config,
                editable: pluginEditable,
                saveField,
                problem: sessionEnabled ? session.problem : saveError,
                t,
              })
            : null,
        )
      }

      /** Service names, not package names: these are the `ctx.*` members used below. */
      const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'orchestrator: dictionaries')
        const sessionRemote = mountSessionRemote(ctx)
        ctx.effect(() => sessionRemote.dispose, 'orchestrator: session tools Remote')
        const scopes = { main: ctx.configForms.get(MAIN.ns), worker: ctx.configForms.get(WORKER.ns), orch: ctx.configForms.get(NS) }
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'orchestrator-route-picker',
              order: 11,
              locale: NS,
              inject: (sessionId) => ({
                scopes,
                orch: scopes.orch,
                loadCatalog: () => ctx.remote.session.modelCatalog(),
                sessionId,
                sessionRemote,
                // Cordis property access can throw for undeclared services.
                modelDirectories: typeof ctx.get === 'function' ? ctx.get('modelDirectories') : ctx.modelDirectories,
              }),
            },
            RoutePicker,
          ),
        )
      }

      exports.apply = apply
      exports.inject = inject
      // Pure helpers, exposed so they can be tested without a browser.
      exports.__test = {
        MAIN,
        WORKER,
        INTERVAL,
        DEFAULT_ALLOWED_TOOLS,
        NATIVE_TEAM_TOOLS,
        DEFAULT_BLOCKED_NATIVE_TOOLS,
        ALLOW_KEY,
        ALLOW_AGENT_TEAM_KEY,
        CATALOG_KEY,
        namesOf,
        catalogOf,
        catalogFor,
        toolListOf,
        popupPlacement,
        dropdownStyleOf,
        dropdownStyle,
        panelStyle,
        panelStyleOf,
        panelRoom,
        panelPlacement,
        panelColumnStyle,
        allowedColumnStyle,
        allowedListBoxStyle,
        allowedListStyle,
        RouteRow,
        allowedSetOf,
        filterTools,
        allowOps,
        resetAllowOps,
        EnableSwitch,
        MoreSettingsPanel,
        AllowedToolsPanel,
        createGlobalSnapshot,
        createSessionToolsDescriptors,
        mountSessionRemote,
        RoutePicker,
        routeKey,
        parseRouteKey,
        routeOf,
        routeOps,
        findModel,
        filterGroups,
        countModels,
        saveRoute,
        intervalOf,
        parseInterval,
        SuperviseIntervalField,
        PATROL_COUNT,
        patrolCountOf,
        unlimitedOf,
        parsePatrolCount,
        SuperviseCountField,
      }
    })(module, module.exports, (id) => load(id))
    return module.exports
  },
})
