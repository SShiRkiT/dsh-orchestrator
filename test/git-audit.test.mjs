import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { auditGitBaseline, captureGitBaseline, formatGitAuditReport } from '../lib/git-audit.js'
import { createWorktreeManager } from '../lib/worktree.js'

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
  }).trimEnd()
}

function write(cwd, filename, content) {
  const absolute = path.join(cwd, filename)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

function commit(cwd, message) {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function fixture(t, { subdir = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-audit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repoRoot = fs.realpathSync.native(root)
  git(repoRoot, 'init', '--initial-branch=main')
  git(repoRoot, 'config', 'user.name', 'Audit Test')
  git(repoRoot, 'config', 'user.email', 'audit-test@example.invalid')
  git(repoRoot, 'config', 'core.autocrlf', 'false')
  write(repoRoot, 'app/existing.txt', 'old\n')
  write(repoRoot, 'app/other.txt', 'untouched\n')
  write(repoRoot, 'root-committed.txt', 'before\n')
  write(repoRoot, 'root-unstaged.txt', 'before\n')
  commit(repoRoot, 'Initial')
  const sourceCwd = subdir ? path.join(repoRoot, 'app') : repoRoot
  const outcome = createWorktreeManager().create({ sourceCwd, workspaceRoot: repoRoot })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const { worktree } = outcome
  return { repoRoot, worktree, root: worktree.worktreePath, cwd: worktree.execCwd }
}

const hash = (value) => createHash('sha256').update(value).digest('hex')
const badPaths = (result, code) => result.violations.filter((row) => row.code === code).map((row) => row.path)

test('combines committed, staged, unstaged and untracked in-scope changes with raw byte fingerprints', (t) => {
  const { worktree, root } = fixture(t)
  const baseline = captureGitBaseline({ worktree, writeScope: ['app/'] })
  assert.equal(baseline.kind, 'git-worktree')
  assert.equal(baseline.worktreeId, worktree.id)
  assert.equal(baseline.worktreePath, root)
  assert.equal(baseline.execCwd, root)
  assert.ok(Object.isFrozen(baseline))
  assert.ok(Object.isFrozen(baseline.writeScope))
  assert.deepEqual(baseline.targetSnapshots, [])
  write(root, 'app/file with space.txt', 'committed\n')
  const tip = commit(root, 'Commit an in-scope delivery')
  write(root, 'app/existing.txt', 'existing dirty\n')
  const staged = Buffer.from([0x00, 0x80, 0x0a, 0x0d, 0x0a, 0x41])
  write(root, 'app/staged.bin', staged)
  git(root, 'add', '--', 'app/staged.bin')
  write(root, 'app/中文 未追踪.txt', '')
  const result = auditGitBaseline(baseline)
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.equal(result.isolationLevel, 'git-worktree')
  assert.deepEqual(result.summary, { added: 3, modified: 1, deleted: 0, violations: 0, truncated: false, commits: 1, dirty: true })
  assert.equal(result.git.headCommit, tip)
  assert.equal(result.git.commits[0].hash, tip)
  assert.equal(result.git.commits[0].subject, 'Commit an in-scope delivery')
  assert.deepEqual(result.git.dirtyFiles, ['app/existing.txt', 'app/staged.bin', 'app/中文 未追踪.txt'])
  const files = Object.fromEntries(result.changedFiles.map((row) => [row.path, row]))
  assert.deepEqual(files['app/staged.bin'], {
    path: 'app/staged.bin', changeType: 'added', sha256: hash(staged), bytes: staged.length, lines: 3,
  })
  assert.deepEqual(files['app/中文 未追踪.txt'], {
    path: 'app/中文 未追踪.txt', changeType: 'added', sha256: hash(''), bytes: 0, lines: 1,
  })
  assert.match(formatGitAuditReport(result), /git-worktree.*1 个提交/)
  assert.match(formatGitAuditReport(result), /3 项未提交改动/)
})

test('reports AC5 committed, unstaged and untracked violations outside a declared directory', (t) => {
  const { worktree, root } = fixture(t)
  const baseline = captureGitBaseline({ worktree, writeScope: ['app/'] })
  write(root, 'root-committed.txt', 'committed violation\n')
  commit(root, 'Out of scope commit')
  write(root, 'root-unstaged.txt', 'unstaged violation\n')
  write(root, 'root-untracked.txt', 'untracked violation\n')
  write(root, 'app/within-scope.txt', 'allowed\n')
  const result = auditGitBaseline(baseline, { writeScope: ['*'] })
  assert.equal(result.passed, false)
  assert.deepEqual(badPaths(result, 'out-of-scope-write'), ['root-committed.txt', 'root-unstaged.txt', 'root-untracked.txt'])
  assert.equal(result.git.commits.length, 1)
})

test('subdirectory execution maps paths correctly and does not permit outside writes even with *', (t) => {
  const { worktree, cwd, root } = fixture(t, { subdir: true })
  const baseline = captureGitBaseline({ worktree, writeScope: ['*'] })
  write(cwd, 'inside.txt', 'allowed\n')
  write(root, 'root-unstaged.txt', 'outside exec cwd\n')
  write(root, 'app-neighbor/file.txt', 'also outside exec cwd\n')
  const result = auditGitBaseline(baseline)
  assert.deepEqual(result.changedFiles.map((row) => row.path), ['../app-neighbor/file.txt', '../root-unstaged.txt', 'inside.txt'])
  assert.deepEqual(badPaths(result, 'out-of-scope-write'), ['../app-neighbor/file.txt', '../root-unstaged.txt'])
  assert.throws(() => auditGitBaseline(baseline, { cwd: root }), /冻结基线/)
})

test('AC6 hashes old bytes and protects them from settlement overrides', (t) => {
  const { worktree, cwd } = fixture(t, { subdir: true })
  const options = { worktree, writeScope: ['existing.txt'] }
  const match = captureGitBaseline({ ...options, expectedFingerprints: { 'existing.txt': hash('old\n').toUpperCase() } })
  const wrong = captureGitBaseline({ ...options, expectedFingerprints: { 'existing.txt': hash('wrong') } })
  const missing = captureGitBaseline({ ...options, expectedFingerprints: { 'missing.txt': hash('missing') } })
  assert.deepEqual(match.targetSnapshots.map(({ path: filename, exists }) => [filename, exists]), [['existing.txt', true]])
  write(cwd, 'existing.txt', 'new\n')
  assert.equal(auditGitBaseline(match, { expectedFingerprints: { 'existing.txt': hash('new\n') } }).passed, true)
  const result = auditGitBaseline(wrong, { expectedFingerprints: { 'existing.txt': hash('new\n') } })
  assert.deepEqual(result.violations, [{
    code: 'fingerprint-mismatch', path: 'existing.txt', phase: 'baseline', expected: hash('wrong'), actual: hash('old\n'),
  }])
  const unavailable = auditGitBaseline(missing)
  assert.deepEqual(badPaths(unavailable, 'audit-incomplete'), ['missing.txt'])
})

test('AC7 retains explicitly listed and preexisting declared files as settlement targets', (t) => {
  const { worktree, cwd } = fixture(t, { subdir: true })
  const baseline = captureGitBaseline({ worktree, writeScope: ['existing.txt', 'required.txt', 'optional.txt'],
    expectedTargets: ['required.txt'] })
  assert.deepEqual(baseline.expectedTargets, ['existing.txt', 'required.txt'])
  assert.deepEqual(baseline.targetSnapshots.map(({ path: filename, exists }) => [filename, exists]), [
    ['existing.txt', true], ['optional.txt', false], ['required.txt', false],
  ])
  write(cwd, 'required.txt', 'filled later\n')
  assert.equal(auditGitBaseline(baseline).passed, true)
  fs.unlinkSync(path.join(cwd, 'required.txt'))
  fs.unlinkSync(path.join(cwd, 'existing.txt'))
  const result = auditGitBaseline(baseline, { expectedTargets: [] })
  assert.deepEqual(badPaths(result, 'target-missing'), ['existing.txt', 'required.txt'])
  assert.deepEqual(result.changedFiles, [{ path: 'existing.txt', changeType: 'deleted', sha256: null, bytes: 0, lines: 0 }])
})

test('AC8 readOnly cannot be relaxed and its report limits violation rows to eight', (t) => {
  const { worktree, root } = fixture(t)
  const baseline = captureGitBaseline({ worktree, readOnly: true })
  write(root, 'root-committed.txt', 'readOnly violation\n')
  commit(root, 'Read only violation')
  for (let index = 0; index < 9; index += 1) write(root, `forbidden-${index}.txt`, 'no\n')
  const result = auditGitBaseline(baseline, { readOnly: false })
  assert.equal(result.readOnly, true)
  assert.equal(result.passed, false)
  assert.equal(badPaths(result, 'readonly-write').length, 10)
  assert.throws(() => auditGitBaseline(baseline, { writeScope: ['*'] }), /互斥/)
  const report = formatGitAuditReport(result)
  assert.equal(report.split('\n').filter((row) => row.startsWith('- ')).length, 8)
  assert.match(report, /另有 2 项未列出/)
})

test('main workspace taint excludes preexisting paths and does not change worktree attribution', (t) => {
  const { repoRoot, worktree, root } = fixture(t)
  write(repoRoot, 'before-main.txt', 'preexisting\n')
  write(repoRoot, 'dirty-dir/old.txt', 'preexisting\n')
  const baseline = captureGitBaseline({ worktree, writeScope: ['app/'] })
  assert.deepEqual(baseline.mainBeforeDirty, ['before-main.txt', 'dirty-dir/old.txt'])
  write(repoRoot, 'before-main.txt', 'already dirty\n')
  write(repoRoot, 'dirty-dir/another.txt', 'new file under a previously dirty directory\n')
  write(repoRoot, 'new main.txt', 'newly dirty\n')
  write(repoRoot, 'root-unstaged.txt', 'newly dirty tracked\n')
  write(repoRoot, '.dsh-orchestrator/local-tool-data', 'pool data\n')
  write(root, 'app/worktree.txt', 'allowed\n')
  const result = auditGitBaseline(baseline)
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.deepEqual(result.git.mainWorkspaceTaint, ['dirty-dir/another.txt', 'new main.txt', 'root-unstaged.txt'])
  assert.deepEqual(result.changedFiles.map((row) => row.path), ['app/worktree.txt'])
  assert.match(formatGitAuditReport(result), /主仓出现 3 项新增污点/)
})

test('net diff drops reverted history, expands rename, and reconciles staged deletion with an identical untracked copy', (t) => {
  const { worktree, root } = fixture(t)
  const baseline = captureGitBaseline({ worktree, writeScope: ['app/'] })
  write(root, 'app/transient.txt', 'committed but later removed\n')
  write(root, 'root-committed.txt', 'edited then restored\n')
  commit(root, 'Historical changes')
  fs.unlinkSync(path.join(root, 'app/transient.txt'))
  write(root, 'root-committed.txt', 'before\n')
  git(root, 'mv', '--', 'app/existing.txt', 'app/moved.txt')
  git(root, 'rm', '--', 'app/other.txt')
  write(root, 'app/other.txt', 'untouched\n')
  const result = auditGitBaseline(baseline)
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.deepEqual(result.changedFiles.map(({ path: filename, changeType }) => [filename, changeType]), [
    ['app/existing.txt', 'deleted'], ['app/moved.txt', 'added'],
  ])
  assert.equal(result.git.commits.length, 1)
  assert.ok(result.git.dirtyFiles.includes('app/transient.txt'))
  write(root, 'app/other.txt', 'different recreated bytes\n')
  const changed = auditGitBaseline(baseline)
  assert.equal(changed.changedFiles.find((row) => row.path === 'app/other.txt').changeType, 'modified')
})

test('narrowing scope applies intersection without granting new paths', (t) => {
  const { worktree, root } = fixture(t)
  const baseline = captureGitBaseline({ worktree, writeScope: ['app/'] })
  write(root, 'app/existing.txt', 'in the narrowed scope\n')
  write(root, 'app/other.txt', 'outside the narrowed scope\n')
  write(root, 'root-unstaged.txt', 'cannot extend outside original scope\n')
  const result = auditGitBaseline(baseline, { writeScope: ['app/existing.txt', 'root-unstaged.txt'] })
  assert.deepEqual(badPaths(result, 'out-of-scope-write'), ['app/other.txt', 'root-unstaged.txt'])
})

test('removing the linked checkout yields audit-incomplete rather than sampling its parent repository', (t) => {
  const { worktree, root } = fixture(t)
  const baseline = captureGitBaseline({ worktree, writeScope: ['app/'] })
  fs.unlinkSync(path.join(root, '.git'))
  const result = auditGitBaseline(baseline)
  assert.equal(result.passed, false)
  assert.deepEqual(badPaths(result, 'audit-incomplete'), ['.'])
  assert.equal(result.git.headCommit, null)
})
