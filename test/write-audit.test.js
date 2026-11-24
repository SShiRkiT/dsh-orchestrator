import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { auditBaseline, captureBaseline, formatAuditReport } from '../lib/write-audit.js'
import {
  WRITE_LEASE_CODES,
  createWriteLeases,
  isPathWithinScope,
  validateWriteScopeInput,
} from '../lib/write-lease.js'

const temporary = []
after(() => {
  for (const cwd of temporary) fs.rmSync(cwd, { recursive: true, force: true })
})

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-write-audit-'))
  temporary.push(cwd)
  return cwd
}

function write(cwd, filename, content) {
  const absolute = path.join(cwd, filename)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

test('冻结基线与复算：允许范围内新增和修改，返回磁盘指纹与字节行数', () => {
  const cwd = workspace()
  const initial = '初\r\n最后一行'
  write(cwd, 'src/existing.txt', initial)
  const writeScope = ['src/**']
  const baseline = captureBaseline({ cwd, writeScope })
  assert.notEqual(baseline.baselineId, captureBaseline({ cwd, writeScope }).baselineId)
  const [original] = baseline.files
  assert.deepEqual(original, {
    path: 'src/existing.txt',
    sha256: sha256(initial),
    bytes: Buffer.byteLength(initial),
    lines: 2,
    mtimeMs: fs.statSync(path.join(cwd, 'src/existing.txt')).mtimeMs,
    size: Buffer.byteLength(initial),
  })
  assert.ok(Object.isFrozen(baseline) && Object.isFrozen(original))
  writeScope.push('outside.txt')
  assert.deepEqual(baseline.writeScope, ['src/**'])

  write(cwd, 'src/existing.txt', 'modified\n')
  write(cwd, 'src/new.txt', 'one\ntwo')
  const result = auditBaseline(baseline)
  assert.equal(result.baselineId, baseline.baselineId)
  assert.equal(result.passed, true)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.changedFiles, [
    { path: 'src/existing.txt', sha256: sha256('modified\n'), bytes: 9, lines: 1, changeType: 'modified' },
    { path: 'src/new.txt', sha256: sha256('one\ntwo'), bytes: 7, lines: 2, changeType: 'added' },
  ])
  assert.deepEqual(result.summary, { added: 1, modified: 1, deleted: 0, violations: 0, truncated: false })
  assert.equal(formatAuditReport(result), '')
})

test('AC5：检查整棵工作区，识别作用域外新增、修改、删除', () => {
  const cwd = workspace()
  write(cwd, 'src-web/edit.txt', 'initial')
  write(cwd, 'outside/remove.txt', 'remove this')
  const baseline = captureBaseline({ cwd, writeScope: ['src/'] })
  write(cwd, 'src-web/edit.txt', 'new content')
  write(cwd, 'outside/add.txt', 'new\n')
  fs.unlinkSync(path.join(cwd, 'outside/remove.txt'))
  const result = auditBaseline(baseline)
  assert.equal(result.passed, false)
  assert.deepEqual(result.violations, [
    { path: 'outside/add.txt', code: 'out-of-scope-write', changeType: 'added' },
    { path: 'outside/remove.txt', code: 'out-of-scope-write', changeType: 'deleted' },
    { path: 'src-web/edit.txt', code: 'out-of-scope-write', changeType: 'modified' },
  ])
  assert.deepEqual(result.changedFiles[1], {
    path: 'outside/remove.txt', sha256: null, bytes: 0, lines: 0, changeType: 'deleted',
  })
  assert.match(formatAuditReport(result), /out-of-scope-write.*outside\/add\.txt/)
})

test('AC5/AC8：只读不需作用域，结算覆盖新增、修改、删除且不能降级为可写', () => {
  const cwd = workspace()
  write(cwd, 'existing.txt', 'first')
  write(cwd, 'removed.txt', 'old')
  const baseline = captureBaseline({ cwd, readOnly: true })
  const clean = auditBaseline(baseline)
  assert.equal(clean.passed, true)
  assert.deepEqual(clean.changedFiles, [])
  assert.equal(clean.readOnly, true)
  assert.equal(clean.isolationLevel, 'logical-post-audit')
  assert.match(clean.isolationNote, /不提供逐子代理物理只读文件系统沙箱.*逻辑写后审计/)
  assert.throws(
    () => captureBaseline({ cwd, readOnly: true, writeScope: ['*'] }),
    { code: 'write-scope-invalid' },
  )
  write(cwd, 'new.txt', 'new')
  write(cwd, 'existing.txt', 'modified')
  fs.unlinkSync(path.join(cwd, 'removed.txt'))
  const dirty = auditBaseline(baseline, { readOnly: false })
  assert.equal(dirty.passed, false)
  assert.equal(dirty.readOnly, true)
  assert.deepEqual(dirty.violations.map(({ code, changeType }) => [code, changeType]), [
    ['out-of-scope-write', 'modified'],
    ['out-of-scope-write', 'added'],
    ['out-of-scope-write', 'deleted'],
  ])
})

