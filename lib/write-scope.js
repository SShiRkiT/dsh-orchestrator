/**
 * Write scopes: the structured answer to "which files may this worker touch?".
 *
 * Why this exists: the only rule against two workers editing one file is a sentence in
 * `delegate`'s description (`lib/delegate.js:57`), and `orchestrate` does not even repeat
 * it. A sentence cannot be compared, so the plugin has no field to check before it starts
 * a second writer (Issue #1, S3/S4). This module turns that sentence into data: a declared
 * scope is parsed once, resolved against the dispatch `cwd`, reduced to a comparison key,
 * and two scopes can then be asked whether they intersect.
 *
 * Dependency-free on purpose, like every module under `lib/`: no `node:path`, no
 * `node:fs`. Paths are resolved lexically, and the one operation that needs the disk —
 * `realpath` — is injected by the caller. A missing resolver only costs symlink
 * resolution; it never changes the lexical answer, and it keeps the whole module testable
 * without the DSH runtime.
 *
 * Two representations are kept apart on purpose:
 * - `path` is what a human and the worker see: original case, `/` separators, no trailing
 *   slash unless the path is a filesystem root;
 * - `key` is what two scopes are compared by: `path` case-folded when the path follows
 *   Windows rules. Folding the display path itself would make every message point at a
 *   file that does not exist.
 *
 * Kinds of claim:
 * - `file` — one exact path, whether it exists yet or the worker is about to create it;
 * - `dir`  — a directory prefix, spelled `src/` or `src/**`;
 * - `root` — "I claim everything", spelled `*` or reached by a filesystem root such as
 *   `/` or `C:/`. A root claim intersects every other scope, including paths outside the
 *   workspace: that is the conservative reading of an unknown writer that
 *   `docs/zh/03-issue-0001-write-scope.md` §6.1 asks for, and it is why `*` is the
 *   discouraged escape hatch rather than a convenient default.
 *
 * A scope says nothing about *time*. Two disjoint scopes may run at once; two intersecting
 * ones must be serialized or refused by the caller, which is what `lib/write-lease.js`
 * does with these entries.
 */

/** Structured refusal codes; callers branch on these, never on the message text. */
export const WRITE_SCOPE_CODES = Object.freeze({
  missing: 'write-scope-missing',
  empty: 'write-scope-empty',
  invalid: 'write-scope-invalid',
  noCwd: 'write-scope-cwd-missing',
})

/** The three claims a scope entry can make. */
export const SCOPE_KIND = Object.freeze({
  file: 'file',
  dir: 'dir',
  root: 'root',
})

/** The one accepted spelling of "I claim the whole workspace". */
export const ROOT_CLAIM = '*'

/** Broader claims win when two entries reduce to the same comparison key. */
const KIND_RANK = Object.freeze({ root: 3, dir: 2, file: 1 })

const WIN_DRIVE = /^[A-Za-z]:[\\/]/
const WIN_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/
const UNC_START = /^[\\/]{2}[^\\/]/
const CONTROL_CHARS = /[\u0000-\u001f]/
const GLOB_CHARS = /[*?]/
const GLOB_SUFFIX = /[\\/]\*\*[\\/]*$/
const TRAILING_SEPARATORS = /[\\/]+$/
const HOME_PREFIX = /^~([\\/]|$)/
const TRAILING_SLASHES = /\/+$/

/** Why one declaration was rejected, in words a caller can show the model. */
const REJECT_REASON = Object.freeze({
  glob: '不支持通配符，目录请用尾随 "/" 或 "/**" 表示',
  control: '包含控制字符',
  home: '不支持 "~" 展开，请写绝对路径或相对当前目录的路径',
  driveRelative: '盘符相对路径（如 "C:file"）语义不确定，请写成 "C:/..."',
  unresolvable: '无法解析为绝对路径',
})

function refusal(code, message) {
  return { ok: false, code, message }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/** A short, model-readable description of a value in a refusal message. */
function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value
}

/**
 * Whether a path follows Windows rules: a drive (`C:\`, `C:/`) or a backslash UNC share
 * (`\\host\share`). The flavour decides both separator handling and case folding, so a
 * scope should never mix flavours.
 */
export function isWindowsPath(value) {
  if (typeof value !== 'string') return false
  return WIN_DRIVE.test(value) || value.startsWith('\\\\')
}

/**
 * Validate the raw tool argument. Accepts one path or an array of paths, nothing else.
 *
 * `undefined`/`null` answers `missing` instead of `empty`, because "the caller said
 * nothing" and "the caller claimed nothing" are different policies: the first is the
 * unknown writer that §6.1 treats conservatively, the second is a mistake.
 */
