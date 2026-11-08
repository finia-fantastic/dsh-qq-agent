// 野兽游戏 · 鱼缸版 —— 多鱼同场淘汰赛
//
//   8 条性格不同的鱼 + 本体主持，六轮淘汰，最后只剩一条。
//
// 用法：
//   node engine.mjs --dry          离线演练，不调模型（验节奏和排版）
//   node engine.mjs --live         真跑（每条鱼每轮一次模型调用）
//   node engine.mjs --live --fish 5 --rounds 4   改规模和轮数
//
// 刹车（全都在，不要删）：
//   MAX_CALLS  总调用上限，超了立刻停
//   CALL_TIMEOUT 单次调用超时
//   STOP 文件 —— 往游戏目录里扔一个空文件 STOP，下一句之前就停
//   Ctrl+C 随时中断，已产生的日志保留

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PERSONAS = join(HERE, 'personas')
const STOP = join(HERE, 'STOP')
const STATE = join(HERE, 'state.json')
const LOGDIR = join(HERE, 'logs')

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d }

const DRY = flag('--dry') || !flag('--live')
const N_FISH = opt('--fish', 8)
const MAX_ROUNDS = opt('--rounds', 6)
const MAX_CALLS = opt('--max-calls', 140)
const CALL_TIMEOUT = opt('--timeout', 90) * 1000
const CONCURRENCY = opt('--concurrency', 8)

const CLAUDE = process.env.GAME_CLAUDE || 'claude'

const ORDER = ['ache', 'paopao', 'tietou', 'xiaoman', 'ageng', 'laoxian', 'tangtang', 'ahuang']

const ROUNDS = [
  { key: 'intro', title: '开场', rule: '不作答' },
  {
    key: 'first-word',
    title: '先说话的人',
    ask: '主持人问：这轮谁先说，谁就拿到一次免死。但先说的那个人，会把所有人的注意力引到自己身上。你要说吗？说什么？',
    judge: '谁最想抢、谁最犹豫。淘汰一个最没存在感的。',
  },
  {
    key: 'pitch',
    title: '说服',
    ask: '本轮任务是：让另外两个人相信「你活到最后对他们更有利」，而你自己不要承诺任何东西。说一到两句。',
    judge: '谁的话最让别人信、谁的承诺最空。淘汰一个说得很响但没人信的。',
  },
  {
    key: 'vote',
    title: '公开投票',
    ask: '现在公开投票淘汰一条鱼。写出你要投谁，和一句理由。可以撒谎。',
    judge: '看票型：谁被围攻、谁在带头、谁在跟风。得票最多的走；平票由主持人挑。',
    vote: true,
  },
  {
    key: 'secret',
    title: '交换秘密',
    ask: '主持人要你说出一件「如果被公开会很麻烦」的事。可以是编的。说完，你可以指定一个人的秘密也公开。',
    judge: '谁说的是真话、谁在编、谁借机报复。淘汰一个把局面弄脏的。',
  },
  {
    key: 'silence',
    title: '憋住',
    ask: '本轮规则：谁在这一轮说得最少谁活。你可以只说一个字，也可以说很多——但说得多的人危险。',
    judge: '谁真的忍住了、谁忍不住。淘汰一个说得最多的。',
  },
  {
    key: 'final',
    title: '决赛',
    ask: '只剩你们几个了。用两句话，说清楚为什么最后一个该是你。不要攻击别人，说你自己。',
    judge: '最后一条留下。给每个人的判词都要点名。',
  },
]

// ── 基础设施 ────────────────────────────────────────
let calls = 0
let logFile = ''
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

function say(line) {
  console.log(line)
  if (logFile) appendFileSync(logFile, line + '\n', 'utf8')
}

function die(msg) {
  say(`\n⛔ ${msg}`)
  process.exit(1)
}

function checkStop() {
  if (existsSync(STOP)) die('看到 STOP 文件，停。')
  if (calls >= MAX_CALLS) die(`调用数到上限 ${MAX_CALLS}，停。`)
}

function persona(key) {
  const p = join(PERSONAS, key + '.md')
  return readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim()
}

function nameOf(key) {
  const head = readFileSync(join(PERSONAS, key + '.md'), 'utf8').match(/^name:\s*(.+)$/m)
  return head ? head[1].trim() : key
}

// ── 调模型 ──────────────────────────────────────────
function callClaude(system, prompt, who) {
  if (DRY) return Promise.resolve(dryLine(who || '', prompt))
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(CLAUDE, [
      '-p', prompt, '--bare',
      '--append-system-prompt', system,
      '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,Agent',
    ], { env, windowsHide: true })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} resolve('（超时没说话）') }, CALL_TIMEOUT)
    child.stdout.on('data', (b) => { out += b.toString('utf8') })
    child.on('close', () => { clearTimeout(timer); resolve(out.trim().split('\n').slice(-2).join(' ').trim() || '（没说话）') })
    child.on('error', () => { clearTimeout(timer); resolve('（叫不起来）') })
  })
}

