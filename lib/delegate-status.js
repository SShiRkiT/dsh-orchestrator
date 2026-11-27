import { renderDeliverySummary } from './delivery-summary.js'

export const DEFAULT_DELEGATE_STATUS_TOOL_NAME = 'delegate_status'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 64

function renderStatus({ total, counts, items }) {
  const lines = [
    `委派状态：共 ${total} 条，本次显示 ${items.length} 条。`,
    `运行中 ${counts.running}，已结束 ${counts.ended}，工作树待评审 ${counts.worktreePendingReview}。`,
  ]
  if (items.length === 0) lines.push('当前会话没有符合条件的委派记录。')
  for (const { childId, agentName, label, dispatchState, leaseState, worktree, pendingNextTurn } of items) {
    const address = agentName ? `（${agentName}）` : ''
    const delivery = worktree ? ` [wt:${worktree.id} ${worktree.state}]` : ''
    lines.push(`【${childId}】${address}${label ?? '未命名任务'}：执行 ${dispatchState}，租约 ${leaseState}。` +
      delivery + (pendingNextTurn ? ' 下一轮配置待应用。' : ''))
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export function createDelegateStatusTool({
  timeline, editNextTurn, wakeActionFor, toolName = DEFAULT_DELEGATE_STATUS_TOOL_NAME, isRootAgent,
  defineTool = (definition) => definition,
} = {}) {
  return defineTool({
    name: toolName,
    description: '查询本根会话的委派、写租约和工作树状态。用 summary 查看交付证据。用 edit 更新闲置子代理的下一轮配置，再用 send_message 续跑。',
    parameters: {
      action: { type: 'string', enum: ['query', 'summary', 'edit'], description: '默认 query。summary 按交付状态汇总证据，edit 保存下一轮配置。' },
      childId: { type: 'string', description: '精确查询的子代理 ID，edit 必填。' },
      writeScope: {
        type: 'array', items: { type: 'string' },
        description: 'edit 时替换写路径，基于子代理执行目录。切换为只读时省略或传空数组。',
      },
      readOnly: { type: 'boolean', description: 'edit 时设置下一轮是否只读，省略则沿用已有设置。' },
      includeCompleted: { type: 'boolean', default: true, description: '查询是否包含执行已结束的子代理。' },
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
        type: 'object', additionalProperties: false,
        properties: {
          content: {
            type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: { type: { type: 'string', const: 'text' }, text: { type: 'string' } },
            },
          },
          details: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => value.content,
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec?.agent
      // Never authorize against a caller-supplied parent id.
      const parentId = parent?.id
      if (typeof parentId !== 'string' || parentId.trim() === '') {
        throw new Error(`${toolName} 无法识别调用代理的会话 ID，拒绝操作。`)
      }
      if (isRootAgent !== undefined && (typeof isRootAgent !== 'function' || !isRootAgent(parent))) {
        throw new Error(`${toolName} 仅限根代理调用。`)
      }
      if (Object.hasOwn(args ?? {}, 'parentId')) {
        throw new Error(`${toolName} 不接受 parentId 参数，只能操作调用方自己的委派记录。`)
      }
      const { action = 'query', childId, includeCompleted = true, limit = DEFAULT_LIMIT, writeScope, readOnly } = args ?? {}
      if (childId !== undefined && (typeof childId !== 'string' || childId.trim() === '')) {
        throw new Error('childId 必须是非空字符串。')
      }
      if (action === 'edit') {
        if (!childId) throw new Error('edit 必须指定 childId。')
        if (readOnly === undefined && writeScope === undefined) throw new Error('edit 至少需要提供 writeScope 或 readOnly。')
        if (readOnly !== undefined && typeof readOnly !== 'boolean') throw new Error('readOnly 必须是布尔值。')
        if (writeScope !== undefined && !Array.isArray(writeScope)) throw new Error('writeScope 必须是路径数组。')
        if (!editNextTurn) throw new Error('当前环境不支持编辑委派配置。')
        const details = await editNextTurn(parent, childId.trim(), { writeScope, readOnly }, exec.signal)
        return {
          content: [{ type: 'text', text: `已保存 ${childId} 的下一轮配置。请用 send_message 唤醒同一子代理。` }],
          details: { action, ...details },
        }
      }
      if (action !== 'query' && action !== 'summary') throw new Error('action 必须是 query、summary 或 edit。')
      if (readOnly !== undefined || writeScope !== undefined) throw new Error('修改参数仅用于 edit。')
      if (typeof includeCompleted !== 'boolean') throw new Error('includeCompleted 必须是布尔值。')
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`limit 必须是 1..${MAX_LIMIT} 之间的整数。`)
      }
      if (action === 'summary') {
        const details = timeline.queryDelivery(parentId, { childId, includeCompleted, limit, wakeActionFor })
        return { content: renderDeliverySummary(details), details }
      }
      const report = timeline.queryParent(parentId, { childId, includeCompleted, limit })
      return { content: renderStatus(report), details: report }
    },
  })
}
