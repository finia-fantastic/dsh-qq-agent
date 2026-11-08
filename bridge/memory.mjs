// QQ 桥的记忆层 —— 照 aurabot 那套逻辑移植。
//
// 她那套是这样的：
//   聊天留档 → 定时抽事实 → 一条条存（带「关于谁」和重要性）→ 回话前召回 top-N → 旧的压缩
// 这里用 JSON + jsonl 实现同一套，不引入数据库依赖。
//
// 文件：
//   memory/memories.json      记忆条目
//   memory/chatlog/YYYY-MM-DD.jsonl   聊天留档（默认留 7 天）
//   memory/state.json         抽到哪了、什么时候抽的
//
// 三个入口：
//   log(who, name, text)      每条消息都记
//   recall(query, {about})    回话前取相关记忆（词面打分，和 aurabot 一样）
//   consolidate()             把没抽过的聊天交给 claude 抽成事实

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, 'memory')
const LOGDIR = join(DIR, 'chatlog')
const MEMFILE = join(DIR, 'memories.json')
const STATE = join(DIR, 'state.json')

const KEEP_LOG_DAYS = 7          // 聊天留档保留天数（和 aurabot 一样）
const RECALL_K = 6               // 每次召回几条
const MAX_ITEMS = 500            // 条目上限，超了按「重要性 × 新旧」淘汰
const CONSOLIDATE_EVERY = 40     // 攒够多少条聊天抽一次
const NO_WINDOW = 0x08000000

mkdirSync(LOGDIR, { recursive: true })

const today = () => new Date().toISOString().slice(0, 10)
const now = () => Date.now()
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1), 'utf8')

// ── 留档 ──────────────────────────────────────────────
export function log(who, name, text, chatId = '') {
  if (!text) return
  const line = JSON.stringify({ at: now(), who, name, chatId, text: String(text).slice(0, 2000) })
  try { appendFileSync(join(LOGDIR, today() + '.jsonl'), line + '\n', 'utf8') } catch {}
}

function recentChat(limit = 400) {
  const out = []
  let files
  try { files = readdirSync(LOGDIR).filter((f) => f.endsWith('.jsonl')).sort() } catch { return out }
  for (const f of files) {
    let txt = ''
    try { txt = readFileSync(join(LOGDIR, f), 'utf8') } catch { continue }
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
  }
  return out.slice(-limit)
}

function pruneOldLogs() {
  const cutoff = new Date(now() - KEEP_LOG_DAYS * 86400_000).toISOString().slice(0, 10)
  let files = []
  try { files = readdirSync(LOGDIR) } catch { return }
  for (const f of files) {
    const day = f.slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
      try { unlinkSync(join(LOGDIR, f)) } catch {}
    }
  }
}

// ── 打分：词面重叠 + 关于谁 + 新旧 ────────────────────
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '在', '有', '和', '就', '不', '也', '很', '吗', '呢', '啊', '吧', '这', '那', '一个', '什么', '怎么'])

// 中文按「双字组 + 单字」两级取特征：只靠双字组，问法一变就全落空
// （实测：问「该不该再问」找不到「不喜欢被反复问」那条）。
function grams(s) {
  const t = String(s || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
  const bi = new Set(), uni = new Set()
  for (const seg of t.split(' ')) {
    if (!seg) continue
    if (/^[a-z0-9]+$/.test(seg)) { if (seg.length > 1 && !STOP.has(seg)) bi.add(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2)
      if (!STOP.has(bg)) bi.add(bg)
    }
    for (const ch of seg) if (!STOP.has(ch)) uni.add(ch)
  }
  return { bi, uni }
}

function score(query, item, about) {
  const q = grams(query), it = grams(item.text)
  let biHit = 0, uniHit = 0
  for (const g of q.bi) if (it.bi.has(g)) biHit++
  for (const g of q.uni) if (it.uni.has(g)) uniHit++
  const qn = Math.max(3, q.bi.size + q.uni.size * 0.5)
  let s = (biHit * 2 + uniHit * 0.55) / Math.sqrt(qn) * 1.6
  if (about && String(item.about) === String(about)) s += 1.5      // 关于这个人，加权
  const ageDays = (now() - (item.at || 0)) / 86400_000
  s += Math.max(0, 1 - ageDays / 60) * 0.5                          // 越新越容易被想起
  s *= 0.6 + 0.8 * (item.importance ?? 0.5)                          // 重要性
  return s
}

export function recall(query, { about = '', k = RECALL_K } = {}) {
  const items = readJson(MEMFILE, { items: [] }).items || []
  if (!items.length) return []
  return items
    .map((it) => ({ it, s: score(query, it, about) }))
    .filter((x) => x.s > 0.6)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
}

export function remember({ text, about = '', aboutName = '', importance = 0.5, source = 'auto' }) {
  const db = readJson(MEMFILE, { items: [] })
  const norm = String(text).trim()
  if (norm.length < 6) return false
  if ((db.items || []).some((x) => x.text === norm)) return false      // 完全重复的直接丢
  db.items.push({ id: Math.random().toString(36).slice(2, 10), text: norm, about, aboutName, importance, source, at: now() })
  if (db.items.length > MAX_ITEMS) {
    db.items.sort((a, b) => ((b.importance ?? 0.5) * 1e12 + (b.at || 0)) - ((a.importance ?? 0.5) * 1e12 + (a.at || 0)))
    db.items = db.items.slice(0, MAX_ITEMS)
  }
  writeJson(MEMFILE, db)
  return true
}

// ── 抽事实 ────────────────────────────────────────────
function callClaude(prompt) {
  const exe = process.env.QQ_CLAUDE || findClaude()
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(exe, ['-p', prompt, '--bare', '--output-format', 'json',
      '--disallowedTools', 'Bash,Write,Edit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent'],
      { env, windowsHide: true, creationflags: NO_WINDOW })
    let out = ''
    const t = setTimeout(() => { try { child.kill() } catch {} ; resolve('') }, 180000)
    child.stdout.on('data', (b) => { out += b.toString('utf8') })
    child.on('close', () => { clearTimeout(t); try { resolve(JSON.parse(out).result || '') } catch { resolve('') } })
    child.on('error', () => { clearTimeout(t); resolve('') })
  })
}

