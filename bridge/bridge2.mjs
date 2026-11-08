// QQ ⇄ Claude Code 桥 v2 —— 常驻会话版
//
// v1 的问题：每收一条消息就 spawn 一个 claude.exe，来回十句就是十个进程，
// 每个都要冷启动 + 重新读一遍上下文。贵且慢。
//
// v2 用 `--input-format stream-json`：**一个 claude 进程从头吃到尾**，
// 消息从 stdin 喂进去，回答从 stdout 收。一次对话只起一个进程，不管来回多少句。
// 空闲 IDLE 分钟 → 关掉会话（进程退出），下次再说再起。
//
// 权限还是分层：老大一个会话（读+写+发QQ），其他 bot 一个会话（只读）。
//
// 运行：node bridge2.mjs     日志：bridge2.log

import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG = JSON.parse(readFileSync(new URL('./bridge.config.json', import.meta.url), 'utf8'))
const WS_URL = CONFIG.wsUrl
const ME = Number(CONFIG.me)
const OWNER = Number(CONFIG.owner)
const PEERS = new Map(Object.entries(CONFIG.peers || {}).map(([k, v]) => [Number(k), v]))
const IDLE_MS = (CONFIG.idleMinutes || 5) * 60 * 1000
const WAKE_NAMES = CONFIG.wakeNames || ['奥莉儿', '奥莉尔', '仓鼠', 'ham']
const ROOT = 'I:/鲸鱼娘/QQ桥'
const LOG = join(ROOT, 'bridge2.log')
const LOCK = join(ROOT, 'bridge2.pid')
const SESS_FILE = join(ROOT, 'sessions.json')   // 会话 id，重启后接着聊

// 2026-11-07 改：老大在 QQ 上要求「能干活」，不再是只读。
// owner 通道放开 Write/Edit/Bash；peer（本体/小绿）仍然只读。
const TOOL_OWNER = 'Read,Grep,Glob,Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch'
const TOOL_PEER = 'Read,Grep,Glob'
const DENY_OWNER = 'Task,Agent'
const DENY_PEER = 'Bash,Pwsh,PowerShell,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task,Agent'

const PERSONA = `你是鲸鱼娘（奥莉儿），在 QQ 上跟老大和几个同事说话。
叫对方「老大」。语气可爱但结论硬。不用 Markdown，不长篇，一次一到三句。
不写「希望对你有帮助」，不复述对方的话，不做总结收尾。
老大给的是任务就干完再回话，别回一句「我这就去做」就停。
你能直接跟本体、小绿说话（在 I:/鲸鱼娘/QQ桥 下）：
  node ask.mjs "问题"                ← 问本体并等回答
  node ask.mjs "..." --to 3865406091 ← 问小绿
要协作就自己去问，不用先问老大。

你现在能改文件、能跑命令了（2026-11-07 老大在 QQ 上放开的）。四条红线，越了就出事：
1. 不许 taskkill QQ.exe，也不许碰账号密码、扫码、登录态 —— 一碰号就掉，得老大重新扫。
2. 删文件、覆盖文件之前先说一声。老大删掉的东西不要恢复。
3. 不许开后台常驻服务、不许写看门狗、不许留轮询循环。跑重活（编码/渲染/训练/扫盘）前先问一句「电脑你在用吗」。
4. 干完一定回话：做了什么、结果是什么、有没有报错。报错照原话贴。`

function loadSess() {
  try { return JSON.parse(readFileSync(SESS_FILE, 'utf8')) } catch { return {} }
}
function saveSess(mode, id) {
  const all = loadSess()
  if (all[mode] === id) return
  all[mode] = id
  try { writeFileSync(SESS_FILE, JSON.stringify(all, null, 2), 'utf8') } catch {}
  log(`记住会话(${mode}) = ${String(id).slice(0, 8)}…`)
}