test('AC6：冻结预期比较旧盘面，自报预期比较新盘面；结算不能掩盖冻结时的不符', () => {
  const cwd = workspace()
  write(cwd, 'a.txt', 'before')
  const oldHash = sha256('before')
  const claimed = sha256('wrong')
  const badBaseline = captureBaseline({ cwd, writeScope: ['a.txt'], expectedFingerprints: { 'a.txt': claimed } })
  const baseline = captureBaseline({ cwd, writeScope: ['a.txt'], expectedFingerprints: { 'a.txt': oldHash } })
  write(cwd, 'a.txt', 'after')
  const newHash = sha256('after')
  assert.equal(auditBaseline(baseline, { expectedFingerprints: { 'a.txt': newHash.toUpperCase() } }).passed, true)
  const result = auditBaseline(badBaseline, { expectedFingerprints: { 'a.txt': oldHash } })
  assert.equal(result.passed, false)
  assert.deepEqual(result.violations, [
    { code: 'fingerprint-mismatch', path: 'a.txt', expected: claimed, actual: oldHash, phase: 'baseline' },
    { code: 'fingerprint-mismatch', path: 'a.txt', expected: oldHash, actual: newHash, phase: 'settlement' },
  ])
  const missing = auditBaseline(baseline, { expectedFingerprints: { 'missing.txt': oldHash } })
  assert.deepEqual(missing.violations, [
    { code: 'fingerprint-mismatch', path: 'missing.txt', expected: oldHash, actual: null, phase: 'settlement' },
  ])
})

test('AC7：冻结时存在的显式文件和调用方要求的产物不得缺失', () => {
  const cwd = workspace()
  write(cwd, 'src/existing.txt', 'remove this')
  write(cwd, 'src/ordinary.txt', 'directory scope alone is not a deliverable')
  const baseline = captureBaseline({
    cwd,
    writeScope: ['src/**', 'src/existing.txt', 'src/planned.txt'],
    expectedTargets: ['src/required.txt'],
  })
  assert.deepEqual(baseline.expectedTargets, ['src/existing.txt', 'src/required.txt'])
  fs.unlinkSync(path.join(cwd, 'src/existing.txt'))
  fs.unlinkSync(path.join(cwd, 'src/ordinary.txt'))
  write(cwd, 'src/delivered.txt', 'present')
  const result = auditBaseline(baseline, { expectedTargets: ['src/delivered.txt', 'src/extra.txt'] })
  assert.equal(result.passed, false)
  assert.deepEqual(result.violations, [
    { code: 'target-missing', path: 'src/existing.txt' },
    { code: 'target-missing', path: 'src/extra.txt' },
    { code: 'target-missing', path: 'src/required.txt' },
  ])
})

