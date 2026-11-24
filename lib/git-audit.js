import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isPathWithinScope, validateWriteScopeInput } from './write-lease.js'
import { normalizeScope, SCOPE_KIND } from './write-scope.js'
import { WORKTREE_POOL_DIRNAME } from './worktree.js'

const WINDOWS = process.platform === 'win32'
const MAX_FILE_BYTES = 64 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const MAX_REPORT_ROWS = 8
const ISOLATION_NOTE = '子代理在独立 Git 工作树中执行；审计覆盖 Git 可见净变更，不是操作系统写权限沙箱。' +
  '不会识别普通忽略文件、已还原的未提交改动，也不会将主仓污点归因给该子代理。'
const posix = (value) => value.split(path.sep).join('/')
const pathKey = (value) => WINDOWS ? value.toLowerCase() : value
const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0
const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR'
const gitError = (error) => String(error.stderr || error.message).trim()

function git(cwd, ...args) {
  const bytes = execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // A lossy decode could conflate two filenames; fail closed instead.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

function relativeInside(root, filename) {
  const relative = path.relative(root, filename)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return posix(relative)
}

function expectedPath(cwd, value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError('预期目标必须是非空文件路径。')
  }
  const relative = relativeInside(cwd, path.resolve(cwd, value))
  if (!relative) throw new TypeError(`预期目标必须位于工作区内：${JSON.stringify(value)}。`)
  return relative
}

function fingerprintEntries(cwd, expectedFingerprints) {
  if (expectedFingerprints == null) return []
  if (typeof expectedFingerprints !== 'object' || Array.isArray(expectedFingerprints)) {
    throw new TypeError('expectedFingerprints 必须是从文件路径到 SHA-256 的对象。')
  }
  const entries = new Map()
  for (const [filename, sha256] of Object.entries(expectedFingerprints)) {
    if (typeof sha256 !== 'string' || sha256 === '') {
      throw new TypeError(`预期指纹必须是非空字符串：${JSON.stringify(filename)}。`)
    }
    const relative = expectedPath(cwd, filename)
    const key = pathKey(relative)
    const expected = sha256.toLowerCase()
    if (entries.has(key) && entries.get(key).expected !== expected) {
      throw new TypeError(`同一文件声明了不同的预期指纹：${JSON.stringify(filename)}。`)
    }
    entries.set(key, { path: relative, expected })
  }
  return [...entries.values()].sort(byPath)
}

function targetPaths(cwd, expectedTargets) {
  if (expectedTargets == null) return []
  if (!Array.isArray(expectedTargets)) throw new TypeError('expectedTargets 必须是文件路径数组。')
  return expectedTargets.map((filename) => expectedPath(cwd, filename))
}

function scopeOf(cwd, writeScope, readOnly) {
  const validated = validateWriteScopeInput({ writeScope, readOnly })
  const normalized = validated.ok && !validated.readOnly ? normalizeScope(validated.entries, cwd) : validated
  if (!normalized.ok) throw Object.assign(new TypeError(normalized.message), { code: normalized.code })
  return normalized.entries
}

function observationMatches(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function fileObservation(root, realRoot, relative, fingerprint = true) {
  try {
    const filename = path.resolve(root, relative)
    if (!relativeInside(root, filename) || relative.split('/').some((part) => pathKey(part) === '.git')) {
      return { exists: null, reason: '目标超出文件审计边界' }
    }
    // Never follow a symlink/junction in the parent chain out of the checkout.
    const realParent = fs.realpathSync.native(path.dirname(filename))
    if (relativeInside(realRoot, realParent) === null) return { exists: null, reason: '目标父目录指向工作树外部' }
    const stats = fs.lstatSync(filename)
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      return fingerprint ? { exists: false, reason: '目标不是普通文件或符号链接' } : { exists: false }
    }
    if (!fingerprint) return { exists: true }
    if (stats.isFile() && stats.size > MAX_FILE_BYTES) return { exists: true, reason: '超过单文件采样上限' }

    const hash = createHash('sha256')
    let bytes = 0
    let lines = 0
    let lastByte
    const consume = (data) => {
      hash.update(data)
      bytes += data.length
      for (let offset = data.indexOf(10); offset !== -1; offset = data.indexOf(10, offset + 1)) lines += 1
      if (data.length > 0) lastByte = data[data.length - 1]
    }
    if (stats.isSymbolicLink()) {
      consume(fs.readlinkSync(filename, { encoding: 'buffer' }))
    } else {
      const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants
      const fd = fs.openSync(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      try {
        const opened = fs.fstatSync(fd)
        if (!opened.isFile() || !observationMatches(stats, opened)) return { exists: true, reason: '采样时文件发生变化' }
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stats.size))
        while (bytes < stats.size) {
          const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stats.size - bytes), null)
          if (count === 0) break
          consume(chunk.subarray(0, count))
        }
        if (bytes !== stats.size) return { exists: true, reason: '采样时文件发生变化' }
      } finally {
        fs.closeSync(fd)
      }
    }
    if (!observationMatches(stats, fs.lstatSync(filename))) return { exists: true, reason: '采样时文件发生变化' }
    return { exists: true, sha256: hash.digest('hex'), bytes, lines: lines + (lastByte === 10 ? 0 : 1) }
  } catch (error) {
    return missing(error) ? { exists: false } : { exists: null, reason: `无法采样：${error.code ?? error.name}` }
  }
}

