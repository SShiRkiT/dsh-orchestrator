import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createWorktreeManager, ensurePoolIgnore, probeGitRepo, WORKTREE_BRANCH_PREFIX,
  WORKTREE_POOL_DIRNAME, WORKTREE_POOL_SUBDIR, WORKTREE_STATES } from '../lib/worktree.js'

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
  }).trimEnd()
}

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worktree-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return fs.realpathSync.native(dir)
}

function write(cwd, filename, text) {
  const target = path.join(cwd, filename)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

function init(dir) {
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.name', 'Worktree Test')
  git(dir, 'config', 'user.email', 'worktree-test@example.invalid')
  git(dir, 'config', 'core.autocrlf', 'false')
  return dir
}

function commit(cwd, message) {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function repo(t) {
  const dir = init(temp(t))
  write(dir, '.gitignore', 'ignored.txt\n')
  write(dir, 'nested/base.txt', 'base\n')
  write(dir, 'staged.txt', 'base\n')
  write(dir, 'unstaged.txt', 'base\n')
  return { dir, baseCommit: commit(dir, 'Initial') }
}

function create(manager, dir, options = {}) {
  const result = manager.create({ sourceCwd: dir, workspaceRoot: dir, ...options })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.worktree
}

function assertBranchGone(dir, branch) {
  assert.equal(git(dir, 'branch', '--list', branch), '')
}

test('probeGitRepo distinguishes normal, nested, detached, unborn and outside directories', (t) => {
  const outside = temp(t)
  assert.deepEqual(probeGitRepo(outside), {
    isGit: false, repoRoot: null, gitCommonDir: null, headCommit: null, headBranch: null,
    subPath: '', reason: 'not-git-repo',
  })
  const empty = init(temp(t))
  assert.deepEqual(probeGitRepo(empty), {
    isGit: true, repoRoot: empty, gitCommonDir: fs.realpathSync.native(path.join(empty, '.git')),
    headCommit: null, headBranch: 'main', subPath: '', reason: 'unborn-head',
  })
  const { dir, baseCommit } = repo(t)
  const nested = probeGitRepo(path.join(dir, 'nested'))
  assert.deepEqual(nested, {
    isGit: true, repoRoot: dir, gitCommonDir: fs.realpathSync.native(path.join(dir, '.git')),
    headCommit: baseCommit, headBranch: 'main', subPath: 'nested', reason: null,
  })
  assert.equal(probeGitRepo(dir).subPath, '')
  git(dir, 'switch', '--detach', baseCommit)
  assert.equal(probeGitRepo(dir).headBranch, null)
  const manager = createWorktreeManager()
  assert.equal(manager.create({ sourceCwd: outside }).code, 'not-git-repo')
  assert.equal(manager.create({ sourceCwd: empty }).code, 'unborn-head')
})

test('create registers a clean, independently checked-out worktree and maps the source subdirectory', (t) => {
  const { dir, baseCommit } = repo(t)
  const manager = createWorktreeManager({ now: () => 101, newId: () => 'abcdef01-2345' })
  const sourceCwd = path.join(dir, 'nested')
  const created = create(manager, dir, { sourceCwd, label: 'unit', parentId: 'parent', childId: 'old',
    batchId: 'batch', itemIndex: 0 })
  const expected = path.join(dir, WORKTREE_POOL_DIRNAME, WORKTREE_POOL_SUBDIR, 'wt-abcdef01')
  assert.deepEqual(created, {
    id: 'wt-abcdef01', worktreePath: expected, branch: `${WORKTREE_BRANCH_PREFIX}wt-abcdef01`,
    label: 'unit', parentId: 'parent', childId: 'old', batchId: 'batch', itemIndex: 0,
    repoRoot: dir, sourceCwd, subPath: 'nested', execCwd: path.join(expected, 'nested'),
    baseCommit, baseBranch: 'main', state: 'active', createdAt: 101, updatedAt: 101,
    settledAt: null, closedAt: null, auditSummary: null, mergeCommit: null, conflictFiles: [], error: null,
  })
  assert.ok(Object.isFrozen(WORKTREE_STATES))
  assert.equal(git(expected, 'branch', '--show-current'), created.branch)
  assert.equal(git(expected, 'rev-parse', 'HEAD'), baseCommit)
  assert.equal(git(dir, '--no-optional-locks', 'status', '--porcelain=v1'), '')
  assert.equal(fs.readFileSync(path.join(dir, WORKTREE_POOL_DIRNAME, '.gitignore'), 'utf8'), '*\n')
  assert.equal(ensurePoolIgnore(dir), path.dirname(expected))
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'ignored.txt\n')
  assert.equal(manager.getByChild('old'), created)
  assert.equal(manager.rebindChild(created.id, 'new').childId, 'new')
  assert.equal(manager.getByChild('old'), null)
  assert.equal(manager.getByWorktreeOrChild('new').id, created.id)
  assert.equal(manager.list({ parentId: 'parent', state: 'active' }).length, 1)
  assert.deepEqual(manager.isChildLocked('new'), { locked: false, worktreeId: created.id, state: 'active' })
  manager.clear()
  assert.equal(manager.get(created.id), null)
  assert.ok(fs.existsSync(expected))
})

test('create falls back for untracked source paths and rejects pool/shared Git directories outside the workspace', (t) => {
  const { dir } = repo(t)
  const manager = createWorktreeManager()
  const localOnly = path.join(dir, 'local-only')
  fs.mkdirSync(localOnly)
  assert.equal(manager.create({ sourceCwd: localOnly, workspaceRoot: localOnly }).code, 'worktree-outside-workspace')
  const worktree = create(manager, dir, { sourceCwd: localOnly })
  assert.equal(worktree.execCwd, worktree.worktreePath)
  const linked = manager.create({ sourceCwd: worktree.worktreePath, workspaceRoot: worktree.worktreePath })
  assert.equal(linked.code, 'worktree-outside-workspace')
  assert.equal(linked.gitCommonDir, fs.realpathSync.native(path.join(dir, '.git')))
})

test('create rejects a pool junction escaping the workspace without writing to the target', (t) => {
  const { dir } = repo(t)
  const outside = temp(t)
  fs.symlinkSync(outside, path.join(dir, WORKTREE_POOL_DIRNAME), process.platform === 'win32' ? 'junction' : 'dir')
  const result = createWorktreeManager().create({ sourceCwd: dir, workspaceRoot: dir })
  assert.equal(result.code, 'worktree-outside-workspace')
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('inspect includes commits and dirty categories, limits the patch, and tolerates a removed directory', (t) => {
  const { dir } = repo(t)
  const manager = createWorktreeManager()
  const wt = create(manager, dir, { childId: 'review-child' })
  write(wt.worktreePath, 'new-committed.txt', 'one line\n')
  const hash = commit(wt.worktreePath, 'Deliver a commit')
  write(wt.worktreePath, 'new-more.txt', 'two lines\n')
  const newest = commit(wt.worktreePath, 'Another commit')
  write(wt.worktreePath, 'staged.txt', 'staging\n')
  git(wt.worktreePath, 'add', '--', 'staged.txt')
  write(wt.worktreePath, 'unstaged.txt', 'work in progress '.repeat(40))
  write(wt.worktreePath, '一 个未跟踪文件.txt', 'untracked\n')
  const current = manager.inspect('review-child', { maxDiffChars: 12, maxCommits: 1 })
  assert.equal(current.ok, true, JSON.stringify(current))
  assert.equal(current.headCommit, newest)
  assert.equal(current.aheadCount, 2)
  assert.deepEqual(current.commits.map(({ subject }) => subject), ['Another commit'])
  assert.equal(manager.inspect(wt.id).commits[1].hash, hash)
  assert.deepEqual(current.stagedFiles, ['staged.txt'])
  assert.deepEqual(current.unstagedFiles, ['unstaged.txt'])
  assert.deepEqual(current.untrackedFiles, ['一 个未跟踪文件.txt'])
  assert.equal(current.dirty, true)
  assert.match(current.diffStat, /new-committed\.txt/)
  assert.equal(current.diffPatch.length, 12)
  assert.equal(current.diffTruncated, true)
  manager.discard(wt.id, { force: true })
  const removed = manager.inspect(wt.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.exists, false)
  assert.equal(removed.dirty, false)
})

test('settlement replaces the latest audit evidence and cannot reopen closed worktrees', (t) => {
  const { dir } = repo(t)
  let now = 100
  const manager = createWorktreeManager({ now: () => now })
  const wt = create(manager, dir)
  const firstSummary = { commits: 0, dirty: true, auditPassed: false }
  const latestSummary = { commits: 1, dirty: false, auditPassed: true }
  now = 200
  const first = manager.markReadyForReview(wt.id, firstSummary)
  assert.equal(first.state, 'ready_for_review')
  assert.deepEqual(first.auditSummary, firstSummary)
  write(wt.worktreePath, 'reviewed.txt', 'ready\n')
  commit(wt.worktreePath, 'Reviewed delivery')
  now = 300
  const latest = manager.markReadyForReview(wt.id, latestSummary)
  assert.equal(latest.state, 'ready_for_review')
  assert.equal(latest.settledAt, 300)
  assert.equal(latest.updatedAt, 300)
  assert.deepEqual(manager.list()[0].auditSummary, latestSummary)
  assert.deepEqual(manager.inspect(wt.id).worktree.auditSummary, latestSummary)
  assert.deepEqual(first.auditSummary, firstSummary)

  const merged = manager.merge(wt.id)
  assert.equal(merged.worktree.state, 'merged')
  now = 400
  assert.equal(manager.markReadyForReview(wt.id, firstSummary), merged.worktree)
  assert.equal(manager.reopenForRetry(wt.id), merged.worktree)
  const discarded = manager.discard(wt.id, { force: true })
  assert.equal(discarded.worktree.state, 'discarded')
  now = 500
  assert.equal(manager.markReadyForReview(wt.id, firstSummary), discarded.worktree)
  assert.equal(manager.reopenForRetry(wt.id), discarded.worktree)
})

test('merge refuses active or unknown strategies, reports noop, and merges with two parents and cleanup', (t) => {
  const { dir, baseCommit } = repo(t)
  const manager = createWorktreeManager()
  const wt = create(manager, dir, { childId: 'done' })
  assert.equal(manager.merge(wt.id, { strategy: 'unknown' }).code, 'worktree-invalid-strategy')
  assert.equal(manager.merge(wt.id).code, 'worktree-active')
  write(wt.worktreePath, 'deliver.txt', 'delivery\n')
  const worktreeHead = commit(wt.worktreePath, 'Finish delivery')
  assert.equal(manager.markReadyForReview(wt.id, { violations: 0 }).state, 'ready_for_review')
  assert.equal(fs.existsSync(wt.worktreePath), true)
  const result = manager.merge('done')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.cleaned, true)
  assert.equal(result.worktree.state, 'merged')
  assert.ok(result.worktree.closedAt !== null)
  assert.equal(git(dir, 'show', '-s', '--format=%P', result.mergeCommit), `${baseCommit} ${worktreeHead}`)
  assert.equal(fs.readFileSync(path.join(dir, 'deliver.txt'), 'utf8'), 'delivery\n')
  assert.equal(fs.existsSync(wt.worktreePath), false)
  assertBranchGone(dir, wt.branch)
  assert.equal(manager.merge(wt.id).code, 'worktree-already-closed')
  assert.equal(manager.isChildLocked('done').locked, true)
  assert.equal(manager.list({ includeClosed: false }).length, 0)
  const empty = create(manager, dir)
  manager.markReadyForReview(empty.id)
  const noop = manager.merge(empty.id)
  assert.equal(noop.ok, true)
  assert.equal(noop.noop, true)
  assert.equal(noop.merged, false)
})

test('squash creates one single-parent commit; conservative cleanup preserves an unmerged branch', (t) => {
  const { dir, baseCommit } = repo(t)
  const manager = createWorktreeManager()
  const wt = create(manager, dir)
  write(wt.worktreePath, 'first.txt', 'first\n')
  commit(wt.worktreePath, 'First delivery')
  write(wt.worktreePath, 'second.txt', 'second\n')
  const tip = commit(wt.worktreePath, 'Second delivery')
  manager.markReadyForReview(wt.id)
  const result = manager.merge(wt.id, { strategy: 'squash', commitMessage: 'Squash delivery' })
  assert.equal(result.merged, true, JSON.stringify(result))
  assert.equal(result.cleaned, false)
  assert.equal(result.worktree.state, 'cleanup_failed')
  assert.notEqual(result.mergeCommit, tip)
  assert.equal(git(dir, 'show', '-s', '--format=%P', result.mergeCommit), baseCommit)
  assert.equal(git(dir, 'show', '-s', '--format=%s', result.mergeCommit), 'Squash delivery')
  assert.equal(git(dir, 'rev-parse', wt.branch), tip)
  assert.equal(manager.list({ includeClosed: false })[0].id, wt.id)
  const duplicate = manager.merge(wt.id, { strategy: 'squash' })
  assert.equal(duplicate.code, 'worktree-already-closed')
  assert.equal(duplicate.mergeCommit, result.mergeCommit)
  assert.match(duplicate.message, /已合回.*不要重复合并.*discard.*force: true/)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), result.mergeCommit)
  assert.equal(manager.markReadyForReview(wt.id, { commits: 99 }), result.worktree)
  assert.equal(manager.reopenForRetry(wt.id), result.worktree)
  assert.equal(manager.discard(wt.id, { force: true }).worktree.state, 'discarded')
  assertBranchGone(dir, wt.branch)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), result.mergeCommit)
})

