const labels = {
  deliveryUnknown: '投递结果未知', pendingReview: '待评审', running: '运行中',
  awaitingRun: '等待运行确认', needsAttention: '需处理', merged: '已合回', ended: '已结束',
}
const priority = Object.keys(labels)

function classify(entry, action) {
  if (action?.phase === 'unknown' || action?.phase === 'prepared') return 'deliveryUnknown'
  if (action?.phase === 'accepted') return 'awaitingRun'
  const tree = entry.worktree
  if (tree?.mergeCommit || tree?.state === 'merged') return 'merged'
  if (tree?.state === 'merge_conflict' || tree?.state === 'ready_for_review') return 'pendingReview'
  if (tree?.state === 'cleanup_failed') return 'needsAttention'
  return entry.dispatchState === 'ended' ? 'ended' : 'running'
}

// Count delegates, including individual batch stages. Stages can share a worktree ID.
export function summarizeDeliveries(parentId, entries, { limit, includeCompleted, wakeActionFor }) {
  const counts = Object.fromEntries(priority.map(key => [key, 0]))
  const items = []
  for (const entry of entries) {
    if (!includeCompleted && entry.dispatchState === 'ended') continue
    const action = wakeActionFor?.(entry)
    const state = classify(entry, action)
    counts[state]++
    const tree = entry.worktree
    const evidence = { runId: entry.runId, attemptSeq: entry.attemptSeq, dispatchState: entry.dispatchState,
      leaseState: entry.leaseState, stopReason: entry.stopReason }
    if (tree) Object.assign(evidence, { worktreeId: tree.id, worktreeState: tree.state,
      baseCommit: tree.baseCommit, mergeCommit: tree.mergeCommit })
    if (action) Object.assign(evidence, { actionKey: action.key, actionPhase: action.phase,
      requestId: action.requestId, precedingRunId: action.runId })
    items.push({ childId: entry.childId, label: entry.label, state, updatedAt: entry.updatedAt, evidence })
  }
  items.sort((a, b) => priority.indexOf(a.state) - priority.indexOf(b.state) || b.updatedAt - a.updatedAt || a.childId.localeCompare(b.childId))
  return { action: 'summary', parentId, counts, total: items.length, items: items.slice(0, limit) }
}

export function renderDeliverySummary({ counts, total, items }) {
  const lines = [`交付摘要（${total} 条委派，显示 ${items.length} 条）`,
    priority.map(key => `${labels[key]} ${counts[key]}`).join('，')]
  for (const { childId, label, state, evidence } of items) {
    const refs = [evidence.runId, evidence.worktreeId, evidence.mergeCommit, evidence.actionKey].filter(Boolean)
    lines.push(`【${childId}】${label ?? ''} ${labels[state]} · ${refs.join(' · ') || `尝试 ${evidence.attemptSeq}`}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}