function readStatus(root) {
  const dirty = []
  const untracked = []
  const args = ['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=none', '--untracked-files=all']
  for (const row of git(root, ...args).split('\0').filter(Boolean)) {
    const filename = row.slice(3)
    dirty.push(filename)
    if (row.startsWith('??')) untracked.push(filename)
  }
  return { dirty, untracked }
}

function diffRows(root, ...revisions) {
  const tokens = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
    '--no-renames', '--name-status', '-z', ...revisions, '--').split('\0')
  const files = new Map()
  for (let index = 0; index < tokens.length - 1; index += 2) {
    const type = tokens[index]
    const filename = tokens[index + 1]
    if (!filename) throw new Error('Git name-status 没有返回有效路径。')
    files.set(filename, type === 'A' ? 'added' : type === 'D' ? 'deleted' : 'modified')
  }
  return files
}

function checkoutRoot(cwd) {
  return fs.realpathSync.native(git(cwd, 'rev-parse', '--show-toplevel').replace(/\r?\n$/, ''))
}

function assertCheckout(worktreePath) {
  if (!fs.lstatSync(worktreePath).isDirectory() ||
      path.relative(checkoutRoot(worktreePath), fs.realpathSync.native(worktreePath)) !== '') {
    throw new TypeError('目录不是冻结的 Git 工作树根目录。')
  }
}

export function captureGitBaseline({ worktree, cwd = null, repoRoot = null, writeScope = [], readOnly = false,
  expectedFingerprints = null, expectedTargets = null }) {
  if (!worktree || typeof worktree.worktreePath !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(worktree.baseCommit)) {
    throw new TypeError('Git 审计需要工作树路径和有效的冻结基线提交。')
  }
  const worktreePath = path.resolve(worktree.worktreePath)
  const execCwd = path.resolve(cwd ?? worktree.execCwd ?? worktreePath)
  const sourceRoot = path.resolve(repoRoot ?? worktree.repoRoot)
  assertCheckout(worktreePath)
  const realRoot = fs.realpathSync.native(worktreePath)
  if (relativeInside(worktreePath, execCwd) === null || relativeInside(realRoot, fs.realpathSync.native(execCwd)) === null) {
    throw new TypeError('Git 审计的执行目录必须位于冻结的工作树内。')
  }
  const entries = scopeOf(execCwd, writeScope, readOnly)
  const fingerprints = fingerprintEntries(execCwd, expectedFingerprints)
  const fingerprintKeys = new Set(fingerprints.map((row) => pathKey(row.path)))
  const explicitTargets = targetPaths(execCwd, expectedTargets)
  const targets = new Map(explicitTargets.map((filename) => [pathKey(filename), filename]))
  const selected = new Map([...explicitTargets, ...fingerprints.map((row) => row.path)]
    .map((filename) => [pathKey(filename), filename]))
  const declaredFiles = new Map()
  for (const entry of entries) {
    if (entry.kind !== SCOPE_KIND.file) continue
    const filename = relativeInside(execCwd, entry.path)
    if (!filename) continue
    const key = pathKey(filename)
    declaredFiles.set(key, filename)
    if (!selected.has(key)) selected.set(key, filename)
  }
  const targetSnapshots = []
  const baselineIssues = []
  for (const [key, filename] of selected) {
    const entry = fileObservation(worktreePath, realRoot, posix(path.relative(worktreePath, path.resolve(execCwd, filename))))
    targetSnapshots.push(Object.freeze({ path: filename, ...entry }))
    if (declaredFiles.has(key) && entry.exists) targets.set(key, filename)
    if (entry.exists === null && declaredFiles.has(key) && !fingerprintKeys.has(key)) {
      baselineIssues.push(Object.freeze({ code: 'audit-incomplete', path: filename, phase: 'baseline', reason: entry.reason }))
    }
  }
  return Object.freeze({
    baselineId: randomUUID(), kind: 'git-worktree', worktreeId: worktree.id, worktreePath, execCwd, cwd: execCwd,
    repoRoot: sourceRoot, branch: worktree.branch, baseCommit: worktree.baseCommit,
    writeScope: Object.freeze(typeof writeScope === 'string' ? [writeScope] : [...writeScope]), readOnly: readOnly === true,
    expectedFingerprints: Object.freeze(Object.fromEntries(fingerprints.map((row) => [row.path, row.expected]))),
    expectedTargets: Object.freeze([...targets.values()].sort()), capturedAt: Date.now(),
    targetSnapshots: Object.freeze(targetSnapshots.sort(byPath)), baselineIssues: Object.freeze(baselineIssues),
    mainBeforeDirty: Object.freeze(readStatus(sourceRoot).dirty),
  })
}