export function parseWriteScope(value) {
  if (value === undefined || value === null) {
    return refusal(
      WRITE_SCOPE_CODES.missing,
      '缺少 write_scope：写任务必须声明要修改的文件或目录（目录用尾随 "/" 或 "/**" 表示），否则无法与其他写者判重。',
    )
  }
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list)) {
    return refusal(
      WRITE_SCOPE_CODES.invalid,
      `write_scope 必须是路径字符串或路径字符串数组，收到 ${describeValue(value)}。`,
    )
  }
  if (list.length === 0) {
    return refusal(
      WRITE_SCOPE_CODES.empty,
      'write_scope 是空数组：没有要修改的文件就不应声明写作用域；省略该字段表示"未知"，由调用方按保守策略处理。',
    )
  }
  const entries = []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (!isNonEmptyString(item)) {
      return refusal(
        WRITE_SCOPE_CODES.invalid,
        `write_scope 只能包含非空字符串，第 ${index + 1} 项是 ${describeValue(item)}。`,
      )
    }
    entries.push(item)
  }
  return { ok: true, entries }
}

/**
 * Split one raw declaration into its claim kind and the path to resolve.
 * `*` is the workspace claim; a trailing `/**` or separator makes a directory claim.
 */
function splitClaim(raw) {
  if (raw === ROOT_CLAIM) return { kind: SCOPE_KIND.root, path: '.' }
  const globbed = GLOB_SUFFIX.test(raw)
  const directory = globbed || TRAILING_SEPARATORS.test(raw)
  const path = globbed ? raw.replace(GLOB_SUFFIX, '') : raw
  return { kind: directory ? SCOPE_KIND.dir : SCOPE_KIND.file, path: path === '' ? '/' : path }
}

/** Whether a value is already rooted, under the rules of the given flavour. */
function isAbsoluteFor(value, win) {
  if (win) return WIN_DRIVE.test(value) || UNC_START.test(value)
  return value.startsWith('/')
}

/**
 * Lexical resolution to an absolute path: `/` separators, `.` and `..` folded in, no
 * trailing separator. `..` clamps at the root exactly like `path.resolve`, so a relative
 * path can never silently name something above the filesystem root.
 *
 * Returns `{ path, isRoot }`, or `undefined` for a shape the plugin refuses to guess:
 * a drive-relative path (`C:file`) or a malformed UNC share (`\\host`).
 */
function normalizeAbsolute(value, win) {
  if (!isNonEmptyString(value) || CONTROL_CHARS.test(value)) return undefined
  const text = win ? value.replace(/\\/g, '/') : value
  let root = ''
  let rest = text
  if (win) {
    if (WIN_DRIVE.test(text)) {
      root = text.slice(0, 2) + '/'
      rest = text.slice(3)
    } else if (text.startsWith('//')) {
      const parts = text.slice(2).split('/')
      const server = parts.shift()
      const share = parts.shift()
      if (!isNonEmptyString(server) || !isNonEmptyString(share)) return undefined
      root = `//${server}/${share}/`
      rest = parts.join('/')
    } else {
      return undefined
    }
  } else if (text.startsWith('/')) {
    root = '/'
    rest = text.slice(1)
  } else {
    return undefined
  }
  const segments = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return { path: root + segments.join('/'), isRoot: segments.length === 0 }
}

/** One normalized entry. `path` is for humans, `key` is for comparisons. */
function makeEntry(absolute, kind, fold) {
  return {
    path: absolute.path,
    key: fold ? absolute.path.toLowerCase() : absolute.path,
    kind: absolute.isRoot ? SCOPE_KIND.root : kind,
  }
}