function findClaude() {
  const c = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ].find((p) => p && existsSync(p))
  return c || 'claude'
}

let busy = false

export async function consolidate(force = false) {
  if (busy) return { skipped: 'busy' }
  busy = true
  try {
    const st = readJson(STATE, { offset: 0, lastAt: 0, added: 0 })
    const all = recentChat(2000)
    const pending = all.slice(st.offset || 0)
    if (!force && pending.length < CONSOLIDATE_EVERY) return { skipped: `只攒了 ${pending.length} 条` }

    const batch = pending.slice(-120)
    const text = batch.map((m) => `${m.name}: ${m.text}`).join('\n').slice(0, 12000)
    const prompt = `下面是 QQ 聊天记录。请抽出值得长期记住的事实，最多 8 条。\n` +
      `规则：\n- 只记「关于某个人」的稳定信息（偏好、约定、近况、说过的话），不要记寒暄和一次性的情绪\n` +
      `- 每条一句话，写清是谁\n- importance 0~1，越可能以后再用到越高\n` +
      `- 没有值得记的就返回空数组\n\n只输出 JSON 数组，格式：\n` +
      `[{"text":"...","aboutName":"人名","importance":0.6}]\n\n聊天记录：\n${text}`

    const raw = await callClaude(prompt)
    let arr = []
    const m = String(raw).match(/\[[\s\S]*\]/)
    if (m) { try { arr = JSON.parse(m[0]) } catch {} }

    let added = 0
    for (const x of arr.slice(0, 8)) {
      if (!x || !x.text) continue
      if (remember({ text: x.text, aboutName: x.aboutName || '', importance: Number(x.importance) || 0.5, source: 'auto' })) added++
    }
    writeJson(STATE, { offset: (st.offset || 0) + batch.length, lastAt: now(), added })
    pruneOldLogs()
    return { added, scanned: batch.length }
  } finally {
    busy = false
  }
}

export function stats() {
  const db = readJson(MEMFILE, { items: [] })
  const st = readJson(STATE, {})
  return { items: (db.items || []).length, offset: st.offset || 0, lastAt: st.lastAt || 0, pending: recentChat(2000).length - (st.offset || 0) }
}

/** 拼成一段给模型看的上下文。没有就返回空串。 */
export function contextFor(query, { about = '' } = {}) {
  const hits = recall(query, { about })
  if (!hits.length) return ''
  return '【你想起来的事，只是背景，不要逐条复述】\n' +
    hits.map((h) => '- ' + h.it.text).join('\n')
}

// 命令行：node memory.mjs stats | consolidate | recall "关键词"
if (process.argv[1] && process.argv[1].endsWith('memory.mjs')) {
  const cmd = process.argv[2] || 'stats'
  if (cmd === 'stats') console.log(JSON.stringify(stats(), null, 1))
  else if (cmd === 'consolidate') console.log(JSON.stringify(await consolidate(true), null, 1))
  else if (cmd === 'recall') {
    const q = process.argv.slice(3).join(' ')
    for (const h of recall(q)) console.log(h.s.toFixed(2), h.it.text)
  } else console.log('用法：node memory.mjs stats|consolidate|recall "关键词"')
}