function listCommits(root, baseCommit) {
  return git(root, 'log', '--format=%H%x1f%h%x1f%s', `${baseCommit}..HEAD`, '--')
    .split('\n').filter(Boolean).map((row) => {
      const [hash, shortHash, ...subject] = row.split('\x1f')
      return { hash, shortHash, subject: subject.join('\x1f') }
    })
}

function compareFingerprint(row, observation, phase, violations) {
  const actual = observation?.sha256
  if (actual == null && (phase === 'baseline' || observation?.exists !== false)) {
    violations.push({ code: 'audit-incomplete', path: row.path, phase, reason: observation?.reason ?? '无法核对预期指纹' })
  } else if (actual !== row.expected) {
    violations.push({ code: 'fingerprint-mismatch', path: row.path, phase, expected: row.expected, actual: actual ?? null })
  }
}

// An index deletion can make a recreated file appear both deleted and untracked.
// Compare the recreated object (after Git's normal clean conversion) with the base tree.
function replacesBaseFile(root, baseCommit, filename, observation) {
  const entry = git(root, 'ls-tree', '-z', baseCommit, '--', filename)
  const match = /^(100(?:644|755)|120000) blob ([a-f0-9]+)\t/.exec(entry)
  if (!match || !observation.exists) return true
  const absolute = path.resolve(root, filename)
  const stats = fs.lstatSync(absolute)
  const symlink = stats.isSymbolicLink()
  if ((match[1] === '120000') !== symlink) return true
  if (!symlink && !WINDOWS && (match[1] === '100755') !== Boolean(stats.mode & 0o100)) return true
  if (symlink) {
    const data = fs.readlinkSync(absolute, { encoding: 'buffer' })
    const algo = match[2].length === 64 ? 'sha256' : 'sha1'
    return createHash(algo).update(`blob ${data.length}\0`).update(data).digest('hex') !== match[2]
  }
  return git(root, 'hash-object', `--path=${filename}`, '--', absolute).trim() !== match[2]
}

