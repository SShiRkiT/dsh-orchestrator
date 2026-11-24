import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isPathWithinScope, validateWriteScopeInput } from './write-lease.js'
import { normalizeScope, SCOPE_KIND } from './write-scope.js'

const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', '__pycache__'])
const MAX_ENTRIES = 30_000
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_SCAN_BYTES = 256 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const MAX_REPORT_ROWS = 8
const WINDOWS = process.platform === 'win32'
const ISOLATION_NOTE = '当前宿主不提供逐子代理物理只读文件系统沙箱；这里只做工作区逻辑写后审计并告警。' +
  '不会阻止写入，不覆盖工作区外或忽略目录，也不能区分并发写入者或检测两次采样间已还原的改动。'

const posixPath = (value) => value.split(path.sep).join('/')
const pathKey = (value) => WINDOWS ? value.toLowerCase() : value
const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0

function insideWorkspace(cwd, filename) {
  const relative = path.relative(cwd, filename)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null
  }
  return posixPath(relative)
}

function expectedPath(cwd, value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new TypeError('预期目标必须是非空文件路径。')
  }
  const relative = insideWorkspace(cwd, path.resolve(cwd, value))
  if (relative === null) throw new TypeError(`预期目标必须位于工作区内：${JSON.stringify(value)}。`)
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
    entries.set(key, Object.freeze({ path: relative, expected }))
  }
  return [...entries.values()].sort(byPath)
}

function targetPaths(cwd, expectedTargets) {
  if (expectedTargets == null) return []
  if (!Array.isArray(expectedTargets)) throw new TypeError('expectedTargets 必须是文件路径数组。')
  return expectedTargets.map((filename) => expectedPath(cwd, filename))
}

function scopeOf(writeScope, readOnly, cwd) {
  const validated = validateWriteScopeInput({ writeScope, readOnly })
  const normalized = validated.ok && !validated.readOnly
    ? normalizeScope(validated.entries, cwd)
    : validated
  if (!normalized.ok) {
    throw Object.assign(new TypeError(normalized.message), { code: normalized.code })
  }
  return normalized.entries
}

function sameObservation(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function fingerprint(filename, relative, stats, budget, chunk) {
  const hash = createHash('sha256')
  let bytes = 0
  let lines = 0
  let lastByte
  const consume = (data) => {
    bytes += data.length
    budget.bytes -= data.length
    hash.update(data)
    for (let offset = data.indexOf(10); offset !== -1; offset = data.indexOf(10, offset + 1)) {
      lines += 1
    }
    if (data.length > 0) lastByte = data[data.length - 1]
  }

  if (stats.isSymbolicLink()) {
    // Fingerprint the link itself, never its target (which may lie outside the workspace).
    const target = fs.readlinkSync(filename, { encoding: 'buffer' })
    if (target.length > budget.bytes) return { limited: true }
    consume(target)
    if (!sameObservation(stats, fs.lstatSync(filename))) return { unstable: true }
  } else {
    if (stats.size > MAX_FILE_BYTES || stats.size > budget.bytes) return { limited: true }
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants
    const fd = fs.openSync(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    try {
      const opened = fs.fstatSync(fd)
      if (!opened.isFile() || !sameObservation(stats, opened)) return { unstable: true }
      while (bytes < stats.size) {
        const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stats.size - bytes), null)
        if (count === 0) break
        consume(chunk.subarray(0, count))
      }
      if (bytes !== stats.size || !sameObservation(stats, fs.lstatSync(filename))) {
        return { unstable: true }
      }
    } finally {
      fs.closeSync(fd)
    }
  }
  return {
    file: Object.freeze({
      path: relative,
      sha256: hash.digest('hex'),
      bytes,
      lines: lines + (lastByte === 10 ? 0 : 1),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    }),
  }
}

