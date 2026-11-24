import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const WORKTREE_POOL_DIRNAME = '.dsh-orchestrator'
export const WORKTREE_POOL_SUBDIR = 'worktrees'
export const WORKTREE_BRANCH_PREFIX = 'dsh-wt/'
export const WORKTREE_STATES = Object.freeze([
  'active', 'ready_for_review', 'merged', 'discarded', 'merge_conflict', 'cleanup_failed',
])

const PROTECTED_STATES = new Set(['active', 'ready_for_review', 'merge_conflict'])
const CLOSED_STATES = new Set(['merged', 'discarded'])
const WINDOWS = process.platform === 'win32'
const fold = (filename) => WINDOWS ? filename.toLowerCase() : filename
const pathKey = (filename) => fold(path.resolve(filename))
const posix = (filename) => filename.split(path.sep).join('/')
const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR'
const line = (text) => text.replace(/\r?\n$/, '')
const failure = (code, message, fields = {}) => ({ ok: false, code, message, ...fields })
const errorText = (error) => String(error.stderr || error.message).trim()
const isId = (value) => typeof value === 'string' && value.length > 0
const textOrNull = (value) => typeof value === 'string' ? value : null
const timeOrNull = (value) => Number.isFinite(value) ? value : null

export function isWorktreeLockedRecord(record) {
  return Boolean(record?.locked) || record?.state === 'merged' || record?.state === 'discarded' ||
    Boolean(record?.mergeCommit) || Boolean(record?.cleaned)
}

function childIdsOf(record) {
  const ids = Array.isArray(record.childIds) ? record.childIds : []
  return [...new Set([record.childId, ...ids].filter(isId))]
}

function copyAuditSummary(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return null
  }
}

function persistedRecord(record) {
  return {
    id: record.id, parentId: textOrNull(record.parentId), childId: textOrNull(record.childId),
    childIds: childIdsOf(record), batchId: textOrNull(record.batchId),
    itemIndex: Number.isSafeInteger(record.itemIndex) ? record.itemIndex : null,
    repoRoot: textOrNull(record.repoRoot), sourceCwd: textOrNull(record.sourceCwd),
    subPath: textOrNull(record.subPath), worktreePath: textOrNull(record.worktreePath),
    execCwd: textOrNull(record.execCwd), branch: textOrNull(record.branch),
    baseBranch: textOrNull(record.baseBranch), baseCommit: textOrNull(record.baseCommit),
    label: textOrNull(record.label), state: record.state, mergeCommit: textOrNull(record.mergeCommit),
    cleaned: record.cleaned === true, locked: isWorktreeLockedRecord(record),
    createdAt: timeOrNull(record.createdAt), updatedAt: timeOrNull(record.updatedAt),
    auditSummary: copyAuditSummary(record.auditSummary),
  }
}

// A restored record may be a pathless tombstone. Never use an unverified shape as a Git target.
function isManagedCheckout(record) {
  const { id, repoRoot, worktreePath, branch, baseCommit } = record
  return /^wt-[a-z0-9_-]{1,8}$/.test(id) && branch === `${WORKTREE_BRANCH_PREFIX}${id}` &&
    isId(repoRoot) && path.isAbsolute(repoRoot) && isId(worktreePath) && path.isAbsolute(worktreePath) &&
    pathKey(worktreePath) === pathKey(path.join(poolPaths(repoRoot).pool, id)) &&
    typeof baseCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseCommit)
}