export function auditGitBaseline(baseline, overrides = {}) {
  const { execCwd, worktreePath, repoRoot, baseCommit } = baseline
  const { cwd, writeScope, readOnly, expectedFingerprints, expectedTargets } = overrides
  if (cwd !== undefined && path.relative(execCwd, path.resolve(cwd)) !== '') {
    throw new TypeError('审计结算必须使用冻结基线时的 cwd。')
  }
  const effectiveReadOnly = baseline.readOnly || readOnly === true
  const entries = scopeOf(execCwd, baseline.writeScope, baseline.readOnly)
  const narrowed = writeScope === undefined ? entries : scopeOf(execCwd, writeScope, effectiveReadOnly)
  const expected = fingerprintEntries(execCwd, expectedFingerprints)
  const targets = new Map([...targetPaths(execCwd, expectedTargets), ...baseline.expectedTargets]
    .map((filename) => [pathKey(filename), filename]))
  const before = new Map(baseline.targetSnapshots.map((row) => [pathKey(row.path), row]))
  const violations = [...baseline.baselineIssues]
  const changedFiles = []
  let commits = []
  let headCommit = null
  let dirtyFiles = []
  let mainWorkspaceTaint = []
  let isolationNote = ISOLATION_NOTE
  const incomplete = (filename, reason) => violations.push({ code: 'audit-incomplete', path: filename, phase: 'settlement', reason })

  for (const row of fingerprintEntries(execCwd, baseline.expectedFingerprints)) {
    compareFingerprint(row, before.get(pathKey(row.path)), 'baseline', violations)
  }
  try {
    assertCheckout(worktreePath)
    const realRoot = fs.realpathSync.native(worktreePath)
    headCommit = git(worktreePath, 'rev-parse', 'HEAD').trim()
    commits = listCommits(worktreePath, baseCommit)
    const committed = diffRows(worktreePath, `${baseCommit}..HEAD`)
    const staged = diffRows(worktreePath, '--cached')
    const unstaged = diffRows(worktreePath)
    const current = readStatus(worktreePath)
    dirtyFiles = [...new Set([...staged.keys(), ...unstaged.keys(), ...current.dirty])]
    const net = diffRows(worktreePath, baseCommit)
    const untracked = new Set(current.untracked)
    const post = new Map()
    const observe = (repoRelative, fingerprint = true) => {
      const key = `${fingerprint}:${repoRelative}`
      if (!post.has(key)) post.set(key, fileObservation(worktreePath, realRoot, repoRelative, fingerprint))
      return post.get(key)
    }
    // Restrict byte observations to the effective change set, not every historical path.
    for (const filename of new Set([...committed.keys(), ...staged.keys(), ...unstaged.keys(), ...net.keys(), ...untracked])) {
      let changeType = net.get(filename)
      let observation
      if (untracked.has(filename)) {
        observation = observe(filename)
        if (changeType === 'deleted') {
          if (observation.sha256 && !replacesBaseFile(worktreePath, baseCommit, filename, observation)) continue
          changeType = 'modified'
        } else changeType ??= 'added'
      }
      if (!changeType) continue
      const absolute = path.resolve(worktreePath, filename)
      const relative = posix(path.relative(execCwd, absolute))
      const inExecCwd = Boolean(relativeInside(execCwd, absolute))
      if (changeType !== 'deleted') {
        observation ??= observe(filename)
        if (observation.exists === false && !observation.reason) {
          if (changeType === 'added') continue
          changeType = 'deleted'
        } else if (!observation.sha256) incomplete(relative, observation.reason ?? '无法计算变更文件指纹')
      }
      changedFiles.push({ path: relative, changeType,
        sha256: changeType === 'deleted' ? null : observation.sha256 ?? null,
        bytes: changeType === 'deleted' ? 0 : observation.bytes ?? 0,
        lines: changeType === 'deleted' ? 0 : observation.lines ?? 0,
      })
      if (effectiveReadOnly) violations.push({ code: 'readonly-write', path: relative, changeType })
      else if (!inExecCwd || !isPathWithinScope(absolute, entries, { cwd: execCwd }) ||
          (narrowed !== entries && !isPathWithinScope(absolute, narrowed, { cwd: execCwd }))) {
        violations.push({ code: 'out-of-scope-write', path: relative, changeType })
      }
    }

    const toRepoPath = (filename) => posix(path.relative(worktreePath, path.resolve(execCwd, filename)))
    for (const row of expected) compareFingerprint(row, observe(toRepoPath(row.path)), 'settlement', violations)
    for (const filename of targets.values()) {
      const observation = observe(toRepoPath(filename), false)
      if (observation.exists === false) violations.push({ code: 'target-missing', path: filename })
      else if (observation.exists === null) incomplete(filename, observation.reason ?? '无法核对目标是否存在')
    }
  } catch (error) {
    incomplete('.', `无法完成 Git 工作树采样：${gitError(error)}`)
  }

  try {
    const previous = new Set(baseline.mainBeforeDirty.map(pathKey))
    const pool = pathKey(WORKTREE_POOL_DIRNAME)
    mainWorkspaceTaint = readStatus(repoRoot).dirty
      .filter((filename) => !previous.has(pathKey(filename)) && pathKey(filename) !== pool &&
        !pathKey(filename).startsWith(`${pool}/`)).sort()
  } catch (error) {
    isolationNote += `无法观测主仓污点：${gitError(error)}`
  }

  const summary = { added: 0, modified: 0, deleted: 0, violations: violations.length, truncated: false,
    commits: commits.length, dirty: dirtyFiles.length > 0 }
  for (const file of changedFiles) summary[file.changeType] += 1
  return {
    baselineId: baseline.baselineId, passed: violations.length === 0, readOnly: effectiveReadOnly,
    isolationLevel: 'git-worktree', isolationNote,
    changedFiles: changedFiles.sort(byPath), violations: violations.sort(byPath), summary,
    git: { worktreeId: baseline.worktreeId, worktreePath, branch: baseline.branch, baseCommit, headCommit,
      commits, dirtyFiles: dirtyFiles.sort(), mainWorkspaceTaint },
  }
}

export function formatGitAuditReport(auditResult) {
  const { baselineId, passed, violations, summary, git: evidence } = auditResult
  const details = violations.slice(0, MAX_REPORT_ROWS).map(({ code, path: filename }) =>
    `- ${code}：${JSON.stringify(filename)}`)
  if (violations.length > details.length) details.push(`另有 ${violations.length - details.length} 项未列出。`)
  return [
    `写作用域审计${passed ? '通过' : '未通过'}（git-worktree；基线 ${baselineId}；分支 ${evidence.branch}；${summary.commits} 个提交）。`,
    ...(summary.dirty ? [`工作树有 ${evidence.dirtyFiles.length} 项未提交改动。`] : []),
    ...(evidence.mainWorkspaceTaint.length ? [`主仓出现 ${evidence.mainWorkspaceTaint.length} 项新增污点（仅观测）。`] : []),
    ...details,
  ].join('\n')
}