function snapshot(cwd) {
  const files = []
  const issues = []
  const budget = { entries: MAX_ENTRIES, bytes: MAX_SCAN_BYTES }
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
  const pending = ['.']
  let truncated = false
  const recordIssue = (filename, reason, limited = false) => {
    issues.push(Object.freeze({ path: filename, reason }))
    if (limited) truncated = true
  }
  while (pending.length > 0) {
    const relativeDir = pending.pop()
    let dir
    try {
      const directory = path.join(cwd, relativeDir)
      if (relativeDir !== '.' && !fs.lstatSync(directory).isDirectory()) {
        recordIssue(relativeDir, '采样时目录发生变化')
        continue
      }
      dir = fs.opendirSync(directory)
      let entry
      while ((entry = dir.readSync()) !== null) {
        if (budget.entries === 0 || budget.bytes === 0) {
          recordIssue('.', '已达到扫描条目或总字节上限', true)
          return { files: files.sort(byPath), issues: issues.sort(byPath), truncated }
        }
        budget.entries -= 1
        if (pathKey(entry.name) === '.git' || (IGNORED_DIRS.has(pathKey(entry.name)) &&
            (entry.isDirectory() || entry.isSymbolicLink()))) continue
        const relative = relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`
        const filename = path.join(cwd, relative)
        try {
          const stats = fs.lstatSync(filename)
          if (stats.isDirectory()) {
            pending.push(relative)
          } else if (stats.isFile() || stats.isSymbolicLink()) {
            const result = fingerprint(filename, relative, stats, budget, chunk)
            if (result.file) files.push(result.file)
            else if (result.limited) recordIssue(relative, '超过单文件或剩余扫描字节上限', true)
            else recordIssue(relative, '采样时文件发生变化')
          }
        } catch (error) {
          recordIssue(relative, `无法采样：${error.code ?? error.name}`)
        }
      }
    } catch (error) {
      recordIssue(relativeDir, `无法读取目录：${error.code ?? error.name}`)
    } finally {
      dir?.closeSync()
    }
  }
  return { files: files.sort(byPath), issues: issues.sort(byPath), truncated }
}

const fileMap = (files) => new Map(files.map((file) => [pathKey(file.path), file]))

function coverageOf(issues) {
  const unknown = new Set(issues.map((issue) => pathKey(issue.path)))
  return (filename) => {
    if (unknown.has('.')) return false
    const pieces = pathKey(filename).split('/')
    let prefix = ''
    for (const [index, piece] of pieces.entries()) {
      if (piece === '.git' || (index < pieces.length - 1 && IGNORED_DIRS.has(piece))) return false
      prefix = prefix === '' ? piece : `${prefix}/${piece}`
      if (unknown.has(prefix)) return false
    }
    return true
  }
}

/** Freeze the full in-workspace observation before activation, including out-of-scope files. */
export function captureBaseline({
  cwd,
  writeScope = [],
  readOnly = false,
  expectedFingerprints = null,
  expectedTargets = null,
}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new TypeError('审计需要有效的 cwd。')
  const root = path.resolve(cwd)
  const entries = scopeOf(writeScope, readOnly, root)
  const expected = fingerprintEntries(root, expectedFingerprints)
  const targets = targetPaths(root, expectedTargets)
  const observed = snapshot(root)
  const original = fileMap(observed.files)
  for (const entry of entries) {
    if (entry.kind !== SCOPE_KIND.file) continue
    const relative = insideWorkspace(root, entry.path)
    const file = relative === null ? undefined : original.get(pathKey(relative))
    // A path named only in writeScope may be a planned creation, not a required deliverable.
    if (file !== undefined) targets.push(file.path)
  }
  return Object.freeze({
    baselineId: randomUUID(),
    cwd: root,
    writeScope: Object.freeze(typeof writeScope === 'string' ? [writeScope] : [...writeScope]),
    readOnly: readOnly === true,
    expectedFingerprints: Object.freeze(Object.fromEntries(expected.map((row) => [row.path, row.expected]))),
    expectedTargets: Object.freeze([...new Set(targets)].sort()),
    files: Object.freeze(observed.files),
    truncated: observed.truncated,
    scanIssues: Object.freeze(observed.issues),
  })
}

function compareFingerprints(expected, observed, covered, phase, violations) {
  for (const row of expected) {
    const actual = observed.get(pathKey(row.path))?.sha256
    if (actual === undefined && !covered(row.path)) {
      violations.push({ code: 'audit-incomplete', path: row.path, phase, reason: '无法核对预期指纹' })
    } else if (actual !== row.expected) {
      violations.push({ code: 'fingerprint-mismatch', path: row.path, expected: row.expected, actual: actual ?? null, phase })
    }
  }
}

/** Recompute current bytes. Capture expectations refer to the old bytes; settlement expectations to the final bytes. */
export function auditBaseline(baseline, {
  cwd,
  writeScope,
  readOnly,
  expectedFingerprints,
  expectedTargets,
} = {}) {
  const root = baseline.cwd
  if (cwd !== undefined && path.relative(root, path.resolve(cwd)) !== '') {
    throw new TypeError('审计结算必须使用冻结基线时的 cwd。')
  }
  const effectiveReadOnly = baseline.readOnly || readOnly === true
  const entries = scopeOf(baseline.writeScope, baseline.readOnly, root)
  const narrowed = writeScope === undefined ? entries : scopeOf(writeScope, effectiveReadOnly, root)
  const expected = fingerprintEntries(root, expectedFingerprints)
  const targets = new Map([...targetPaths(root, expectedTargets), ...baseline.expectedTargets]
    .map((filename) => [pathKey(filename), filename]))
  const current = snapshot(root)
  const before = fileMap(baseline.files)
  const after = fileMap(current.files)
  const coveredBefore = coverageOf(baseline.scanIssues)
  const coveredAfter = coverageOf(current.issues)
  const changedFiles = []
  const violations = [...baseline.scanIssues.map((issue) => ({ code: 'audit-incomplete', ...issue, phase: 'baseline' })),
    ...current.issues.map((issue) => ({ code: 'audit-incomplete', ...issue, phase: 'settlement' }))]

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key)
    const now = after.get(key)
    if ((!old && !coveredBefore(now.path)) || (!now && !coveredAfter(old.path))) continue
    if (old && now && old.sha256 === now.sha256 && old.mtimeMs === now.mtimeMs && old.path === now.path) continue
    const filename = (now ?? old).path
    const changeType = !old ? 'added' : !now ? 'deleted' : 'modified'
    changedFiles.push({ path: filename, sha256: now?.sha256 ?? null, bytes: now?.bytes ?? 0, lines: now?.lines ?? 0, changeType })
    const absolute = path.join(root, filename)
    if (effectiveReadOnly || !isPathWithinScope(absolute, entries, { cwd: root }) ||
        (narrowed !== entries && !isPathWithinScope(absolute, narrowed, { cwd: root }))) {
      violations.push({ code: 'out-of-scope-write', path: filename, changeType })
    }
  }

  compareFingerprints(fingerprintEntries(root, baseline.expectedFingerprints), before, coveredBefore, 'baseline', violations)
  compareFingerprints(expected, after, coveredAfter, 'settlement', violations)
  for (const [key, filename] of targets) {
    if (after.has(key)) continue
    if (coveredAfter(filename)) violations.push({ code: 'target-missing', path: filename })
    else violations.push({ code: 'audit-incomplete', path: filename, phase: 'settlement', reason: '无法核对目标是否存在' })
  }

  const summary = {
    added: 0,
    modified: 0,
    deleted: 0,
    violations: violations.length,
    truncated: baseline.truncated || current.truncated,
  }
  for (const file of changedFiles) summary[file.changeType] += 1
  return {
    baselineId: baseline.baselineId,
    passed: violations.length === 0,
    readOnly: effectiveReadOnly,
    isolationLevel: 'logical-post-audit',
    isolationNote: ISOLATION_NOTE,
    changedFiles: changedFiles.sort(byPath),
    violations: violations.sort(byPath),
    summary,
  }
}

/** Produce a bounded Chinese notice; structured evidence remains in the result. */
export function formatAuditReport(auditResult) {
  if (auditResult.passed) return ''
  const { baselineId, violations, summary } = auditResult
  const details = violations.slice(0, MAX_REPORT_ROWS).map(({ code, path: filename }) =>
    `- ${code}：${JSON.stringify(filename)}`)
  if (violations.length > details.length) details.push(`另有 ${violations.length - details.length} 项未列出。`)
  return [
    `写作用域审计未通过（基线 ${baselineId}，${violations.length} 项${summary.truncated ? '，采样已截断' : ''}）：`,
    ...details,
    auditResult.isolationNote,
  ].join('\n')
}