function git(cwd, args, readOnly = false) {
  return execFileSync('git', readOnly ? ['--no-optional-locks', ...args] : args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const query = (cwd, ...args) => git(cwd, args, true)

function optionalQuery(cwd, args, expectedStatus) {
  try {
    return line(query(cwd, ...args))
  } catch (error) {
    if (error.status === expectedStatus) return null
    throw error
  }
}

function isInside(root, filename) {
  const relative = path.relative(fold(root), fold(filename))
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function lstat(filename) {
  try {
    return fs.lstatSync(filename)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

// Resolve a prospective path through every existing ancestor, including junctions.
function prospectiveRealpath(filename) {
  if (lstat(filename)) return fs.realpathSync.native(filename)
  const parent = path.dirname(filename)
  if (parent === filename) return fs.realpathSync.native(filename)
  return path.join(prospectiveRealpath(parent), path.basename(filename))
}

export function probeGitRepo(cwd) {
  const unavailable = {
    isGit: false, repoRoot: null, gitCommonDir: null, headCommit: null, headBranch: null,
    subPath: '', reason: 'not-git-repo',
  }
  if (typeof cwd !== 'string' || !cwd.trim()) return unavailable
  let repoRoot
  let realCwd
  try {
    realCwd = fs.realpathSync.native(path.resolve(cwd))
    repoRoot = fs.realpathSync.native(line(query(realCwd, 'rev-parse', '--show-toplevel')))
  } catch (error) {
    if (missing(error) || error.status === 128) return unavailable
    throw error
  }
  const common = line(query(repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  const gitCommonDir = fs.realpathSync.native(path.resolve(repoRoot, common))
  const headCommit = optionalQuery(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], 1)
  const headBranch = optionalQuery(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 1)
  return {
    isGit: true, repoRoot, gitCommonDir, headCommit, headBranch,
    subPath: posix(path.relative(repoRoot, realCwd)), reason: headCommit ? null : 'unborn-head',
  }
}

function poolPaths(repoRoot) {
  const owner = path.join(repoRoot, WORKTREE_POOL_DIRNAME)
  return { owner, pool: path.join(owner, WORKTREE_POOL_SUBDIR) }
}

function assertDirectory(filename) {
  const stats = lstat(filename)
  if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
    throw new Error(`工作树池路径不是普通目录：${filename}`)
  }
  return stats
}

export function ensurePoolIgnore(repoRoot) {
  const { owner, pool } = poolPaths(repoRoot)
  assertDirectory(owner)
  assertDirectory(pool)
  fs.mkdirSync(pool, { recursive: true })
  const filename = path.join(owner, '.gitignore')
  const stats = lstat(filename)
  if (stats && !stats.isFile()) throw new Error(`池忽略文件不是普通文件：${filename}`)
  const previous = stats ? fs.readFileSync(filename, 'utf8') : ''
  // Put the catch-all last so existing negation rules cannot expose the pool.
  if (!/(?:^|\n)\*\n$/.test(previous)) {
    const separator = previous.length > 0 && !previous.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(filename, `${separator}*\n`)
  }
  return pool
}

function status(cwd) {
  const records = query(cwd, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none')
  const stagedFiles = []
  const unstagedFiles = []
  const untrackedFiles = []
  const dirtyFiles = []
  for (const row of records.split('\0')) {
    if (!row) continue
    const filename = row.slice(3)
    dirtyFiles.push(filename)
    if (row.startsWith('??')) untrackedFiles.push(filename)
    else {
      if (row[0] !== ' ') stagedFiles.push(filename)
      if (row[1] !== ' ') unstagedFiles.push(filename)
    }
  }
  return { stagedFiles, unstagedFiles, untrackedFiles, dirtyFiles, dirty: dirtyFiles.length > 0 }
}

function commitsOf(text) {
  return line(text).split('\n').filter(Boolean).map((row) => {
    const [hash, shortHash, ...subject] = row.split('\x1f')
    return { hash, shortHash, subject: subject.join('\x1f') }
  })
}

function gitWorktrees(repoRoot) {
  const entries = []
  let entry
  for (const row of query(repoRoot, 'worktree', 'list', '--porcelain', '-z').split('\0')) {
    const at = row.indexOf(' ')
    const name = at < 0 ? row : row.slice(0, at)
    const value = at < 0 ? '' : row.slice(at + 1)
    if (name === 'worktree') {
      entry = { path: path.resolve(value), branch: null, prunable: false }
      entries.push(entry)
    } else if (entry && name === 'branch') entry.branch = value.replace(/^refs\/heads\//, '')
    else if (entry && name === 'prunable') entry.prunable = true
  }
  return entries
}

function branchExists(repoRoot, branch) {
  return optionalQuery(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 1) !== null
}

function hasNewCommits(cwd, baseCommit, tip = 'HEAD') {
  return Number(line(query(cwd, 'rev-list', '--count', `${baseCommit}..${tip}`))) > 0
}

function isAncestor(cwd, ancestor, descendant) {
  return optionalQuery(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], 1) !== null
}

function identityArgs(cwd) {
  const defaults = { 'user.name': 'DSH Orchestrator', 'user.email': 'dsh-orchestrator@localhost' }
  return Object.entries(defaults).flatMap(([key, value]) =>
    optionalQuery(cwd, ['config', '--get', key], 1) ? [] : ['-c', `${key}=${value}`])
}

function removeWorktree(record, force = false) {
  const { repoRoot, worktreePath } = record
  const entry = gitWorktrees(repoRoot).find((row) => pathKey(row.path) === pathKey(worktreePath))
  if (!entry && !lstat(worktreePath)) return
  if (!entry || (entry.branch && entry.branch !== record.branch)) {
    throw new Error('工作树登记缺失或已换用其他分支，拒绝删除目录。')
  }
  const directory = worktreeDirectory(record)
  if (directory) assertCheckout(record)
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktreePath]
  for (let attempt = 0; ; attempt += 1) {
    try {
      git(repoRoot, args)
      return
    } catch (error) {
      if (!WINDOWS || attempt >= 3 || !/permission denied|access is denied|directory not empty|failed to (delete|remove)|resource busy/i.test(errorText(error))) {
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
    }
  }
}

function sourceOperationInProgress(repoRoot) {
  const gitDir = line(query(repoRoot, 'rev-parse', '--absolute-git-dir'))
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer']
    .some((marker) => lstat(path.join(gitDir, marker)))
}

function worktreeDirectory({ repoRoot, worktreePath }) {
  const { owner, pool } = poolPaths(repoRoot)
  assertDirectory(owner)
  assertDirectory(pool)
  return assertDirectory(worktreePath)
}

function assertCheckout({ repoRoot, worktreePath }) {
  const reported = line(query(worktreePath, 'rev-parse', '--show-toplevel'))
  const common = line(query(worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  const expected = line(query(repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  if (pathKey(fs.realpathSync.native(reported)) !== pathKey(fs.realpathSync.native(worktreePath)) ||
      pathKey(fs.realpathSync.native(common)) !== pathKey(fs.realpathSync.native(expected))) {
    throw new Error('目录不再是原工作树根目录。')
  }
}

export function createWorktreeManager({ now = () => Date.now(), newId = randomUUID } = {}) {
  const records = new Map()
  const children = new Map()
  const childHistory = new Map()
  const get = (id) => records.get(id) ?? null
  const getByChild = (childId) => get(children.get(childId))
  const getByWorktreeOrChild = (idOrChildId) => get(idOrChildId) ?? get(childHistory.get(idOrChildId))
  const notFound = () => failure('worktree-not-found', '未找到工作树记录。')
  const unsafeCheckout = (worktree) => failure('worktree-invalid-record', '工作树登记不符合受管目录或分支约束。', { worktree })
  const save = (record) => {
    const { childIds, locked, ...fields } = record
    const snapshot = { ...fields, conflictFiles: Object.freeze([...record.conflictFiles]) }
    // Keep the enumerable shape of legacy manager receipts; exportRecords owns the persistence shape.
    Object.defineProperties(snapshot, {
      childIds: { value: Object.freeze(childIdsOf({ childId: record.childId, childIds })) },
      locked: { value: isWorktreeLockedRecord({ ...fields, locked }) },
    })
    const frozen = Object.freeze(snapshot)
    records.set(frozen.id, frozen)
    for (const childId of frozen.childIds) childHistory.set(childId, frozen.id)
    return frozen
  }
  const update = (record, changes) => save({
    ...record, childIds: record.childIds, locked: record.locked, ...changes, updatedAt: now(),
  })

  function exportRecords() {
    return [...records.values()].map(persistedRecord)
  }

  function hydrateRecords(rows, { replace = false } = {}) {
    let restored = 0
    let skipped = 0
    if (!Array.isArray(rows)) return { restored, skipped }
    if (replace) clear()
    for (const row of rows) {
      if (!isId(row?.id) || !WORKTREE_STATES.includes(row.state) ||
          (row.updatedAt != null && !Number.isFinite(row.updatedAt))) {
        skipped += 1
        continue
      }
      const updatedAt = timeOrNull(row.updatedAt) ?? timeOrNull(row.createdAt) ?? 0
      const previous = get(row.id)
      const childIds = [...new Set([...childIdsOf(row), ...(previous?.childIds ?? [])])]
      if ((previous && previous.updatedAt > updatedAt) || childIds.some((childId) =>
        childHistory.has(childId) && childHistory.get(childId) !== row.id)) {
        skipped += 1
        continue
      }
      const record = save({
        ...persistedRecord({
          ...row, childIds, updatedAt, locked: isWorktreeLockedRecord(row) || isWorktreeLockedRecord(previous),
          mergeCommit: row.mergeCommit || previous?.mergeCommit,
          cleaned: row.cleaned || previous?.cleaned,
        }),
        settledAt: timeOrNull(row.settledAt), closedAt: timeOrNull(row.closedAt),
        conflictFiles: Array.isArray(row.conflictFiles) ? row.conflictFiles.filter(isId) : [],
        error: textOrNull(row.error),
      })
      for (const childId of record.childIds) children.set(childId, record.id)
      restored += 1
    }
    return { restored, skipped }
  }
  const cleanFailure = (record, error, fields) => {
    const detail = errorText(error)
    return failure('worktree-cleanup-failed', detail, {
      ...fields, worktree: update(record, { state: 'cleanup_failed', error: detail }),
    })
  }

  function create({ sourceCwd, workspaceRoot = null, label = null, parentId = null,
    childId = null, batchId = null, itemIndex = null }) {
    try {
      const probe = probeGitRepo(sourceCwd)
      if (!probe.isGit) return failure('not-git-repo', '源目录不在 Git 工作树内。')
      if (!probe.headCommit) return failure('unborn-head', '源仓库没有可检出的提交。')
      const { repoRoot, gitCommonDir, headCommit: baseCommit, headBranch: baseBranch, subPath } = probe
      const suffix = String(newId()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8).toLowerCase()
      const id = `wt-${suffix}`
      const branch = `${WORKTREE_BRANCH_PREFIX}${id}`
      const worktreePath = path.join(poolPaths(repoRoot).pool, id)
      if (workspaceRoot !== null) {
        let allowed = false
        try {
          const root = fs.realpathSync.native(path.resolve(workspaceRoot))
          allowed = isInside(root, prospectiveRealpath(worktreePath)) && isInside(root, gitCommonDir)
        } catch {
          // A containment boundary that cannot be resolved is not safe to use.
        }
        if (!allowed) return failure('worktree-outside-workspace', '工作树或共享 Git 目录超出工作区边界。', {
          worktreePath, gitCommonDir, workspaceRoot,
        })
      }
      if (!suffix || records.has(id) || lstat(worktreePath) || branchExists(repoRoot, branch)) {
        return failure('worktree-id-conflict', '工作树 ID 无效或已存在。')
      }
      if (childId !== null && childHistory.has(childId)) return failure('worktree-child-conflict', '子代理已绑定工作树。')
      ensurePoolIgnore(repoRoot)
      git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])
      const candidate = path.join(worktreePath, subPath)
      const execCwd = lstat(candidate)?.isDirectory() &&
        isInside(fs.realpathSync.native(worktreePath), fs.realpathSync.native(candidate)) ? candidate : worktreePath
      const time = now()
      const worktree = save({
        id, parentId, childId, batchId, itemIndex, label, repoRoot, sourceCwd: path.resolve(sourceCwd),
        subPath, worktreePath, execCwd, branch, baseCommit, baseBranch, state: 'active',
        createdAt: time, updatedAt: time, settledAt: null, closedAt: null, auditSummary: null,
        mergeCommit: null, conflictFiles: [], error: null,
      })
      if (childId !== null) children.set(childId, id)
      return { ok: true, worktree }
    } catch (error) {
      return failure('worktree-create-failed', errorText(error))
    }
  }

  function bindChild(worktreeId, childId) {
    const record = get(worktreeId)
    if (!record || !isId(childId) ||
        (childHistory.has(childId) && childHistory.get(childId) !== worktreeId)) return null
    children.set(childId, worktreeId)
    if (record.childIds.includes(childId)) return record
    return update(record, { childIds: [...record.childIds, childId] })
  }

  function rebindChild(id, childId) {
    const record = get(id)
    if (!record || (childId != null && (!isId(childId) ||
        (childHistory.has(childId) && childHistory.get(childId) !== id)))) return null
    children.delete(record.childId)
    if (childId != null) children.set(childId, id)
    return update(record, { childId: childId ?? null })
  }

  function getChildWorktreeMap() {
    return new Map(childHistory)
  }

  function list({ parentId = null, state = null, includeClosed = true } = {}) {
    return [...records.values()].filter((row) => (parentId === null || row.parentId === parentId) &&
      (state === null || state === row.state) && (includeClosed || !CLOSED_STATES.has(row.state)))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  function isChildLocked(childId) {
    const record = get(childHistory.get(childId))
    if (!record) return { locked: false }
    const { id: worktreeId, state, worktreePath } = record
    const locked = isWorktreeLockedRecord(record) || !worktreePath || !fs.existsSync(worktreePath)
    return locked ? { locked, reason: '工作树已合回、关闭或目录已移除。', worktreeId, state }
      : { locked, worktreeId, state }
  }

  function reopenForRetry(id) {
    const record = get(id)
    if (!record || isWorktreeLockedRecord(record) ||
        !['ready_for_review', 'merge_conflict'].includes(record.state)) return record
    return update(record, { state: 'active', conflictFiles: [], error: null })
  }

  function markReadyForReview(id, auditSummary = null) {
    const record = get(id)
    if (!record || isWorktreeLockedRecord(record) ||
        !['active', 'ready_for_review'].includes(record.state)) return record
    return update(record, { state: 'ready_for_review', settledAt: now(), auditSummary })
  }

  function inspect(idOrChildId, { maxDiffChars = 16000, maxCommits = 30 } = {}) {
    const worktree = getByWorktreeOrChild(idOrChildId)
    if (!worktree) return notFound()
    if (!isManagedCheckout(worktree)) return unsafeCheckout(worktree)
    const { worktreePath, baseCommit } = worktree
    try {
      if (!worktreeDirectory(worktree)) {
        return { ok: true, worktree, exists: false, headCommit: null, aheadCount: 0, commits: [],
          diffStat: '', diffPatch: '', diffTruncated: false, stagedFiles: [], unstagedFiles: [],
          untrackedFiles: [], dirty: false }
      }
      assertCheckout(worktree)
      const range = `${baseCommit}..HEAD`
      const commitLimit = Number.isFinite(maxCommits) ? Math.max(0, Math.floor(maxCommits)) : 30
      const diffLimit = Number.isFinite(maxDiffChars) ? Math.max(0, Math.floor(maxDiffChars)) : 16000
      const current = status(worktreePath)
      const diffArgs = ['diff', '--no-ext-diff', '--no-textconv']
      const patch = query(worktreePath, ...diffArgs, baseCommit, '--')
      return {
        ok: true, worktree, exists: true,
        headCommit: line(query(worktreePath, 'rev-parse', 'HEAD')),
        aheadCount: Number(line(query(worktreePath, 'rev-list', '--count', range))),
        commits: commitsOf(query(worktreePath, 'log', '--format=%H%x1f%h%x1f%s', `--max-count=${commitLimit}`, range)),
        diffStat: query(worktreePath, ...diffArgs, '--stat', baseCommit, '--'),
        diffPatch: patch.slice(0, diffLimit), diffTruncated: patch.length > diffLimit,
        stagedFiles: current.stagedFiles, unstagedFiles: current.unstagedFiles,
        untrackedFiles: current.untrackedFiles, dirty: current.dirty,
      }
    } catch (error) {
      return failure('worktree-inspect-failed', errorText(error), { worktree })
    }
  }

  function merge(idOrChildId, { strategy = 'merge', commitMessage = null,
    autoStageDirty = false, deleteAfterMerge = true } = {}) {
    let worktree = getByWorktreeOrChild(idOrChildId)
    if (!worktree) return notFound()
    if (!['merge', 'squash', 'ff-only'].includes(strategy)) return failure('worktree-invalid-strategy', '未知合并策略。')
    if (worktree.state === 'active') return failure('worktree-active', '活跃工作树尚不能合并。', { worktree })
    if (worktree.mergeCommit !== null) {
      const needsCleanup = worktree.state !== 'discarded' && worktree.cleaned === false
      const message = '工作树已合回，不要重复合并。' + (needsCleanup
        ? '请调用 worktree_manage(action: "discard", force: true) 清理残留目录或分支。' : '')
      return failure('worktree-already-closed', message, { worktree, mergeCommit: worktree.mergeCommit })
    }
    if (isWorktreeLockedRecord(worktree)) {
      return failure('worktree-already-closed', '工作树已关闭。', { worktree })
    }
    if (!isManagedCheckout(worktree)) return unsafeCheckout(worktree)
    const { repoRoot, worktreePath, branch, baseCommit } = worktree
    const message = commitMessage ?? `Merge worktree ${branch}`
    let autoCommitted = false
    try {
      if (!worktreeDirectory(worktree)) return failure('worktree-missing', '待合并的工作树目录不存在。', { worktree })
      assertCheckout(worktree)
      const checkedOut = optionalQuery(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 1)
      if (checkedOut !== branch) return failure('worktree-branch-changed', '工作树不再检出原隔离分支。', { worktree })
      const dirtyFiles = status(worktreePath).dirtyFiles
      if (dirtyFiles.length && !autoStageDirty) {
        return failure('worktree-dirty', '工作树仍有未提交改动。', { dirtyFiles, worktree })
      }
      if (!dirtyFiles.length && !hasNewCommits(worktreePath, baseCommit)) {
        return { ok: true, noop: true, merged: false, autoCommitted, worktree }
      }
      // Check the source before auto-committing too: a refusal should not mutate either checkout.
      const sourceDirty = status(repoRoot).dirtyFiles
      if (sourceDirty.length) return failure('source-repo-dirty', '源仓库有未提交改动。', { dirtyFiles: sourceDirty, worktree })
      if (sourceOperationInProgress(repoRoot)) {
        return failure('source-repo-busy', '源仓库已有未完成的 Git 操作。', { worktree })
      }
      if (dirtyFiles.length) {
        git(worktreePath, ['add', '-A'])
        git(worktreePath, [...identityArgs(worktreePath), 'commit', '-m', message])
        autoCommitted = true
        const remaining = status(worktreePath).dirtyFiles
        if (remaining.length) {
          return failure('worktree-dirty', '自动提交后仍有未提交改动。', { dirtyFiles: remaining, autoCommitted, worktree })
        }
      }
      const latestSourceDirty = status(repoRoot).dirtyFiles
      if (latestSourceDirty.length) return failure('source-repo-dirty', '源仓库有未提交改动。', {
        dirtyFiles: latestSourceDirty, autoCommitted, worktree,
      })
      if (sourceOperationInProgress(repoRoot)) {
        return failure('source-repo-busy', '源仓库已有未完成的 Git 操作。', { autoCommitted, worktree })
      }
      let squashStaged = false
      try {
        if (strategy === 'squash') {
          git(repoRoot, ['merge', '--squash', branch])
          squashStaged = true
          if (status(repoRoot).stagedFiles.length) git(repoRoot, [...identityArgs(repoRoot), 'commit', '-m', message])
        } else if (strategy === 'ff-only') {
          git(repoRoot, ['merge', '--ff-only', branch])
        } else {
          git(repoRoot, [...identityArgs(repoRoot), 'merge', '--no-ff', branch, '-m', message])
        }
      } catch (error) {
        const conflictFiles = [...new Set(query(repoRoot, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean))]
        const detail = errorText(error)
        let rollbackError = null
        try {
          if (strategy === 'squash' && (squashStaged || conflictFiles.length)) git(repoRoot, ['reset', '--merge'])
          else if (strategy !== 'squash' && sourceOperationInProgress(repoRoot)) git(repoRoot, ['merge', '--abort'])
        } catch (rollback) {
          rollbackError = errorText(rollback)
        }
        if (conflictFiles.length) worktree = update(worktree, { state: 'merge_conflict', conflictFiles, error: detail })
        return failure(conflictFiles.length ? 'merge-conflict' : 'worktree-merge-failed',
          rollbackError ? `${detail}\n源仓回退失败：${rollbackError}` : detail,
          { conflictFiles, worktreePath, branch, worktree, autoCommitted, ...(rollbackError && { rollbackError }) })
      }
      const mergeCommit = line(query(repoRoot, 'rev-parse', 'HEAD'))
      worktree = update(worktree, { mergeCommit, cleaned: false, conflictFiles: [], error: null })
      if (deleteAfterMerge) {
        try {
          removeWorktree(worktree)
          if (branchExists(repoRoot, branch)) git(repoRoot, ['branch', '-d', '--', branch])
        } catch (error) {
          return cleanFailure(worktree, error, { merged: true, cleaned: false, mergeCommit, autoCommitted })
        }
      }
      worktree = update(worktree, { state: 'merged', cleaned: deleteAfterMerge, closedAt: now() })
      return { ok: true, merged: true, cleaned: deleteAfterMerge, mergeCommit, autoCommitted, worktree }
    } catch (error) {
      return failure('worktree-merge-failed', errorText(error), { worktree, autoCommitted })
    }
  }

  function discard(idOrChildId, { force = false } = {}) {
    const worktree = getByWorktreeOrChild(idOrChildId)
    if (!worktree) return notFound()
    if (worktree.state === 'discarded') return { ok: true, discarded: true, worktree }
    if (worktree.state === 'active' && !force) return failure('worktree-active', '活跃工作树必须显式强制丢弃。', { worktree })
    if (!isManagedCheckout(worktree)) return unsafeCheckout(worktree)
    const { repoRoot, worktreePath, branch, baseCommit, mergeCommit } = worktree
    try {
      const directory = worktreeDirectory(worktree)
      if (directory) {
        assertCheckout(worktree)
        if (!force) {
          const { dirtyFiles } = status(worktreePath)
          if (dirtyFiles.length) return failure('worktree-dirty', '工作树仍有未提交改动。', { dirtyFiles, worktree })
        }
      }
      if (!force && !mergeCommit) {
        // Check the actual worktree tip as well as the original branch before any deletion.
        const refs = [...(branchExists(repoRoot, branch) ? [branch] : [])]
        if (directory) refs.push(line(query(worktreePath, 'rev-parse', 'HEAD')))
        if (refs.some((ref) => hasNewCommits(repoRoot, baseCommit, ref) && !isAncestor(repoRoot, ref, 'HEAD'))) {
          return failure('worktree-unmerged', '工作树仍有未合并提交，必须显式强制丢弃。', { worktree })
        }
      }
      removeWorktree(worktree, force)
      if (branchExists(repoRoot, branch)) git(repoRoot, ['branch', '-D', '--', branch])
      return { ok: true, discarded: true, worktree: update(worktree, {
        state: 'discarded', closedAt: now(), error: null, ...(mergeCommit !== null && { cleaned: true }),
      }) }
    } catch (error) {
      return cleanFailure(worktree, error, { discarded: false })
    }
  }

  function prune({ repoRoot, dryRun = false } = {}) {
    try {
      const probe = probeGitRepo(repoRoot)
      if (!probe.isGit) return failure('not-git-repo', '清理目录不在 Git 工作树内。')
      repoRoot = probe.repoRoot
      const { owner, pool } = poolPaths(repoRoot)
      assertDirectory(owner)
      const poolExists = assertDirectory(pool)
      const protectedPaths = new Set(list().filter((row) => PROTECTED_STATES.has(row.state) && isManagedCheckout(row))
        .map((row) => pathKey(row.worktreePath)))
      const entries = gitWorktrees(repoRoot)
      const registered = new Map(entries.map((entry) => [pathKey(entry.path), entry]))
      const inPool = (filename) => pathKey(path.dirname(filename)) === pathKey(pool)
      const eligible = (filename) => inPool(filename) && !protectedPaths.has(pathKey(filename))
      const missingWorktrees = entries.filter((entry) => entry.prunable && eligible(entry.path) && !lstat(entry.path))
      const loose = (poolExists ? fs.readdirSync(pool, { withFileTypes: true }) : [])
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => path.join(pool, entry.name))
        .filter((filename) => eligible(filename) && !registered.has(pathKey(filename)))
      const orphans = [...loose, ...missingWorktrees.map((entry) => entry.path)].sort()
      const result = { ok: true, dryRun, repoRoot, orphans, prunedWorktrees: [], prunedBranches: [], errors: [] }
      if (dryRun) return result
      const note = (filename, error) => result.errors.push({ path: filename, message: errorText(error) })
      const branchCandidates = new Set()
      // `git worktree prune` is repository-wide; never let it touch unrelated or protected entries.
      const allowedPrunable = new Set(missingWorktrees.map((entry) => pathKey(entry.path)))
      if (!entries.some((entry) => entry.prunable && !allowedPrunable.has(pathKey(entry.path)))) {
        try {
          git(repoRoot, ['worktree', 'prune'])
          const remaining = new Set(gitWorktrees(repoRoot).map((entry) => pathKey(entry.path)))
          for (const entry of missingWorktrees) {
            if (remaining.has(pathKey(entry.path))) continue
            result.prunedWorktrees.push(entry.path)
            if (entry.branch) branchCandidates.add(entry.branch)
          }
        } catch (error) {
          note(pool, error)
        }
      } else if (missingWorktrees.length) {
        note(pool, new Error('Git 清理会影响池外或受保护的登记项，已跳过。'))
      }
      for (const filename of loose) {
        try {
          if (!assertDirectory(filename)) continue
          // An independently owned checkout is not a disposable orphan.
          if (lstat(path.join(filename, '.git'))) throw new Error('目录含 Git 元数据，拒绝自动清理。')
          if (gitWorktrees(repoRoot).some((row) => pathKey(row.path) === pathKey(filename))) continue
          fs.rmSync(filename, { recursive: true, force: false })
          result.prunedWorktrees.push(filename)
          branchCandidates.add(`${WORKTREE_BRANCH_PREFIX}${path.basename(filename)}`)
        } catch (error) {
          note(filename, error)
        }
      }
      for (const branch of branchCandidates) {
        if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) continue
        try {
          if (branchExists(repoRoot, branch) && !gitWorktrees(repoRoot).some((row) => row.branch === branch)) {
            git(repoRoot, ['branch', '-D', '--', branch])
            result.prunedBranches.push(branch)
          }
        } catch (error) {
          note(branch, error)
        }
      }
      return result
    } catch (error) {
      return failure('worktree-prune-failed', errorText(error))
    }
  }

  function clear() {
    records.clear()
    children.clear()
    childHistory.clear()
  }

  return { create, rebindChild, bindChild, get, getByChild, getByWorktreeOrChild, list, isChildLocked,
    getChildWorktreeMap, exportRecords, hydrateRecords, markReadyForReview, reopenForRetry,
    inspect, merge, discard, prune, clear }
}
