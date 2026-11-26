import { dispatchCwd, formatWorktreeError } from './write-scope-tool.js'

const ACTIONS = ['list', 'inspect', 'merge', 'discard', 'prune']
const STRATEGIES = ['merge', 'squash', 'ff-only']
const CLOSED_STATES = new Set(['merged', 'discarded'])
const DIFF_LIMIT = { min: 1000, max: 64000, default: 12000 }
const COMMIT_LIMIT = { min: 1, max: 100, default: 20 }
const isId = (value) => typeof value === 'string' && value.trim() !== ''

function readOptions(args, action) {
  const options = {}
  for (const [key, fallback] of Object.entries({
    list: { includeClosed: false },
    merge: { autoStageDirty: false, deleteAfterMerge: true },
    discard: { force: false },
    prune: { dryRun: false },
  }[action] ?? {})) {
    options[key] = args[key] === undefined ? fallback : args[key]
    if (typeof options[key] !== 'boolean') throw new Error(`${key} 必须是布尔值。`)
  }
  if (action === 'inspect') {
    for (const [key, range] of Object.entries({ maxDiffChars: DIFF_LIMIT, maxCommits: COMMIT_LIMIT })) {
      const value = args[key] === undefined ? range.default : args[key]
      if (!Number.isInteger(value) || value < range.min || value > range.max) {
        throw new Error(`${key} 必须是 ${range.min}..${range.max} 之间的整数。`)
      }
      options[key] = value
    }
  }
  if (action === 'merge') {
    const { strategy = 'merge', commitMessage } = args
    if (!STRATEGIES.includes(strategy)) throw new Error('strategy 必须是 merge、squash 或 ff-only。')
    if (commitMessage !== undefined && typeof commitMessage !== 'string') {
      throw new Error('commitMessage 必须是字符串。')
    }
    options.strategy = strategy
    if (commitMessage !== undefined) options.commitMessage = commitMessage
  }
  return options
}

function projectWorktreeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return record
  // The manager stores these persistence fields as non-enumerable own properties.
  // Preserve them on the tool receipt without changing the manager's record shape.
  return {
    ...record,
    ...(Object.hasOwn(record, 'childIds') && { childIds: record.childIds }),
    ...(Object.hasOwn(record, 'locked') && { locked: record.locked }),
  }
}

function toLosslessJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null
  if (typeof value !== 'object' || ancestors.has(value)) return undefined

  ancestors.add(value)
  try {
    // Fill holes or unsupported elements with null; never shift array indices.
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) =>
        Object.hasOwn(value, index) ? toLosslessJsonValue(value[index], ancestors) ?? null : null)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    // Copy only enumerable string keys, omitting unsupported values and back-edges.
    const entries = []
    for (const [key, entry] of Object.entries(value)) {
      const json = toLosslessJsonValue(entry, ancestors)
      if (json !== undefined) entries.push([key, json])
    }
    return Object.fromEntries(entries)
  } finally {
    ancestors.delete(value)
  }
}

function toolResult(action, text, payload) {
  const details = { ...payload, action, ok: payload.ok === true }
  if (action === 'list') details.worktrees = details.worktrees.map(projectWorktreeRecord)
  if (Object.hasOwn(details, 'worktree')) details.worktree = projectWorktreeRecord(details.worktree)
  return toLosslessJsonValue({ content: [{ type: 'text', text: String(text) }], details })
}

function nextWorktreeState(record, action, result) {
  if (result.worktree?.state) return result.worktree.state
  if (result.state) return result.state
  if (result.code === 'merge-conflict') return 'merge_conflict'
  if (result.code === 'worktree-cleanup-failed') return 'cleanup_failed'
  if (result.ok && !result.noop) {
    if (action === 'merge' && result.merged !== false) return 'merged'
    if (action === 'discard' && result.discarded !== false) return 'discarded'
  }
  return record.state
}

function syncDelivery(timeline, record, action, result) {
  if (!record.childId || typeof timeline?.recordWorktreeState !== 'function') return
  const state = nextWorktreeState(record, action, result)
  const mergeCommit = result.mergeCommit ?? result.worktree?.mergeCommit ?? record.mergeCommit ?? null
  timeline.recordWorktreeState(record.childId, {
    id: record.id,
    state,
    mergeCommit,
    conflictFiles: result.conflictFiles ?? result.worktree?.conflictFiles ?? record.conflictFiles ?? [],
    locked: CLOSED_STATES.has(state) || (mergeCommit !== null && result.worktree?.cleaned === false),
  })
}

function deliverySummary(action, record, result) {
  const label = `工作树 ${record.id}`
  const state = nextWorktreeState(record, action, result)
  if (!result.ok) {
    if (state === 'merge_conflict' && result.code === 'merge-conflict') {
      const files = result.conflictFiles ?? result.worktree?.conflictFiles ?? []
      const rollback = result.rollbackError ? '源仓自动回退失败，请立即核查源仓状态。' : ''
      return `${label} 合回发生冲突（${files.length} 个文件），未合回，保留现场供评审。${rollback}`
    }
    if (action === 'merge' && result.merged === true) {
      return `${label} 已合回，但清理失败：${result.message ?? '请检查工作树状态。'}\n` +
        '不要重复合并；请调用 worktree_manage(action: "discard", force: true) 清理残留目录或分支。'
    }
    if (action === 'merge' && result.code === 'worktree-already-closed' && result.message) return result.message
    return `${label} ${action === 'merge' ? '合回' : '丢弃'}未完成：${result.message ?? formatWorktreeError(result.code)}`
  }
  if (action === 'discard') return record.mergeCommit ? `${label} 已清理，交付物此前已合回。` : `${label} 已丢弃。`
  if (result.noop || result.merged === false) return `${label} 没有待合回的提交，工作树未关闭。`
  const commit = result.mergeCommit ?? result.worktree?.mergeCommit
  return `${label} 已合回${commit ? `（提交 ${commit}）` : ''}。` + (result.cleaned === false
    ? '工作树仍保留；可调用 worktree_manage(action: "discard", force: true) 清理。' : '')
}