/** Resolve one claim into an entry, or report the reason it cannot be resolved. */
function resolveEntry(claim, win, base, fold) {
  const text = claim.path
  if (CONTROL_CHARS.test(text)) return { reason: REJECT_REASON.control }
  if (claim.kind !== SCOPE_KIND.root && GLOB_CHARS.test(text)) return { reason: REJECT_REASON.glob }
  if (HOME_PREFIX.test(text)) return { reason: REJECT_REASON.home }
  if (win && WIN_DRIVE_RELATIVE.test(text)) return { reason: REJECT_REASON.driveRelative }
  const workspaceClaim = claim.kind === SCOPE_KIND.root && text === '.'
  // `/repo/a` on Windows is rooted on the current drive, not a sibling of the cwd. The
  // drive is the one the dispatch cwd is on, which is also what `path.resolve` uses.
  const rootedOnDrive = win && /^[\\/]/.test(text) && !isAbsoluteFor(text, win)
  let absoluteText
  if (rootedOnDrive) {
    const drive = base === undefined ? undefined : /^[A-Za-z]:/.exec(base.path)
    if (drive === undefined || drive === null) return { reason: REJECT_REASON.unresolvable }
    absoluteText = `${drive[0]}/${text.replace(/^[\\/]+/, '')}`
  } else {
    absoluteText = !workspaceClaim && isAbsoluteFor(text, win) ? text : `${base.path}/${text}`
  }
  const absolute = normalizeAbsolute(absoluteText, win)
  if (absolute === undefined) return { reason: REJECT_REASON.unresolvable }
  return { entry: makeEntry(absolute, claim.kind, fold) }
}

/** Whether `key` is `prefix` itself or lives under it. A filesystem root keeps its "/". */
function underKey(key, prefix) {
  if (key === prefix) return true
  if (prefix === '') return true
  return key.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

/**
 * Whether one normalized entry covers another: a root covers all, a dir covers its
 * subtree, a file covers only itself. A root *target* is a subtree of its own path, so it
 * is covered exactly when that path is; `overlaps` is the separate, much stricter rule
 * that a root claim intersects everything.
 */
function entryContains(holder, target) {
  if (holder.kind === SCOPE_KIND.root) return true
  if (holder.kind === SCOPE_KIND.dir) return underKey(target.key, holder.key)
  return holder.key === target.key && target.kind === SCOPE_KIND.file
}

/**
 * Sort by comparison key and drop duplicates, keeping the broader claim of a key:
 * `lib/` and `lib` name the same place, and the directory claim must survive because it
 * is the one that also covers the files inside.
 */
function finalize(entries) {
  const sorted = [...entries].sort((left, right) => {
    if (left.key !== right.key) return left.key < right.key ? -1 : 1
    const rank = (KIND_RANK[right.kind] ?? 0) - (KIND_RANK[left.kind] ?? 0)
    if (rank !== 0) return rank
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
  const seen = new Set()
  const kept = []
  for (const entry of sorted) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    kept.push(entry)
  }
  return kept
}

/**
 * Normalize a declared scope against the dispatch directory.
 *
 * @param entries - one path or an array of paths, as the caller declared them.
 * @param cwd - the absolute dispatch directory. Required only when a declaration is
 *   relative or is the `*` workspace claim; an all-absolute scope needs no base.
 * @param options.caseInsensitive - overrides the Windows case-folding rule. `undefined`
 *   keeps the rule, `false` turns it off (useful to compare POSIX paths on Windows).
 * @param options.realpath - optional `(absolutePath) => absolutePath | undefined`
 *   resolver. A throw or a missing path is not fatal: the lexical answer is kept and the
 *   path is reported in `unresolved`.
 * @returns `{ ok: true, scope, entries, root, outsideWorkspace, unresolved }`, or
 *   `{ ok: false, code, message }` with a `write-scope-*` code. It never throws: a bad
 *   declaration is a refusal the caller turns into a tool error, not an exception.
 */
export function normalizeScope(entries, cwd, { caseInsensitive, realpath } = {}) {
  const parsed = parseWriteScope(entries)
  if (!parsed.ok) return parsed

  let base
  if (isNonEmptyString(cwd)) {
    const win = isWindowsPath(cwd)
    const absolute = normalizeAbsolute(cwd, win)
    if (absolute === undefined) {
      return refusal(
        WRITE_SCOPE_CODES.noCwd,
        `cwd 不是可解析的绝对路径：${JSON.stringify(cwd)}。`,
      )
    }
    base = { path: absolute.path, isRoot: absolute.isRoot, win }
  }

  const resolved = []
  const rejected = []
  const unresolved = []
  const resolveReal = typeof realpath === 'function' ? realpath : undefined

  for (const raw of parsed.entries) {
    const claim = splitClaim(raw)
    const win = base !== undefined && base.win ? true : isWindowsPath(claim.path)
    const needsBase =
      claim.kind === SCOPE_KIND.root && claim.path === '.'
        ? true
        : !isAbsoluteFor(claim.path, win)
    if (needsBase && base === undefined) {
      return refusal(
        WRITE_SCOPE_CODES.noCwd,
        `写作用域 ${JSON.stringify(raw)} 是相对路径，必须先给出 cwd。`,
      )
    }
    const fold = caseInsensitive === undefined ? win : caseInsensitive === true
    const outcome = resolveEntry(claim, win, base, fold)
    if (outcome.entry === undefined) {
      rejected.push({ raw, reason: outcome.reason })
      continue
    }
    let entry = outcome.entry
    if (resolveReal !== undefined) {
      let real
      try {
        real = resolveReal(entry.path)
      } catch {
        // A resolver that cannot answer is a missing fact, not a failed dispatch.
        real = undefined
      }
      const absolute = isNonEmptyString(real) ? normalizeAbsolute(real, win) : undefined
      if (absolute === undefined) {
        unresolved.push(entry.path)
      } else {
        entry = makeEntry(absolute, entry.kind, fold)
      }
    }
    resolved.push(entry)
  }

  if (rejected.length > 0) {
    const detail = rejected.map(({ raw, reason }) => `${JSON.stringify(raw)}（${reason}）`).join('；')
    return refusal(
      WRITE_SCOPE_CODES.invalid,
      `write_scope 有 ${rejected.length} 项无法解析：${detail}。`,
    )
  }

  const kept = finalize(resolved)
  const root = kept.some((entry) => entry.kind === SCOPE_KIND.root)
  const outsideWorkspace = []
  if (base !== undefined) {
    const baseFold = caseInsensitive === undefined ? base.win : caseInsensitive === true
    const workspace = makeEntry({ path: base.path, isRoot: base.isRoot }, SCOPE_KIND.dir, baseFold)
    for (const entry of kept) {
      if (!entryContains(workspace, entry)) outsideWorkspace.push(entry.path)
    }
  }

  return {
    ok: true,
    scope: Object.freeze(kept.map((entry) => entry.path)),
    entries: Object.freeze(kept.map((entry) => Object.freeze(entry))),
    root,
    outsideWorkspace: Object.freeze(outsideWorkspace),
    unresolved: Object.freeze(unresolved),
  }
}

/**
 * Whether two normalized entries claim the same bytes on disk. A root claim matches every
 * other entry, which is what makes `*` a real exclusion rather than a comment.
 */
export function overlaps(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false
  if (left.kind === SCOPE_KIND.root || right.kind === SCOPE_KIND.root) return true
  // Either side may be the directory, and two directories may nest in either order.
  if (left.kind === SCOPE_KIND.dir || right.kind === SCOPE_KIND.dir) {
    return underKey(left.key, right.key) || underKey(right.key, left.key)
  }
  return left.key === right.key
}

/**
 * Index pairs of a single normalized scope that intersect each other. `orchestrate` uses
 * this to serialize items of one batch before any worker starts; a single writer's own
 * scope is allowed to overlap itself.
 */
export function findOverlaps(entries) {
  const pairs = []
  if (!Array.isArray(entries)) return pairs
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (overlaps(entries[left], entries[right])) pairs.push([left, right])
    }
  }
  return pairs
}

