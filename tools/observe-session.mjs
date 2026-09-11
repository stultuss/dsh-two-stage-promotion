/**
 * 二阶段晋升模式 —— 会话「模型可见面」观察器。
 *
 * 把一个会话的持久日志还原成时间线:每次请求的 wire 工具面、输出预算上限、
 * 渲染出的 system prompt 规模,以及晋升/压缩这类面切换点。
 *
 * 用法:
 *   node tools/observe-session.mjs <session.jsonl.zstd | session.jsonl>
 *
 * 日志路径(每个工作区一个目录):
 *   ~/.dsh/sessions/<workspace-slug>/<session-id>/session.v3.jsonl.zstd
 *
 * 注意:该日志是逐次追加的**多帧** zstd 文件,Node 的 zstdDecompressSync 一次
 * 只解一帧,所以这里按 zstd magic 切帧后逐帧解压再拼接。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Read one session log, transparently joining its appended zstd frames. */
export function readSessionLog(file) {
  const buf = readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  const offsets = []
  for (let i = 0; (i = buf.indexOf(ZSTD_MAGIC, i)) !== -1; i += 4) offsets.push(i)
  const parts = offsets.map((start, index) =>
    zstdDecompressSync(buf.subarray(start, index + 1 < offsets.length ? offsets[index + 1] : buf.length)))
  return Buffer.concat(parts).toString('utf8')
}

/** Parse a session log into its validated event objects, skipping a crash tail. */
export function sessionEvents(file) {
  const events = []
  for (const line of readSessionLog(file).split('\n')) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn last line is a crash tail, not a parsing failure.
    }
  }
  return events
}

/** Classify one request envelope into the shape the model actually saw. */
function shapeOf(tools, maxTokens) {
  if (tools.length === 1 && tools[0] === 'run_code') return '晋升后 · PTC(仅 run_code)'
  if (tools.length === 1) return `受控 · 单工具(${tools[0]})`
  return `原生目录(${tools.length} 个工具)`
}

function main() {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('usage: node tools/observe-session.mjs <session.jsonl.zstd>')
    process.exit(2)
  }
  const events = sessionEvents(file)
  console.log(`会话日志: ${file}`)
  console.log(`事件总数: ${events.length}\n`)
  console.log('位置      事件                    模型可见面')
  console.log('-'.repeat(112))

  let lastShape = null
  let calls = 0
  for (const event of events) {
    const where = event.type === 'step/start' ? `${event.data.turn}/${event.data.step}` : ''

    if (event.type === 'system/message') {
      const text = (event.data.message?.content ?? []).map((block) => block.text ?? '').join('')
      const lines = text.split('\n').filter((line) => line.trim() !== '').length
      const ptc = text.includes('Programmatic Tool Calling') ? ' + PTC 说明' : ''
      console.log(`${where.padEnd(9)} system prompt          ${lines} 行 / ${text.length} 字符${ptc}`)
      continue
    }

    if (event.type === 'request/header') {
      const header = event.data.header ?? {}
      const tools = (header.tools ?? []).map((tool) => tool.name)
      const maxTokens = header.config?.maxTokens
      const effort = header.config?.reasoningEffort
      const shape = shapeOf(tools, maxTokens)
      const changed = shape !== lastShape
      lastShape = shape
      const shown = tools.length <= 4 ? tools.join(', ') : `${tools.slice(0, 4).join(', ')}, …`
      console.log(
        `${where.padEnd(9)} request/header         ${shape.padEnd(24)} maxTokens=${String(maxTokens ?? '未设置').padEnd(7)} effort=${String(effort ?? '默认').padEnd(5)} [${shown}]`
        + (changed ? '   ← 面切换' : ''),
      )
      continue
    }

    if (event.type === 'user/message') {
      const kind = event.data.source?.kind ?? '(无 source)'
      if (kind === 'user' || kind === 'goal') continue
      console.log(`${where.padEnd(9)} 注入消息                kind=${kind}${kind === 'instruction-hint' ? '(参考文件提示)' : ''}`)
      continue
    }

    if (event.type === 'compaction/start' || event.type === 'compaction/end') {
      console.log(`${where.padEnd(9)} ${event.type}${event.type === 'compaction/end' ? '          回到受控阶段(下次请求重新锚定)' : ''}`)
      continue
    }

    if (event.type === 'assistant/message') {
      const usage = event.data.usage ?? {}
      const output = usage.outputTokens
      const reasoning = usage.reasoningTokens
      if (output !== undefined || reasoning !== undefined) {
        const censored = usage.outputTokens !== undefined && usage.outputTokens === usage.reasoningTokens ? '  ← 整窗被思考吃光(截断)' : ''
        console.log(`${where.padEnd(9)} assistant/message      out=${String(output ?? '?')} rsn=${String(reasoning ?? '?')}${censored}`)
      }
      continue
    }

    if (event.type === 'turn/end') {
      const kind = event.data.reason?.kind ?? '(未知)'
      console.log(`${where.padEnd(9)} turn/end               kind=${kind}${kind === 'max-tokens' ? '  ← 命中输出上限(一阶段窗)' : ''}`)
      continue
    }

    if (event.type === 'tool/call' && calls < 6) {
      calls += 1
      console.log(`${where.padEnd(9)} tool/call               ${event.data.name}`)
    }
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) main()