/** The root session reviews and disposes of managed worktrees; the manager owns Git I/O. */
export function createWorktreeManageTool({
  worktrees,
  timeline = null,
  toolName = 'worktree_manage',
  isRootAgent,
  onClosed,
  defineTool = (definition) => definition,
} = {}) {
  return defineTool({
    name: toolName,
    description: '仅根代理可用：列出、检查、合回或丢弃当前会话的 Git 工作树交付，或清理当前仓库的孤立工作树。',
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true, description: '要执行的工作树操作。' },
      worktreeId: { type: 'string', description: '工作树 ID；inspect、merge、discard 需要此项或 childId。' },
      childId: { type: 'string', description: '子代理 ID；未提供 worktreeId 时用于定位工作树。' },
      includeClosed: { type: 'boolean', default: false, description: 'list 是否包含已合回或已丢弃的工作树。' },
      // The host's author schema does not support minimum/maximum; enforce ranges in execute.
      maxDiffChars: { type: 'integer', default: DIFF_LIMIT.default, description: 'inspect 返回的 diff 字符上限（1000..64000）。' },
      maxCommits: { type: 'integer', default: COMMIT_LIMIT.default, description: 'inspect 返回的提交条数上限（1..100）。' },
      strategy: { type: 'string', enum: STRATEGIES, default: 'merge', description: '合回策略。' },
      commitMessage: { type: 'string', description: '可选：用于合回或自动提交的消息。' },
      autoStageDirty: { type: 'boolean', default: false, description: 'merge 是否自动暂存并提交隔离目录中的未提交改动。' },
      deleteAfterMerge: { type: 'boolean', default: true, description: '成功合回后是否删除隔离目录及分支。' },
      force: { type: 'boolean', default: false, description: 'discard 是否强制丢弃未提交或未合回的工作。' },
      dryRun: { type: 'boolean', default: false, description: 'prune 是否仅预览孤立项，不执行删除。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { type: { type: 'string', const: 'text' }, text: { type: 'string' } },
            },
          },
          details: {
            type: 'object',
            additionalProperties: true,
            properties: {
              action: { type: 'string', enum: ACTIONS },
              ok: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => value.content,
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isRootAgent !== 'function' || isRootAgent(exec) !== true) {
        throw new Error(`仅根代理可调用 ${toolName}。`)
      }
      const parentId = exec?.agent?.id
      if (!isId(parentId)) throw new Error(`${toolName} 无法识别调用代理的会话 ID，拒绝操作。`)

      const { action, worktreeId, childId } = args ?? {}
      if (!ACTIONS.includes(action)) throw new Error('action 必须是 list、inspect、merge、discard 或 prune。')
      for (const [key, value] of Object.entries({ worktreeId, childId })) {
        if (value !== undefined && !isId(value)) throw new Error(`${key} 必须是非空字符串。`)
      }
      const options = readOptions(args, action)
      if (action === 'list') {
        const rows = await worktrees.list({ parentId, ...options })
        const owned = rows.filter((row) => row?.parentId === parentId &&
          (options.includeClosed || !CLOSED_STATES.has(row.state)))
        const text = [`当前会话有 ${owned.length} 棵工作树。`,
          ...owned.map((row) => `- ${row.id}：${row.state}（分支 ${row.branch ?? '未知'}）`)].join('\n')
        return toolResult(action, text, { ok: true, worktrees: owned, total: owned.length })
      }
      if (action === 'prune') {
        const repoRoot = dispatchCwd({}, exec)
        if (!repoRoot) throw new Error(`${toolName} 无法识别当前会话工作目录，拒绝清理。`)
        const result = await worktrees.prune({ repoRoot, ...options })
        const text = !result.ok ? `清理失败：${result.message ?? formatWorktreeError(result.code)}`
          : options.dryRun ? `清理预览：发现 ${result.orphans?.length ?? 0} 个孤立项，未执行删除。`
            : `清理完成：工作树 ${result.prunedWorktrees?.length ?? 0} 棵，分支 ${result.prunedBranches?.length ?? 0} 个，错误 ${result.errors?.length ?? 0} 项。`
        return toolResult(action, text, result)
      }

      const id = worktreeId || childId
      if (!id) throw new Error(`${action} 需要提供 worktreeId 或 childId。`)
      const record = await worktrees.getByWorktreeOrChild(id)
      if (!record) return toolResult(action, '未找到工作树记录。', { ok: false, code: 'worktree-not-found' })
      if (record.parentId && record.parentId !== parentId) throw new Error('拒绝访问不属于当前根代理的工作树。')

      const result = await worktrees[action](record.id, options)
      if (action === 'inspect') {
        const text = result.ok
          ? `工作树 ${record.id}（分支 ${record.branch ?? '未知'}）：${result.exists === false ? '目录已不存在。'
            : `新增提交 ${result.aheadCount ?? result.commits?.length ?? 0} 个${result.dirty ? '，有未提交改动' : ''}${result.diffTruncated ? '，差异已截断' : ''}。`}`
          : `检查工作树 ${record.id} 失败：${result.message ?? formatWorktreeError(result.code)}`
        return toolResult(action, text, result)
      }
      syncDelivery(timeline, record, action, result)
      if (result.merged === true || nextWorktreeState(record, action, result) === 'discarded') onClosed?.(record)
      return toolResult(action, deliverySummary(action, record, result), result)
    },
  })
}
