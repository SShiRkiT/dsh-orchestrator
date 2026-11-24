import { formatInlineAuditNotice } from './timeline.js'

export const DEFAULT_DELEGATE_STATUS_TOOL_NAME = 'delegate_status'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 64

function renderStatus({ total, counts, items }) {
  const lines = [
    `委派验收状态：共 ${total} 条，本次显示 ${items.length} 条。`,
    `运行中 ${counts.running}；已结束待审计 ${counts.endedPendingAudit}；审计通过 ${counts.auditPassed}；` +
      `审计失败 ${counts.auditFailed}；未纳入审计 ${counts.auditUnmanaged}。`,
    `工作树待评审 ${counts.worktreePendingReview}。`,
  ]
  if (items.length === 0) {
    lines.push('当前会话没有符合条件的委派记录；缺少记录不代表验收通过。')
  }
  for (const entry of items) {
    const { childId, agentName, label, dispatchState, auditState, leaseState, baselineId, worktree } = entry
    const delivery = worktree ? ` [wt:${worktree.id} ${worktree.state}]` : ''
    const address = agentName ? `（${agentName}）` : ''
    lines.push(`【${childId}】${address}${label ?? '未命名任务'}：执行 ${dispatchState}；审计 ${auditState}；` +
      `租约 ${leaseState}；基线 ${baselineId ?? '无'}。${delivery}`)
    if (auditState === 'failed') {
      lines.push(formatInlineAuditNotice([{ childId, entry }]))
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function summarizeWorktree(worktree) {
  if (worktree == null) return null
  const { id, branch, state, commits, dirty, locked, path } = worktree
  return { id, branch, state, commits, dirty, locked, path }
}

export function createDelegateStatusTool({
  timeline,
  toolName = DEFAULT_DELEGATE_STATUS_TOOL_NAME,
  isRootAgent,
  defineTool = (definition) => definition,
} = {}) {
  return defineTool({
    name: toolName,
    description: '只读查询当前根代理会话直接委派的子代理执行、写作用域审计、租约及工作树交付状态；验收前用于核验终态。',
    parameters: {
      childId: { type: 'string', description: '可选：只查询当前会话下此 ID 对应的子代理。' },
      includeCompleted: { type: 'boolean', default: true, description: '是否包含执行已结束的子代理。' },
      limit: {
        type: 'integer',
        // The host author schema supports enum, not minimum/maximum.
        enum: Array.from({ length: MAX_LIMIT }, (_, index) => index + 1),
        default: DEFAULT_LIMIT,
        description: `最多返回条数（1..${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}）。`,
      },
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
            additionalProperties: false,
            properties: {
              parentId: { type: 'string' },
              total: { type: 'integer' },
              counts: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  running: { type: 'integer' },
                  endedPendingAudit: { type: 'integer' },
                  auditPassed: { type: 'integer' },
                  auditFailed: { type: 'integer' },
                  auditUnmanaged: { type: 'integer' },
                  worktreePendingReview: { type: 'integer' },
                },
              },
              items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
      render: (_args, value) => value.content,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec?.agent
      // The delegate path keys its records by exec.agent.id, not by a caller-supplied id.
      const parentId = parent?.id
      if (typeof parentId !== 'string' || parentId.trim() === '') {
        throw new Error(`${toolName} 无法识别调用代理的会话 ID，拒绝查询。`)
      }
      if (isRootAgent !== undefined && (typeof isRootAgent !== 'function' || !isRootAgent(parent))) {
        throw new Error(`${toolName} 仅限根代理调用，子代理不能查询委派验收状态。`)
      }
      if (Object.hasOwn(args ?? {}, 'parentId')) {
        throw new Error(`${toolName} 不接受 parentId 参数，只能查询调用方自己的委派记录。`)
      }
      const { childId, includeCompleted = true, limit = DEFAULT_LIMIT } = args ?? {}
      if (childId !== undefined && (typeof childId !== 'string' || childId.trim() === '')) {
        throw new Error('childId 必须是非空字符串。')
      }
      if (typeof includeCompleted !== 'boolean') throw new Error('includeCompleted 必须是布尔值。')
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`limit 必须是 1..${MAX_LIMIT} 之间的整数。`)
      }
      const report = timeline.queryParent(parentId, { childId, includeCompleted, limit })
      const details = {
        ...report,
        items: report.items.map((entry) => ({ ...entry, worktree: summarizeWorktree(entry.worktree) })),
      }
      return { content: renderStatus(report), details }
    },
  })
}
