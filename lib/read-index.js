import { isDelegatedChild } from './gate.js'

const READ_TOOLS = new Map([
  ['read', 'read'], ['ops_inspect_local_file', 'read'],
  ['glob', 'glob'], ['ops_glob', 'glob'],
  ['grep', 'grep'], ['ops_grep', 'grep'],
])
const MAX_CHILDREN = 128
const MAX_CALLS = 1024
const MAX_ENTRIES = 20
const MAX_PEERS_SHOWN = 5
const MAX_ROWS_SHOWN = 5
const ANSWER_PREFIX = '【平级只读咨询答复】'
export const PEER_CONSULT_SOURCE_KIND = 'orchestrator-peer-read-only-consult'

function remember(map, key, value, limit) {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value)
}

function compact(value, limit = 220) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim().slice(0, limit) : ''
}

function pathOf(value) {
  return compact(typeof value === 'string' ? value : value?.path ?? value?.filePath ?? value?.file_path)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function readRows(kind, args, value) {
  if (kind === 'read') {
    const path = pathOf(value) || pathOf(args)
    const lines = Array.isArray(value?.lines) ? value.lines : undefined
    const from = positiveInteger(lines?.[0]?.number ?? value?.offset ?? value?.startLine ?? args.offset ?? args.start_line) ?? 1
    const to = positiveInteger(lines?.at(-1)?.number ?? value?.endLine) ?? (lines?.length ? from + lines.length - 1 : undefined)
    if (!path || lines?.length === 0) return []
    return [{ path, detail: to === undefined ? `读取自第 ${from} 行` : `已读第 ${from}–${to} 行` }]
  }
  const matches = kind === 'glob' ? value?.paths ?? value?.items : value?.matches ?? value?.files ?? value?.items
  if (!Array.isArray(matches)) return []
  const rows = []
  for (const match of matches.slice(0, MAX_ENTRIES)) {
    const path = pathOf(match)
    if (!path) continue
    const line = positiveInteger(match?.lineNumber ?? match?.line_number ?? match?.line)
    const detail = kind === 'glob' ? '路径匹配' : line === undefined ? '检索命中' : `第 ${line} 行命中`
    rows.push({ path, detail })
  }
  return rows
}

function peerOf(left, right) {
  return Boolean(left && right && left.id !== right.id &&
    left.parentId === right.parentId && left.rootId === right.rootId)
}

function relaySender(message) {
  const source = message?.source
  return source?.kind === 'agent-message' && source.form === 'relay' ? source.senderSessionId : undefined
}

function isAnswer(message) {
  // The host prepends its own sender banner as the first block.
  const block = message.content?.[1]
  return block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(ANSWER_PREFIX)
}

/** Keep metadata only; file contents, search excerpts and agent messages are never indexed. */
export function createReadIndex({
  enabledFor, getAgent, listAgents, rootIdOf, readOnlyOf, nameOf, resolvePeerTarget,
} = {}) {
  const children = new Map()
  const calls = new Map()
  const receipts = new Map()
  const shown = new WeakMap()

  function identity(agent) {
    if (!isDelegatedChild(agent) || typeof agent?.id !== 'string') return undefined
    const parentId = agent.session?.header?.parentSession
    const rootId = rootIdOf(agent)
    if (typeof parentId !== 'string' || typeof rootId !== 'string') return undefined
    const previous = children.get(agent.id)
    const rows = previous?.rootId === rootId && previous.parentId === parentId ? previous.rows : new Map()
    return {
      id: agent.id, parentId, rootId,
      name: compact(nameOf?.(agent), 120) || agent.id,
      readOnly: readOnlyOf?.(agent) === true,
      rows,
    }
  }

  function enabled(agent) {
    return enabledFor(rootIdOf(agent)) === true
  }

  function addReceipt(id, sender, target) {
    if (typeof id === 'string' && id && peerOf(sender, target)) {
      remember(receipts, id, { senderId: sender.id, rootId: sender.rootId }, MAX_CALLS)
    }
  }

  async function observe(exec, result) {
    const agent = exec?.agent
    const kind = READ_TOOLS.get(exec?.name)
    if ((!kind && exec?.name !== 'send_message') || !isDelegatedChild(agent) ||
        !result || result.isError === true || !enabled(agent)) return
    const child = identity(agent)
    if (!child) return
    const { callId } = exec
    if (typeof callId !== 'string' || !callId) return
    const callKey = JSON.stringify([child.id, callId])
    if (calls.has(callKey)) return
    remember(calls, callKey, true, MAX_CALLS)
    remember(children, child.id, child, MAX_CHILDREN)
    if (exec.name === 'send_message') {
      const targetId = await resolvePeerTarget?.(exec)
      addReceipt(result.value?.messageId, child, identity(getAgent?.(targetId)) ?? children.get(targetId))
      return
    }
    for (const row of readRows(kind, exec.arguments ?? {}, result.value)) {
      remember(child.rows, JSON.stringify([row.path, row.detail]), row, MAX_ENTRIES)
    }
  }

  function peerSummary(agent, child) {
    const peers = []
    for (const live of listAgents?.() ?? []) {
      const peer = children.get(live?.id)
      if (peer?.rows.size && peerOf(child, peer) && peerOf(child, identity(live))) peers.push(peer)
    }
    const text = peers.slice(0, MAX_PEERS_SHOWN).map((peer) => {
      const rows = [...peer.rows.values()].slice(-MAX_ROWS_SHOWN)
        .map(({ path, detail }) => `${JSON.stringify(path)}（${detail}）`).join('、')
      return `- ${JSON.stringify(peer.name)}（ID ${JSON.stringify(peer.id)}，${peer.readOnly ? '只读任务' : '含写任务'}）：${rows}`
    }).join('\n')
    if (shown.get(agent) === text) return ''
    if (!text) shown.delete(agent)
    return text
  }

  function prepare(agent, messages) {
    if (!agent || !enabled(agent)) {
      if (agent) shown.delete(agent)
      return { messages }
    }
    if (!isDelegatedChild(agent)) {
      const rootId = rootIdOf(agent)
      const filtered = messages.filter((message) => {
        const sender = relaySender(message)
        const receipt = sender && receipts.get(message.id)
        return !(receipt?.rootId === rootId && receipt?.senderId === sender && !message.source.error && !message.error)
      })
      return { messages: filtered.length === messages.length ? messages : filtered }
    }
    const child = identity(agent)
    if (!child || messages.length === 0) return { messages }
    const askers = new Map()
    for (const message of messages) {
      const senderId = relaySender(message)
      if (!senderId) continue
      const sender = identity(getAgent?.(senderId)) ?? children.get(senderId)
      if (!peerOf(child, sender)) continue
      addReceipt(message.id, sender, child)
      if (!isAnswer(message)) askers.set(sender.id, sender.name)
    }
    const summary = peerSummary(agent, child)
    const parts = []
    if (summary) {
      parts.push('【平级已读索引】下列条目是路径和命中位置。可用 send_message 请对方概括其已读上下文，减少重复读取。\n' + summary)
    }
    for (const [id, name] of [...askers].slice(0, MAX_PEERS_SHOWN)) {
      parts.push(`这是来自平级子代理 ${JSON.stringify(name)} 的只读上下文咨询。请仅基于已读事实简明回答，保持文件和主任务边界。用 send_message 向 ${JSON.stringify(id)} 回复，正文以 ${ANSWER_PREFIX} 开头，然后继续原任务。`)
    }
    return {
      messages,
      text: parts.join('\n'),
      acknowledge: summary ? () => shown.set(agent, summary) : undefined,
    }
  }

  return { observe, prepare }
}
