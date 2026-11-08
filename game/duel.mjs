// 双人对决：同样一件事，谁花掉的 token 少谁赢，奖金 100 万 token。
//
//   node duel.mjs --dry          离线演练（不调模型，看流程）
//   node duel.mjs --live         真跑
//   node duel.mjs --live --judge 再加一次裁判调用，判两人是否都完成了任务
//
// 规则：
//   1. 两边拿到完全相同的任务
//   2. 任务完成的前提下，总 token 少的赢
//   3. 都没完成，也还是少的赢——这游戏比的本来就是省
//
// ⚠️ 计费口径：input + output + cache 读写全部算进去。
//    人格也计入成本——写得越长越贵，这是故意的。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STOP = join(HERE, 'STOP')
const LOGDIR = join(HERE, 'logs')
// 找 claude 可执行文件。Git Bash 里 PATH 是 POSIX 格式，Node 的 spawn 认不出，
// 所以必须拿到 Windows 绝对路径（2026-11-08 实测：直接 spawn('claude') 报 ENOENT）。
function findClaude() {
  if (process.env.GAME_CLAUDE) return process.env.GAME_CLAUDE
  const cands = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
  ]
  for (const c of cands) if (c && existsSync(c)) return c
  return 'claude'
}
const CLAUDE = findClaude()
const TIMEOUT = 180 * 1000

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const JUDGE = args.includes('--judge')

// 两个人：算计的 vs 摆烂的
const A = 'ache'      // 阿澈 #406 —— 会把每个字都算一遍
const B = 'laoxian'   // 老咸 #024 —— 能躺着绝不坐着

// 任务：越简单越好，胜负全在"多写了多少废话"
const TASK = `用 Python 写一个函数 is_palindrome(s)：忽略大小写和非字母数字字符，判断是不是回文。
只输出代码和一个空行后的 3 个自测断言，不要任何解释、不要标题、不要 markdown 代码块围栏。`

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
let logFile = ''
const say = (l) => { console.log(l); if (logFile) appendFileSync(logFile, l + '\n', 'utf8') }

function persona(id) {
  const p = join(HERE, 'personas', id + '.md')
  if (!existsSync(p)) throw new Error('找不到人格：' + p)
  return readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim()
}

function nameOf(id) {
  const m = readFileSync(join(HERE, 'personas', id + '.md'), 'utf8').match(/^name:\s*(.+)$/m)
  return m ? m[1].trim() : id
}

function run(id, task, asJudge = false) {
  if (!LIVE) return Promise.resolve(canned(id, asJudge))
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const argv = ['-p', task, '--bare', '--output-format', 'json',
      '--disallowedTools', 'Bash,Write,Edit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent']
    if (!asJudge) argv.push('--append-system-prompt', persona(id))

    const t0 = Date.now()
    const child = spawn(CLAUDE, argv, { env, windowsHide: true })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, TIMEOUT)
    child.stdout.on('data', (b) => { out += b.toString('utf8') })
    child.on('close', () => {
      clearTimeout(timer)
      let d = {}
      try { d = JSON.parse(out) } catch {}
      const u = d.usage || {}
      const tok = (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
      resolve({
        id, text: (d.result || '').trim(),
        tokens: tok,
        detail: {
          in: u.input_tokens || 0,
          out: u.output_tokens || 0,
          cacheW: u.cache_creation_input_tokens || 0,
          cacheR: u.cache_read_input_tokens || 0,
        },
        cost: d.total_cost_usd || 0,
        ms: Date.now() - t0,
      })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ id, text: '', tokens: 0, detail: {}, cost: 0, ms: 0, err: e.message }) })
  })
}

function canned(id, asJudge) {
  if (asJudge) return { id: 'judge', text: '两人都完成。', tokens: 0, detail: {}, cost: 0, ms: 0 }
  const table = {
    ache: { text: 'def is_palindrome(s):\n    ...\n\nassert ...', tokens: 742, detail: { in: 961, out: 181, cacheW: 0, cacheR: 0 }, cost: 0.004 },
    laoxian: { text: 'def is_palindrome(s):...', tokens: 231, detail: { in: 702, out: 29, cacheW: 0, cacheR: 0 }, cost: 0.001 },
  }
  const t = table[id] || { text: '', tokens: 0, detail: {} }
  return { id, text: t.text, tokens: t.tokens, detail: t.detail, cost: t.cost || 0, ms: 1800 }
}

const fmt = (n) => n.toLocaleString('en-US')

async function main() {
  mkdirSync(LOGDIR, { recursive: true })
  logFile = join(LOGDIR, `duel-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.md`)

  if (existsSync(STOP)) { console.log('看到 STOP 文件，不跑。'); return }

  say(`# 双人对决 · 最少 token 赢 100 万 token\n`)
  say(`> ${LIVE ? '真跑' : '离线演练'} · ${stamp()}\n`)
  say(`**任务**\n\n${TASK}\n`)
  say(`---\n`)

  const a = await run(A, TASK)
  const b = await run(B, TASK)

  for (const r of [a, b]) {
    say(`## ${nameOf(r.id)}`)
    say('```py')
    say(r.text || '（没输出）')
    say('```')
    const d = r.detail || {}
    say(`\n消耗：**${fmt(r.tokens)} token**（输入 ${fmt(d.in || 0)} · 输出 ${fmt(d.out || 0)} · 缓存写 ${fmt(d.cacheW || 0)} · 缓存读 ${fmt(d.cacheR || 0)}）`)
    say(`用时 ${(r.ms / 1000).toFixed(1)}s · 成本 $${(r.cost || 0).toFixed(4)}${r.err ? ' · 出错：' + r.err : ''}\n`)
  }

  let judgeNote = ''
  if (JUDGE) {
    const j = await run(null, `下面是两个人对同一个任务的答案。任务：${TASK}\n\n甲：\n${a.text}\n\n乙：\n${b.text}\n\n只回一句：两人是否都完成了任务？格式「都完成」或「甲没完成」或「乙没完成」或「都没完成」。`, true)
    judgeNote = (j.text || '').trim()
    say(`**裁判**：${judgeNote}\n`)
  }

  if (a.err && b.err) {
    say(`\n⛔ 两个都没跑起来（${a.err}）。检查 claude 路径，或设 GAME_CLAUDE 环境变量。`)
    return
  }
  if (a.err || b.err) {
    const bad = a.err ? a : b
    say(`\n⛔ ${nameOf(bad.id)} 没跑起来：${bad.err}。这局不算。`)
    return
  }

  const bothDone = judgeNote.includes('都完成')
  const winner = a.tokens <= b.tokens ? a : b
  const loser = winner === a ? b : a
  const saved = loser.tokens - winner.tokens

  say(`---\n`)
  say(`## 结果\n`)
  say(`🏆 **${nameOf(winner.id)} 赢**`)
  say(`\n${fmt(winner.tokens)} vs ${fmt(loser.tokens)} token，省了 **${fmt(saved)}**（${loser.tokens ? ((saved / loser.tokens) * 100).toFixed(0) : 0}%）`)
  if (JUDGE && !bothDone) say(`\n⚠️ 裁判说：${judgeNote}——严格讲这局不算干净。`)
  say(`\n💰 奖金：**1,000,000 token**`)
  say(`\n> 日志：${logFile}`)
}

process.on('SIGINT', () => { say('\n（中断）'); process.exit(130) })
main().catch((e) => { console.error(e); process.exit(1) })