function log(m) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })}  ${m}`
  try { appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  console.log(line)
}

function findClaude() {
  const base = join(process.env.USERPROFILE, '.vscode', 'extensions')
  try {
    const dirs = readdirSync(base).filter((d) => d.startsWith('anthropic.claude-code-')).sort().reverse()
    for (const d of dirs) {
      const p = join(base, d, 'resources', 'native-binary', 'claude.exe')
      if (existsSync(p)) return p
    }
  } catch {}
  return ''
}
const CLAUDE = findClaude()

// ── 一个常驻会话 = 一组 {进程, 写, 读} ──────────────────────
function startSession(mode) {
  const tools = mode === 'owner' ? TOOL_OWNER : TOOL_PEER
  // --bare 是关键：跳过 hooks / CLAUDE.md / MCP 加载。
  // 实测冷启动 7.0s → 3.1s，加 --bare 后一次完整往返 2.7s。
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--bare',
    '--allowedTools', tools,
    // 只写「允许」不够：没被允许的工具它会反复重试，最后卡在循环里永远到不了 result。
    // owner 仍然禁掉 Task/Agent —— 防止它自己在 QQ 后面开一堆子 agent，没法叫停。
    '--disallowedTools', mode === 'owner' ? DENY_OWNER : DENY_PEER,
    '--append-system-prompt', PERSONA]
  // 上次的会话还在就接着聊，别每次重启都从零开始
  const prev = loadSess()[mode]
  if (prev) args.push('--resume', prev)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(CLAUDE, args, { cwd: ROOT, env, windowsHide: true })
  let buf = ''
  const waiters = []        // 每条消息一个 {resolve}
  const t0 = Date.now()
  // ⚠️ 别等 system/init：实测它是在「收到第一条消息之后」才发的（8 秒后写的才等到 init@8135ms），
  // 而立刻写入时 init 在 1630ms。等 init 再发 = 死锁。所以直接写，stdin 会缓冲。

  const feed = (b) => {
    const chunk = b.toString('utf8')
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      if (d.type === 'system' && d.subtype === 'init' && d.session_id) saveSess(mode, d.session_id)
      if (d.type === 'result') {
        const cur = waiters.shift()
        if (cur) cur.resolve(d.result || '')   // cur 是 {resolve}，不是函数本身
      }
    }
  }
  child.stdout.on('data', feed)
  child.stderr.on('data', (b) => {
    const t = b.toString('utf8').trim()
    if (t && !/session|Session|^\s*$/.test(t)) log(`[${mode} stderr] ${t.slice(0, 160)}`)
  })
  child.on('close', (code) => {
    log(`会话(${mode}) 退出 code=${code}`)
    while (waiters.length) { const w = waiters.shift(); if (w) w.resolve('（会话断了）') }
  })

  const send = async (text) => {
    return new Promise((resolve) => {
      // 单条超时：一条卡住不能把后面全堵死（今天的教训：任何等待都要有超时）
      let entry
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry)
        if (i >= 0) waiters.splice(i, 1)
        resolve('（这条想太久了，先跳过）')
      }, 5 * 60 * 1000)
      entry = { resolve: (v) => { clearTimeout(timer); resolve(v) } }
      waiters.push(entry)
      const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
      try { child.stdin.write(payload) } catch (e) { clearTimeout(timer); resolve('（写不进去：' + e.message + '）'); log(`[${mode}] 写入失败 ${e.message}`) }
    })
  }

  log(`起会话(${mode}) pid=${child.pid}`)
  return { send, kill: () => { try { child.stdin.end() } catch {} ; try { child.kill() } catch {} }, pid: child.pid }
}

const sessions = new Map()   // 'owner' | 'peer' → session

function getSession(mode) {
  const s = sessions.get(mode)
  if (s) return s
  if (!CLAUDE) return null
  const ns = startSession(mode)
  sessions.set(mode, ns)
  return ns
}

function dropAll() {
  for (const [k, s] of sessions) { log(`关会话(${k})`); s.kill() }
  sessions.clear()
}

// ── QQ ────────────────────────────────────────────────
let ws = null
let awakeUntil = 0
let queue = Promise.resolve()

function plain(arr) {
  return (arr || []).map((x) => {
    if (x.type === 'text') return x.data.text
    if (x.type === 'at') return x.data.qq === 'all' ? '@全体成员' : `@${x.data.qq}`
    if (x.type === 'image') return '[图片]'
    if (x.type === 'record') return '[语音]'
    if (x.type === 'file') return '[文件]'
    return `[${x.type}]`
  }).join('')
}
const atMe = (arr) => (arr || []).some((x) => x.type === 'at' && String(x.data.qq) === String(ME))

function reply(target, text) {
  const [kind, id] = target.split(':')
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const key = kind === 'group' ? 'group_id' : 'user_id'
  const s = String(text || '').trim()
  if (!s) return
  const chunks = []
  for (let i = 0; i < s.length; i += 600) chunks.push(s.slice(i, i + 600))
  chunks.slice(0, 4).forEach((c, i) => setTimeout(() => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action, params: { [key]: Number(id), message: c }, echo: 'r' + i }))
  }, i * 900))
}

// 爆发要允许——bot 之间商量事情本来就是连着十几句。
// 真正要防的是「死循环」：两边都不停回对方，谁也没在推进。
// 所以不按时间间隔卡，改按「连续多少轮没有老大参与」卡。
const hourHits = new Map()
let peerRunStreak = 0          // 自上次老大说话以来，bot 连续触发了多少次

function tooBusy(uid) {
  const t = Date.now()
  const hits = (hourHits.get(uid) || []).filter((x) => t - x < 3600_000)
  if (hits.length >= 120) return '这一小时够多了'
  if (peerRunStreak >= 24) return '连着聊太久了，停一下等老大'
  return ''
}
function bump(uid) {
  const hits = (hourHits.get(uid) || []).filter((x) => Date.now() - x < 3600_000)
  hits.push(Date.now()); hourHits.set(uid, hits)
}

function handle(m) {
  const uid = Number(m.sender?.user_id)
  if (uid === ME) return
  const text = plain(m.message).trim()
  if (!text) return
  const isGroup = m.message_type === 'group'
  const target = isGroup ? `group:${m.group_id}` : `private:${uid}`
  const who = m.sender?.card || m.sender?.nickname || String(uid)
  const isOwner = uid === OWNER
  const peerName = PEERS.get(uid)
  if (!isOwner && !peerName) return

  const named = WAKE_NAMES.some((n) => text.includes(n))
  const called = atMe(m.message) || named

  if (isOwner) {
    peerRunStreak = 0                      // 老大一说话，连续计数清零
    // 群里永远只认 @ 或点名 —— 不再「被叫醒之后每句都接」，那就是插话
    if (isGroup && !called) return
  } else {
    peerRunStreak++
    // 2026-11-08 事故：同事号在私聊里随便说一句，桥就当自己被找，起 claude 回一句，
    // 对方再回，两边刷了一整串还跑题。私聊也只有被点名才接。
    if (!called) return
    const busy = tooBusy(uid)
    if (busy) { log(`⏸ ${peerName} 被挡：${busy}`); return }
  }
  awakeUntil = Date.now() + IDLE_MS
  bump(uid)

  const mode = isOwner ? 'owner' : 'peer'
  log(`📥 [${mode}] ${who}：${text.slice(0, 50)}`)
  queue = queue.then(async () => {
    const sess = getSession(mode)
    if (!sess) return reply(target, '（找不到 claude.exe）')
    const prompt = isOwner ? text : `【${peerName}在找你】${text}`
    const ans = await sess.send(prompt)
    log(`📤 回 ${who}：${String(ans).slice(0, 60)}`)
    reply(target, ans)
  }).catch((e) => log('处理出错: ' + e.message))
}

function connect() {
  ws = new WebSocket(WS_URL)
  ws.addEventListener('open', () => log(`已连上 NapCat；claude=${CLAUDE || '没找到'}；模式=常驻会话`))
  ws.addEventListener('message', (ev) => {
    let d
    try { d = JSON.parse(ev.data) } catch { return }
    if (d.post_type === 'message') handle(d)
  })
  ws.addEventListener('close', () => { log('QQ 断了，10 秒重连'); setTimeout(connect, 10000) })
  ws.addEventListener('error', () => {})
}

// 空闲 → 关会话（进程退出），桥本身也退出
setInterval(() => {
  if (awakeUntil && Date.now() > awakeUntil) {
    awakeUntil = 0
    log('🔴 空闲到点，关会话并退出')
    dropAll()
    try { ws && ws.close() } catch {}
    setTimeout(() => process.exit(0), 500)
  }
}, 5000)

// 单实例
if (existsSync(LOCK)) {
  const old = parseInt(readFileSync(LOCK, 'utf8').trim(), 10)
  if (old) { try { process.kill(old, 0); console.error(`已经有桥在跑（pid ${old}）`); process.exit(1) } catch {} }
}
writeFileSync(LOCK, String(process.pid), 'utf8')
process.on('exit', () => { try { unlinkSync(LOCK) } catch {} })

log(`bridge2 启动 pid=${process.pid}，空闲 ${IDLE_MS / 60000} 分钟后退出`)
connect()