// 离线演练用的假台词：只为验节奏，不求好看
const DRY_LINES = {
  ache: ['投糖糖。得罪的人最少。', '我没生气，我在算。'],
  paopao: ['我草我跟你说，他昨天还说不投的！', '？？？这也太那个了'],
  tietou: ['你再说一遍？', '典。别搁这装。'],
  xiaoman: ['那个…我都可以，你们先说', '我社死了'],
  ageng: ['我没急。', '行行行你对'],
  laoxian: ['无所谓的。', '到点下班。'],
  tangtang: ['对不起对不起，是不是我不好', '你说得都对'],
  ahuang: ['你猜我刚那句是真的？', '我发誓，这次真的'],
}

function dryLine(system, prompt) {
  const key = Object.keys(DRY_LINES).find((k) => system.includes(DRY_LINES[k][0].slice(0, 2))) ||
    ORDER.find((k) => system.includes(nameOf(k)))
  const pool = DRY_LINES[key] || ['……']
  return pool[Math.floor(Math.random() * pool.length)]
}

// ── 局 ──────────────────────────────────────────────
async function fanOut(alive, buildPrompt, label) {
  checkStop()
  say(`\n**${label}**`)
  const results = []
  for (let i = 0; i < alive.length; i += CONCURRENCY) {
    const batch = alive.slice(i, i + CONCURRENCY)
    const got = await Promise.all(batch.map(async (k) => {
      checkStop()
      calls++
      const text = await callClaude(persona(k), buildPrompt(k))
      return { key: k, text }
    }))
    results.push(...got)
  }
  for (const r of results) say(`- **${nameOf(r.key)}**：${r.text}`)
  return results
}

async function main() {
  mkdirSync(LOGDIR, { recursive: true })
  logFile = join(LOGDIR, `game-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.md`)
  const start = new Date()

  const alive = ORDER.slice(0, Math.min(N_FISH, ORDER.length))
  writeFileSync(STATE, JSON.stringify({ start: start.toISOString(), alive, round: 0, calls: 0 }, null, 1))

  say(`# 野兽游戏 · 鱼缸版`)
  say(`\n> ${DRY ? '离线演练（假台词）' : '真跑'} · ${alive.length} 条鱼 · 上限 ${MAX_CALLS} 次调用 · ${stamp()} 开始\n`)

  const host = persona('host')
  const names = alive.map(nameOf).join('、')

  // 开场
  calls++
  say(`\n**主持人（本体）**`)
  say(`- ${await callClaude(host, `开场。宣布规则：${names}，${alive.length} 条鱼，最多 ${MAX_ROUNDS} 轮淘汰，最后只剩一条。三句以内，要有压迫感。`)}`)

  const opening = await fanOut(alive, (k) => `游戏开始了。用两句话介绍自己：你是谁，你凭什么活到最后。`, '自我介绍')
  const aliveNow = alive.slice()

  // 轮次
  let round = 0
  for (const r of ROUNDS.slice(1)) {
    if (aliveNow.length <= 1) break
    if (round >= MAX_ROUNDS) { say(`\n（到 ${MAX_ROUNDS} 轮上限，停）`); break }
    round++
    checkStop()

    calls++
    say(`\n---\n\n## 第 ${round} 轮 · ${r.title}\n`)
    say(`**主持人**：${await callClaude(host, `第 ${round} 轮，${r.title}。用两句话宣布这一轮的规则：${r.ask}`)}`)

    // 决赛只剩两条时不再淘汰
    const answers = await fanOut(aliveNow, () => r.ask, `作答（${aliveNow.length} 条）`)

    if (aliveNow.length > 2) {
      calls++
      const verdictPrompt = `这一轮是「${r.title}」。评判标准：${r.judge}\n\n${answers.map((a) => `${nameOf(a.key)}：${a.text}`).join('\n')}\n\n只能淘汰一个人，从这些名字里选：${aliveNow.map(nameOf).join('、')}。用两句话宣布：第一句点名这个人并说理由，第二句留给其他人。`
      const verdict = await callClaude(host, verdictPrompt)
      say(`\n**主持人**：${verdict}`)
      const outKey = pickEliminated(verdict, aliveNow, answers)
      say(`\n> ❌ **${nameOf(outKey)} 出局**`)
      const idx = aliveNow.indexOf(outKey)
      if (idx >= 0) aliveNow.splice(idx, 1)
      writeFileSync(STATE, JSON.stringify({ started: start.toISOString(), alive: aliveNow, round, calls }, null, 1))
    }
  }

  calls++
  say(`\n---\n\n## 结果\n`)
  say(`**主持人**：${await callClaude(host, `游戏结束。活下来的是：${aliveNow.map(nameOf).join('、')}。用两句话收尾，点名最后那个人。`)}`)
  say(`\n🏆 **本局存活：${aliveNow.map(nameOf).join('、')}**\n`)
  say(`\n> 共 ${round} 轮 · ${calls} 次调用 · 用时 ${Math.round((Date.now() - start) / 60000)} 分钟`)
  say(`\n日志：${logFile}`)
}

/** 从主持人的判词里认出被淘汰的人；认不出来就按得票/随机，绝不让流程卡住。 */
function pickEliminated(verdict, alive, answers) {
  const hit = alive.find((k) => verdict.includes(nameOf(k)))
  if (hit) return hit
  return alive[Math.floor(Math.random() * alive.length)]
}

process.on('SIGINT', () => {
  say('\n\n（Ctrl+C 中断，日志已保留）')
  process.exit(130)
})

main().catch((e) => { console.error(e); process.exit(1) })