test('ff-only fast-forwards and can retain the worktree for review', (t) => {
  const { dir } = repo(t)
  const manager = createWorktreeManager()
  const wt = create(manager, dir)
  write(wt.worktreePath, 'ff.txt', 'fast-forward\n')
  const tip = commit(wt.worktreePath, 'FF delivery')
  manager.markReadyForReview(wt.id)
  const result = manager.merge(wt.id, { strategy: 'ff-only', deleteAfterMerge: false })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.mergeCommit, tip)
  assert.equal(result.cleaned, false)
  assert.equal(result.worktree.state, 'merged')
  assert.equal(git(dir, 'rev-parse', 'HEAD'), tip)
  assert.ok(fs.existsSync(wt.worktreePath))
})

test('merge protects dirty worktree and source, then auto-commits staged and untracked changes', (t) => {
  const { dir, baseCommit } = repo(t)
  const manager = createWorktreeManager()
  const wt = create(manager, dir)
  write(wt.worktreePath, 'staged.txt', 'staged delivery\n')
  git(wt.worktreePath, 'add', '--', 'staged.txt')
  write(wt.worktreePath, 'dirty.txt', 'untracked delivery\n')
  manager.markReadyForReview(wt.id)
  const refused = manager.merge(wt.id)
  assert.equal(refused.code, 'worktree-dirty')
  assert.deepEqual(refused.dirtyFiles.sort(), ['dirty.txt', 'staged.txt'])
  write(dir, 'main-only.txt', 'user change\n')
  const protectedResult = manager.merge(wt.id, { autoStageDirty: true })
  assert.equal(protectedResult.code, 'source-repo-dirty')
  assert.deepEqual(protectedResult.dirtyFiles, ['main-only.txt'])
  assert.equal(git(wt.worktreePath, 'rev-parse', 'HEAD'), baseCommit)
  fs.unlinkSync(path.join(dir, 'main-only.txt'))
  const result = manager.merge(wt.id, { autoStageDirty: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.autoCommitted, true)
  assert.equal(fs.readFileSync(path.join(dir, 'dirty.txt'), 'utf8'), 'untracked delivery\n')
  assert.equal(fs.readFileSync(path.join(dir, 'staged.txt'), 'utf8'), 'staged delivery\n')
})

for (const strategy of ['merge', 'squash']) {
  test(`${strategy} conflict restores the clean source while preserving the worktree and branch`, (t) => {
    const { dir } = repo(t)
    const manager = createWorktreeManager()
    const wt = create(manager, dir)
    write(wt.worktreePath, 'nested/base.txt', 'worker version\n')
    const workerTip = commit(wt.worktreePath, 'Worker version')
    write(dir, 'nested/base.txt', 'main version\n')
    const mainTip = commit(dir, 'Main version')
    manager.markReadyForReview(wt.id)
    const result = manager.merge(wt.id, { strategy })
    assert.equal(result.code, 'merge-conflict', JSON.stringify(result))
    assert.deepEqual(result.conflictFiles, ['nested/base.txt'])
    assert.equal(result.worktree.state, 'merge_conflict')
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mainTip)
    assert.equal(git(dir, '--no-optional-locks', 'status', '--porcelain=v1'), '')
    assert.equal(git(wt.worktreePath, 'rev-parse', 'HEAD'), workerTip)
    assert.equal(fs.readFileSync(path.join(wt.worktreePath, 'nested/base.txt'), 'utf8'), 'worker version\n')
    assert.equal(git(dir, 'rev-parse', wt.branch), workerTip)
  })
}