/** Whether one normalized entry is a well-formed scope entry. */
export function isScopeEntry(value) {
  if (value === null || typeof value !== 'object') return false
  if (!isNonEmptyString(value.path) || !isNonEmptyString(value.key)) return false
  return (
    value.kind === SCOPE_KIND.file || value.kind === SCOPE_KIND.dir || value.kind === SCOPE_KIND.root
  )
}

/** Whether a value is a whole normalized scope, as returned by `normalizeScope`. */
export function isNormalizedScope(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isScopeEntry)
}

/** Union of scope entry lists, normalized the same way `normalizeScope` normalizes. */
export function mergeScope(...lists) {
  const all = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!isScopeEntry(entry)) continue
      all.push(entry)
    }
  }
  return Object.freeze(finalize(all))
}

/**
 * Whether a scope covers one path: the future "out-of-scope write" check needs the same
 * answer the lease table gives, without opening a lease.
 */
export function coversPath(entries, target, { cwd, caseInsensitive } = {}) {
  if (!isNormalizedScope(entries)) return false
  const normalized = normalizeScope([target], cwd, { caseInsensitive })
  if (!normalized.ok) return false
  const wanted = normalized.entries[0]
  return entries.some((entry) => entryContains(entry, wanted))
}

/** Human-readable scope, for prompts, notices and refusal messages. */
export function describeScope(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '（未声明写作用域）'
  return entries
    .map((entry) => {
      if (entry.kind === SCOPE_KIND.root) return `${entry.path.replace(TRAILING_SLASHES, '')}/**`
      if (entry.kind === SCOPE_KIND.dir) return `${entry.path.replace(TRAILING_SLASHES, '')}/`
      return entry.path
    })
    .join(', ')
}
