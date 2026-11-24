import { createWorktreeManageTool } from './worktree-manage.js'

const MUTATIONS = ['merge', 'discard', 'prune']
const durableFields = (row) => JSON.stringify(row)

/** Queue registry changes in the same turn as the Git mutation, before a reload can close the store. */
export function createPersistentWorktreeTool({
  worktrees, stateStore, timeline, assertActive, persist, isWakePending, ...options
}) {
  const manager = { ...worktrees }
  for (const action of MUTATIONS) {
    manager[action] = async (...args) => {
      if (action === 'prune' && args[0]?.dryRun === true) return worktrees.prune(...args)
      assertActive()
      const target = action !== 'prune' && worktrees.getByWorktreeOrChild(args[0])
      if (target?.childIds.some((childId) => isWakePending?.(childId))) {
        return { ok: false, code: 'worktree-active', message: '子代理正在恢复，待本轮结算后再操作工作树。' }
      }
      const before = new Map(worktrees.exportRecords().map((row) => [row.id, durableFields(row)]))
      try {
        return worktrees[action](...args)
      } finally {
        const changed = worktrees.exportRecords().filter((row) => before.get(row.id) !== durableFields(row))
        await Promise.all(changed.map((row) => persist(stateStore.putWorktree(row))))
        await stateStore.flush()
        for (const row of changed) {
          for (const childId of row.childIds) {
            timeline.recordWorktreeState(childId, {
              id: row.id, parentId: row.parentId, state: row.state,
              mergeCommit: row.mergeCommit, locked: row.locked,
            })
          }
        }
      }
    }
  }
  return createWorktreeManageTool({ ...options, worktrees: manager, timeline })
}
