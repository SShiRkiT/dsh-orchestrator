window.__ModuleLoader__.load({
  id: 'dsh-orchestrator',
  factory: (load) => {
    const module = { exports: {} }
    ;(function (module, exports, require) {
      'use strict'
      const React = require('react')

      /** Dictionary namespace owned by this plugin. */
      const NS = 'orchestrator'

      const zh = {
        'toggle.label': '计划',
        'toggle.on': '计划模式已开启，点击关闭 (/plan off)',
        'toggle.off': '计划模式已关闭，点击开启 (/plan)',
        'toggle.pending': '，将在下一步生效',
        'toggle.failed': '切换计划模式失败',
        'stage.idle': '默认',
        'stage.clarify': '澄清',
        'stage.planning': '规划',
        'stage.awaiting': '待确认',
        'stage.executing': '执行',
        'stage.na': '不适用',
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
        'route.note': '主代理的改动对新会话生效；子代理的改动从下一次委派起生效。所有子代理共用同一个模型。',
        'route.search': '搜索模型…',
        'route.noMatch': '没有匹配的模型',
        'route.noMatchHint': '换个关键词，或清空搜索看全部',
        'route.selected': '当前选中',
        'route.enable': '启用调度模式',
        'route.enableNote': '开启后主代理只做规划、由子代理执行；已打开的会话也会立即生效。',
        'route.enableFailed': '切换失败',
      }
      const en = {
        'toggle.label': 'Plan',
        'toggle.on': 'Plan mode is on, click to turn off (/plan off)',
        'toggle.off': 'Plan mode is off, click to turn on (/plan)',
        'toggle.pending': ', applies from the next step',
        'toggle.failed': 'Could not switch plan mode',
        'stage.idle': 'Default',
        'stage.clarify': 'Clarify',
        'stage.planning': 'Planning',
        'stage.awaiting': 'Review',
        'stage.executing': 'Executing',
        'stage.na': 'N/A',
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
        'route.note': 'A main agent change applies to new sessions; a subagent change applies from the next delegation. All subagents share one model.',
        'route.search': 'Search models…',
        'route.noMatch': 'No matching models',
        'route.noMatchHint': 'Try another keyword, or clear the search to see everything',
        'route.selected': 'selected',
        'route.enable': 'Enable dispatch mode',
        'route.enableNote': 'The main agent only plans and delegates the work; an open conversation follows the switch immediately.',
        'route.enableFailed': 'Could not switch',
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
      const dot = (on) => ({
        width: '6px',
        height: '6px',
        borderRadius: '999px',
        background: on ? 'var(--dsw-alias-brand-primary, #4d8dff)' : 'var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 45%, transparent))',
      })

      /**
       * Plan-mode toggle. The native plan projection folds the host's committed
       * state; `/plan` during an open turn is queued, so `pending` means the shown
       * target differs from what the host has applied so far.
       */
      function PlanToggle({ useProjection, locked, setPlan, t }) {
        // A blank new conversation has no folded plan state yet; that is plan mode off.
        const plan = useProjection('plan') ?? { active: false, pending: false }
        // Derived by the host from logged events; absent until the first projection arrives.
        const stage = useProjection('orchestrator')?.stage ?? 'idle'
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const alive = React.useRef(true)
        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        const target = plan.pending ? !plan.active : plan.active
        const base = target ? t('toggle.on') : t('toggle.off')
        // The button face only says "Plan" and is lit when on; the stage lives in the hover text.
        const title = error ?? (plan.pending ? base + t('toggle.pending') : base) + ' · ' + t('stage.' + stage)

        const onClick = () => {
          if (busy || locked) return
          setBusy(true)
          setError(null)
          setPlan(!target).then(
            (failure) => {
              if (!alive.current) return
              setBusy(false)
              setError(failure)
            },
            (reason) => {
              if (!alive.current) return
              setBusy(false)
              setError(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('toggle.failed'))
            },
          )
        }

        return React.createElement(
          'button',
          {
            type: 'button',
            style: Object.assign({}, baseStyle, target ? onStyle : null, busy || locked ? { opacity: 0.6 } : null),
            disabled: busy || locked,
            onClick,
            title,
            'aria-label': title,
            'aria-pressed': target,
            'data-plan': target ? 'on' : 'off',
            'data-pending': plan.pending ? 'true' : 'false',
            'data-stage': stage,
          },
          React.createElement('span', { style: dot(target), 'aria-hidden': true }),
          React.createElement('span', null, t('toggle.label')),
        )
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
        ns: 'orchestrator',
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

      const h = React.createElement
      const panelStyle = {
        position: 'absolute',
        right: 0,
        bottom: 'calc(100% + 8px)',
        zIndex: 50,
        width: '340px',
        padding: '12px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        color: 'inherit',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        fontSize: '12px',
        display: 'grid',
        gap: '10px',
      }
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
      const dropdownStyle = {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        zIndex: 60,
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

      /** One row: the current model, and the searchable list that opens in place. */
      function RouteRow({ label, route, groups, disabled, onChange, t }) {
        const [open, setOpen] = React.useState(false)
        const [active, setActive] = React.useState(0)
        const [query, setQuery] = React.useState('')
        const box = React.useRef(null)
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
            if (box.current !== null && !box.current.contains(event.target)) dismiss()
          }
          document.addEventListener('pointerdown', outside, true)
          return () => document.removeEventListener('pointerdown', outside, true)
        }, [open])
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
                known ? model.name ?? route.model : key === '' ? t('route.unset') : key,
              ),
              h(
                'span',
                { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none' } },
                open ? '▴' : '▾',
              ),
            ),
            open
              ? h(
                  'div',
                  { style: dropdownStyle, role: 'listbox', 'aria-label': label + ' · ' + t('route.search') },
                  h(
                    'div',
                    { style: filterRowStyle },
                    h('input', {
                      type: 'search',
                      value: query,
                      autoFocus: true,
                      placeholder: t('route.search'),
                      'aria-label': t('route.search'),
                      style: searchStyle,
                      onChange: (event) => setQuery(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation()
                          dismiss()
                        } else if (event.key === 'ArrowDown') {
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
              : null,
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
      function RoutePicker({ t, scopes, orch, loadCatalog }) {
        const [open, setOpen] = React.useState(false)
        const [groups, setGroups] = React.useState(undefined)
        const [problem, setProblem] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        const main = useScope(scopes.main)
        const worker = useScope(scopes.worker)
        const plugin = useScope(orch)

        React.useEffect(() => {
          if (!open || groups !== undefined) return undefined
          let live = true
          loadCatalog().then(
            (response) => {
              if (!live) return
              if (response.ok) setGroups(response.value.groups)
              else setProblem(t('route.catalogFailed'))
            },
            () => {
              if (live) setProblem(t('route.catalogFailed'))
            },
          )
          return () => {
            live = false
          }
        }, [open, groups])

        const write = async (which, route) => {
          setSaving(true)
          setProblem(null)
          const failure = await saveRoute(which === 'main' ? scopes.main : scopes.worker, which === 'main' ? MAIN.fields : WORKER.fields, route, t)
          setSaving(false)
          setProblem(failure)
        }

        const toggleEnabled = async (on) => {
          const snapshot = orch.getSnapshot()
          if (snapshot.status !== 'ready' || !snapshot.writable) {
            setProblem(t('route.readonly'))
            return
          }
          setSaving(true)
          setProblem(null)
          try {
            await orch.mutate([{ op: 'set', path: ['enabled'], value: on }], snapshot.revision)
          } catch (reason) {
            setProblem(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('route.enableFailed'))
          }
          setSaving(false)
        }

        const writable = main.writable === true && worker.writable === true
        const close = () => {
          setOpen(false)
        }
        return h(
          'span',
          { style: { position: 'relative', display: 'inline-flex' } },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, baseStyle, open ? onStyle : null),
              onClick: () => (open ? close() : setOpen(true)),
              title: t('route.title'),
              'aria-label': t('route.title'),
              'aria-expanded': open,
            },
            h('span', null, t('route.button')),
          ),
          open
            ? h(
                'div',
                { style: panelStyle, role: 'dialog', 'aria-label': t('route.title') },
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '0 0 8px' } },
                  h('input', {
                    type: 'checkbox',
                    checked: plugin.value?.enabled === true,
                    disabled: saving || plugin.writable !== true,
                    style: { marginTop: '3px' },
                    onChange: (event) => toggleEnabled(event.target.checked),
                  }),
                  h(
                    'span',
                    { style: { display: 'grid', gap: '2px' } },
                    h('span', { style: { fontWeight: 600 } }, t('route.enable')),
                    h('span', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.35 } }, t('route.enableNote')),
                  ),
                ),
                groups === undefined && problem === null
                  ? h('div', null, t('route.loading'))
                  : groups === undefined
                    ? null
                    : [
                        h(RouteRow, {
                          key: 'main',
                          label: t('route.main'),
                          route: routeOf(MAIN.fields, main.value),
                          groups,
                          disabled: saving || !writable,
                          onChange: (route) => write('main', route),
                          t,
                        }),
                        h(RouteRow, {
                          key: 'worker',
                          label: t('route.worker'),
                          route: routeOf(WORKER.fields, worker.value),
                          groups,
                          disabled: saving || !writable,
                          onChange: (route) => write('worker', route),
                          t,
                        }),
                      ],
                problem === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, problem),
                !writable && groups !== undefined
                  ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('route.readonly'))
                  : null,
                h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } }, t('route.note')),
              )
            : null,
        )
      }

      /** Service names, not package names: these are the `ctx.*` members used below. */
      const inject = ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'configForms']

      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'orchestrator: dictionaries')

        // Same command channel the native plan chip uses to leave plan mode.
        const setPlanFor = (sessionId) => async (active) => {
          const command = active ? '/plan' : '/plan off'
          const result = await ctx.remote.commands.execute(sessionId, command, [])
          if (!result.ok) return result.error.message + ' (' + result.error.code + ')'
          if (result.value === undefined) return 'unknown command: ' + command
          return null
        }
        const control = (slot, id, order) => ({
          name: slot,
          id,
          order,
          locale: NS,
          inject: (sessionId) => ({ setPlan: setPlanFor(sessionId) }),
        })

        // The composer's own plan slot, so the control sits where the host keeps its plan chip.
        try {
          ctx.slots.inject('conversation.input.plan', () =>
            ctx.slots.register(control('conversation.input.plan', 'orchestrator-plan-toggle', 10), PlanToggle),
          )
        } catch {
          // Older hosts without the plan slot keep the control on the right.
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(control('conversation.input.right', 'orchestrator-plan-toggle', 10), PlanToggle),
          )
        }

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
              }),
            },
            RoutePicker,
          ),
        )
      }

      exports.apply = apply
      exports.inject = inject
      // Pure helpers, exposed so they can be tested without a browser.
      exports.__test = { MAIN, WORKER, routeKey, parseRouteKey, routeOf, routeOps, findModel, filterGroups, countModels, saveRoute }
    })(module, module.exports, (id) => load(id))
    return module.exports
  },
})