test('工作区扫描忽略常规元数据与依赖目录，不读取指向外部的目录链接', () => {
  const cwd = workspace()
  const external = workspace()
  write(cwd, '.git/metadata', 'ignored')
  write(cwd, 'src/node_modules/pkg/index.js', 'ignored')
  write(external, 'external.txt', 'before')
  fs.symlinkSync(external, path.join(cwd, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir')
  const baseline = captureBaseline({ cwd, readOnly: true })
  assert.deepEqual(baseline.files.map(({ path: filename }) => filename), ['external-link'])
  write(cwd, '.git/metadata', 'ignore change')
  write(cwd, 'src/node_modules/pkg/index.js', 'ignore change')
  write(external, 'external.txt', 'after')
  assert.equal(auditBaseline(baseline).passed, true)
  fs.unlinkSync(path.join(cwd, 'external-link'))
  assert.equal(auditBaseline(baseline).violations[0].code, 'out-of-scope-write')
})

test('采样超限显式失败，不把未读取的目标误判为消失', () => {
  const cwd = workspace()
  write(cwd, 'huge.txt', '')
  fs.truncateSync(path.join(cwd, 'huge.txt'), 64 * 1024 * 1024 + 1)
  const baseline = captureBaseline({ cwd, readOnly: true, expectedTargets: ['huge.txt'] })
  assert.equal(baseline.truncated, true)
  assert.equal(baseline.scanIssues[0].path, 'huge.txt')
  const result = auditBaseline(baseline)
  assert.equal(result.passed, false)
  assert.equal(result.summary.truncated, true)
  assert.deepEqual(result.changedFiles, [])
  assert.ok(result.violations.every(({ code }) => code === 'audit-incomplete'))
  assert.match(formatAuditReport(result), /采样已截断/)
})

test('冻结约束不能在结算时被扩大，实际写作用域可以缩小', () => {
  const cwd = workspace()
  const narrow = captureBaseline({ cwd, writeScope: ['a.txt'] })
  const wide = captureBaseline({ cwd, writeScope: ['*'] })
  write(cwd, 'b.txt', 'new')
  assert.equal(auditBaseline(narrow, { writeScope: ['*'] }).violations[0].code, 'out-of-scope-write')
  assert.equal(auditBaseline(wide, { writeScope: ['a.txt'] }).violations[0].code, 'out-of-scope-write')
})

test('统一校验：只有显式只读才允许省略或传空作用域', () => {
  for (const input of [{ readOnly: true }, { readOnly: true, writeScope: [] }]) {
    assert.deepEqual(validateWriteScopeInput(input), { ok: true, readOnly: true, entries: [] })
  }
  const refused = validateWriteScopeInput({ readOnly: true, writeScope: ['src/a.js'] })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'write-scope-invalid')
  assert.match(refused.message, /readOnly.*writeScope.*互斥/)
  assert.equal(validateWriteScopeInput({ readOnly: 'true' }).code, 'write-scope-missing')
  assert.equal(validateWriteScopeInput({}).code, 'write-scope-missing')
  assert.equal(validateWriteScopeInput({ writeScope: [] }).code, 'write-scope-invalid')
  assert.deepEqual(validateWriteScopeInput({ writeScope: ['a.js'] }), {
    ok: true, readOnly: false, entries: ['a.js'],
  })
})

test('单路径匹配共享文件、目录前缀和根声明语义，支持 Windows 分隔符与大小写', () => {
  const options = { cwd: 'C:\\Repo' }
  assert.equal(isPathWithinScope('SRC\\a.js', ['src/**'], options), true)
  assert.equal(isPathWithinScope('src/nested/b.js', ['src\\'], options), true)
  assert.equal(isPathWithinScope('src-old/a.js', ['src/'], options), false)
  assert.equal(isPathWithinScope('src', ['src/nested/'], options), false)
  assert.equal(isPathWithinScope('SRC\\A.JS', ['src/a.js'], options), true)
  assert.equal(isPathWithinScope('src/a.js/b.js', ['src/a.js'], options), false)
  assert.equal(isPathWithinScope('outside/file', ['*'], options), true)
  assert.equal(isPathWithinScope('src/a.js', ['src/*.js'], options), false)
})

test('只读请求不占租约，也不改变同一个子代理之前的租约', () => {
  const leases = createWriteLeases()
  const active = leases.acquire({ childId: 'writer', parentId: 'root', scope: ['src/'], cwd: 'C:/repo' })
  assert.equal(active.ok, true)
  assert.deepEqual(leases.acquire({ childId: 'writer', readOnly: true }), {
    ok: true, lease: null, reused: false, readOnly: true,
  })
  assert.deepEqual(leases.check({ readOnly: true, scope: [] }), {
    ok: true, readOnly: true, entries: [], conflicts: [],
  })
  assert.equal(leases.acquire({ readOnly: true, entries: active.lease.entries }).ok, false)
  assert.equal(leases.acquire({ readOnly: true, writeScope: ['src/'] }).ok, false)
  assert.deepEqual(leases.list(), [active.lease])
})

test('重试前以原条目重新抢锁，释放后成功，被其他子代理抢占后应拒绝', () => {
  const leases = createWriteLeases({ now: () => 1234 })
  const first = leases.acquire({ childId: 'retrying', parentId: 'main', scope: ['src/a.js'], cwd: 'C:/repo' })
  assert.equal(first.ok, true)
  assert.equal(leases.release(first.lease.leaseId).released, true)
  const input = { childId: 'retrying', parentId: 'main', entries: first.lease.entries }
  const retry = leases.acquire(input)
  assert.equal(retry.ok, true)
  assert.equal(retry.reused, false)
  assert.notEqual(retry.lease.leaseId, first.lease.leaseId)
  assert.equal(leases.releaseByChild('retrying').released, 1)

  const other = leases.acquire({ childId: 'other', parentId: 'main', scope: ['src/'], cwd: 'C:/repo' })
  assert.equal(other.ok, true)
  const refused = leases.acquire(input)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, WRITE_LEASE_CODES.conflict)
  assert.deepEqual(refused.conflicts.map(({ childId, path: requested, holderPath }) => [childId, requested, holderPath]), [
    ['other', 'C:/repo/src/a.js', 'C:/repo/src'],
  ])
  assert.deepEqual(leases.list(), [other.lease])
})
