// QQ 命令行工具 —— 给桥里的 claude 用，让它能自己去跟同事A/同事B说话
//
//   node qq.mjs send group:263836170 "在吗"
//   node qq.mjs send private:<PEER_A_QQ> "第一句|||第二句"
//   node qq.mjs history group:263836170 [条数]
//   node qq.mjs whoami
//
// 默认用我的号（<BOT_QQ> / 3004）。加 --as <PEER_C_QQ> 可以换号发（比如让溯发）。
import { readFileSync } from 'node:fs'
import { createClient } from './onebot.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  if (i < 0) return ''
  const v = args[i + 1] || ''
  args.splice(i, 2)
  return v
}

// 端口/账号全部来自 bridge.config.json，代码里不留任何真实号
const CONFIG = JSON.parse(readFileSync(new URL('./bridge.config.json', import.meta.url), 'utf8'))
const as = flag('--as')
const URLS = CONFIG.accounts || {}
const url = URLS[as] || CONFIG.wsUrl

const [cmd, target, ...rest] = args

function plain(arr) {
  return (arr || []).map((x) => {
    if (x.type === 'text') return x.data.text
    if (x.type === 'at') return `@${x.data.qq}`
    if (x.type === 'image') return '[图片]'
    if (x.type === 'record') return '[语音]'
    if (x.type === 'file') return '[文件]'
    return `[${x.type}]`
  }).join('')
}

const c = createClient(url)

if (cmd === 'whoami') {
  const me = await c.login()
  console.log(`我登录的是 ${me.nickname} (${me.user_id})`)
} else if (cmd === 'send') {
  const text = rest.join(' ')
  if (!target || !text) { console.error('用法：send <group:群号|private:QQ号> <内容>'); process.exit(2) }
  const ok = await c.send(target, text)
  console.log(ok ? '发出去了' : '发送失败')
  process.exit(ok ? 0 : 1)
} else if (cmd === 'history') {
  const n = Number(rest[0] || 10)
  const [kind, id] = String(target || '').split(':')
  const ms = kind === 'private' ? await c.privateHistory(Number(id), n) : await c.history(Number(id), n)
  for (const m of ms) {
    const who = m.sender?.card || m.sender?.nickname || m.sender?.user_id
    const t = new Date((m.time || 0) * 1000).toLocaleTimeString('zh-CN', { hour12: false })
    console.log(`${t}  ${who}：${plain(m.message).slice(0, 120)}`)
  }
} else {
  console.log(`用法：
  node qq.mjs send <group:群号|private:QQ号> "内容"    （||| 可拆多条）
  node qq.mjs history <group:群号|private:QQ号> [条数]
  node qq.mjs whoami
  加 --as <PEER_C_QQ> 可以换成溯的号发`)
}
c.close()
process.exit(0)
