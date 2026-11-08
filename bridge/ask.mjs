// 问同事A一句话，等她的回话，把答案打出来。给桥里干活的 claude 用。
//
//   node ask.mjs "会议室的结论你整理好了吗"
//   node ask.mjs "..." --to <PEER_B_QQ>        # 问同事B
//   node ask.mjs "..." --wait 120             # 最多等 120 秒
//   node ask.mjs "..." --tell                 # 只发不等（发完就走）
//
// 她可能连回好几条，会等到「安静 4 秒」再一起打印出来。
import { readFileSync } from 'node:fs'
import { createClient } from './onebot.mjs'

// 账号/端口全部来自 bridge.config.json
const CONFIG = JSON.parse(readFileSync(new URL('./bridge.config.json', import.meta.url), 'utf8'))

const args = process.argv.slice(2)
function flag(name, def = '') {
  const i = args.indexOf(name)
  if (i < 0) return def
  const v = args[i + 1] || ''
  args.splice(i, 2)
  return v
}
const to = Number(flag('--to', CONFIG.askDefaultTo || ''))
const waitSec = Number(flag('--wait', '90'))
const tellOnly = args.includes('--tell')
if (tellOnly) args.splice(args.indexOf('--tell'), 1)

const NAME = (CONFIG.peers || {})[to] || String(to)
const text = args.join(' ').trim()
if (!text) {
  console.error('用法：node ask.mjs "要说的话" [--to QQ号] [--wait 秒] [--tell]')
  process.exit(2)
}

const c = createClient(CONFIG.wsUrl)
await c.connect()

const ok = await c.send(`private:${to}`, text)
if (!ok) { console.error('消息没发出去'); process.exit(1) }

if (tellOnly) {
  console.log(`已发给${NAME}，没等回话`)
  c.close()
  process.exit(0)
}

console.log(`已发给${NAME}：${text}`)
console.log(`等回话（最多 ${waitSec} 秒，安静 4 秒就收）…`)

const got = []
let lastAt = Date.now()
let done = false

c.onMessage((d) => {
  if (d.post_type !== 'message' || d.message_type !== 'private') return
  if (Number(d.sender?.user_id) !== to) return
  const t = (d.message || []).map((x) => (x.type === 'text' ? x.data.text : `[${x.type}]`)).join('')
  if (!t.trim()) return
  got.push(t.trim())
  lastAt = Date.now()
})

const deadline = Date.now() + waitSec * 1000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500))
  if (got.length && Date.now() - lastAt > 4000) { done = true; break }
}

console.log('---')
if (got.length) {
  console.log(`${NAME} 回了：`)
  for (const g of got) console.log(g)
} else {
  console.log(`${NAME} 没回（等了 ${waitSec} 秒）`)
}
c.close()
process.exit(got.length ? 0 : 3)