test('merge honors pre-merge-commit and rolls back a rejected source merge', (t) => {
  const { dir, baseCommit } = repo(t)
  const hooks = path.join(dir, '.git', 'test-hooks')
  write(hooks, 'pre-merge-commit', '#!/bin/sh\necho rtree-guard-rejected >&2\nexit 1\n')
  fs.chmodSync(path.join(hooks, 'pre-merge-commit'), 0o755)
  git(dir, 'config', 'core.hooksPath', hooks)
  const manager = createWorktreeManager()
  const wt = create(manager, dir)
  write(wt.worktreePath, 'hook-blocked.txt', 'not merged\n')
  commit(wt.worktreePath, 'Blocked by hook')
  manager.markReadyForReview(wt.id)
  const result = manager.merge(wt.id)
  assert.equal(result.code, 'worktree-merge-failed', JSON.stringify(result))
  assert.match(result.message, /rtree-guard-rejected/)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), baseCommit)
  assert.equal(git(dir, '--no-optional-locks', 'status', '--porcelain=v1'), '')
  assert.ok(fs.existsSync(wt.worktreePath))
})

test('discard protects active, dirty and unmerged work; explicit force closes and locks the child', (t) => {
  const { dir } = repo(t)
  const manager = createWorktreeManager()
  const wt = create(manager, dir, { childId: 'child' })
  assert.equal(manager.discard(wt.id).code, 'worktree-active')
  write(wt.worktreePath, 'discard.txt', 'data\n')
  manager.markReadyForReview(wt.id)
  assert.equal(manager.discard(wt.id).code, 'worktree-dirty')
  commit(wt.worktreePath, 'Unmerged delivery')
  assert.equal(manager.discard(wt.id).code, 'worktree-unmerged')
  const result = manager.discard('child', { force: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.worktree.state, 'discarded')
  assert.equal(result.discarded, true)
  assert.equal(fs.existsSync(wt.worktreePath), false)
  assertBranchGone(dir, wt.branch)
  assert.equal(manager.isChildLocked('child').locked, true)
  assert.deepEqual(manager.isChildLocked('no-child'), { locked: false })
})

test('prune reports orphans, safely removes forgotten pool directories and preserves active or reviewed worktrees', (t) => {
  const { dir } = repo(t)
  const manager = createWorktreeManager()
  const active = create(manager, dir)
  const ready = create(manager, dir)
  manager.markReadyForReview(ready.id)
  const unknown = create(createWorktreeManager(), dir)
  const pool = path.dirname(active.worktreePath)
  const orphan = path.join(pool, 'wt-orphan')
  write(orphan, 'forgotten.txt', 'forgotten\n')
  const orphanBranch = `${WORKTREE_BRANCH_PREFIX}wt-orphan`
  git(dir, 'branch', orphanBranch)
  const dryRun = manager.prune({ repoRoot: dir, dryRun: true })
  assert.equal(dryRun.ok, true, JSON.stringify(dryRun))
  assert.deepEqual(dryRun.orphans, [orphan])
  assert.ok(fs.existsSync(orphan))
  const result = manager.prune({ repoRoot: dir })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.prunedWorktrees, [orphan])
  assert.deepEqual(result.prunedBranches, [orphanBranch])
  assert.deepEqual(result.errors, [])
  assert.equal(fs.existsSync(orphan), false)
  assertBranchGone(dir, orphanBranch)
  for (const worktree of [active, ready, unknown]) assert.ok(fs.existsSync(worktree.worktreePath))
})

test('prune clears eligible stale Git registrations and leaves protected registrations untouched', (t) => {
  const { dir } = repo(t)
  git(dir, 'config', 'gc.worktreePruneExpire', 'now')
  const manager = createWorktreeManager()
  const lost = create(createWorktreeManager(), dir)
  fs.rmSync(lost.worktreePath, { recursive: true, force: true })
  const preview = manager.prune({ repoRoot: dir, dryRun: true })
  assert.deepEqual(preview.orphans, [lost.worktreePath])
  const active = create(manager, dir)
  fs.rmSync(active.worktreePath, { recursive: true, force: true })
  const guarded = manager.prune({ repoRoot: dir })
  assert.deepEqual(guarded.prunedWorktrees, [])
  assert.equal(guarded.errors.length, 1)
  assert.equal(manager.discard(active.id, { force: true }).ok, true)
  const cleaned = manager.prune({ repoRoot: dir })
  assert.deepEqual(cleaned.prunedWorktrees, [lost.worktreePath])
  assert.deepEqual(cleaned.prunedBranches, [lost.branch])
  assertBranchGone(dir, lost.branch)
})
