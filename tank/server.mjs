// 鱼缸 —— 不带 QQ 号的聊天室。鱼是文件，不是账号。
//
//   起服务： node server.mjs          → http://127.0.0.1:8890
//   加一条鱼：往 personas/ 里丢一个 .md（DSH 里任何 agent 都能写），刷新页面就出现
//
// 页面：public/index.html
// 接口：
//   GET  /api/fish   列出所有鱼
//   POST /api/say    { fishId, history } → 这条鱼回一句
//   POST /api/reload 重新扫 personas/

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PERSONAS = join(HERE, 'personas')
const PUBLIC = join(HERE, 'public')
const PORT = Number(process.env.FISH_PORT || 8890)
const NO_WINDOW = 0x08000000
const CRLF = new RegExp('\r\n', 'g')

function findClaude() {
  if (process.env.FISH_CLAUDE) return process.env.FISH_CLAUDE
  const cands = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ]
  return cands.find((p) => p && existsSync(p)) || 'claude'
}
const CLAUDE = findClaude()

function loadFish() {
  const out = []
  let files = []
  try { files = readdirSync(PERSONAS).filter((f) => f.endsWith('.md')) } catch { return out }
  for (const f of files) {
    // 有的文件是 CRLF，先归一化，否则头部的 --- 匹配不上（实测 su.md 就栽在这）
    const raw = readFileSync(join(PERSONAS, f), 'utf8').replace(CRLF, '\n')
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    const head = m ? m[1] : ''
    const body = (m ? m[2] : raw).trim()
    const nm = (head.match(/^name:\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, '')
    const tags = (head.match(/^tags:\s*\[(.+)\]$/m) || [])[1] || ''
    out.push({
      id: f.replace(/\.md$/, ''),
      name: nm.trim(),
      tags: tags.split(/[,|]/).map((s) => s.trim()).filter(Boolean),
      persona: body,
    })
  }
  return out
}

function ask(fish, history) {
  const system = fish.persona + '\n\n你在一个聊天室里跟别人说话。一到两句，不要 Markdown，不要旁白，不要解释你在干什么。'
  const prompt = history.map((h) => `${h.name}：${h.text}`).join('\n') + '\n\n现在轮到你说话。只回你要说的那句，不要加名字前缀。'

  if (process.env.FISH_DRY === '1') return Promise.resolve('（演示模式）家人们这波我先复盘一下✨')

  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(CLAUDE, ['-p', prompt, '--bare', '--output-format', 'json',
      '--append-system-prompt', system,
      '--disallowedTools', 'Bash,Write,Edit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent'],
      { env, windowsHide: true, creationflags: NO_WINDOW })
    let out = ''
    const t = setTimeout(() => { try { child.kill() } catch {} ; resolve('（想太久了，没说话）') }, 120000)
    child.stdout.on('data', (b) => { out += b.toString('utf8') })
    child.on('close', () => {
      clearTimeout(t)
      try { resolve((JSON.parse(out).result || '').trim() || '（没说话）') } catch { resolve('（出错了）') }
    })
    child.on('error', (e) => { clearTimeout(t); resolve('（叫不起来：' + e.message + '）') })
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }

  try {
    if (url.pathname === '/api/fish') return send(200, JSON.stringify(loadFish()))

    if (url.pathname === '/api/say' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { fishId, history = [] } = JSON.parse(body || '{}')
      const fish = loadFish().find((f) => f.id === fishId)
      if (!fish) return send(404, JSON.stringify({ error: '没有这条鱼' }))
      const text = await ask(fish, history.slice(-16))
      return send(200, JSON.stringify({ name: fish.name, text }))
    }

    if (url.pathname === '/api/reload') return send(200, JSON.stringify({ ok: true, count: loadFish().length }))

    const p = url.pathname === '/' ? '/index.html' : url.pathname
    const file = join(PUBLIC, p.replace(/\.\./g, ''))
    if (!existsSync(file)) return send(404, 'not found', 'text/plain; charset=utf-8')
    return send(200, readFileSync(file), MIME[extname(file)] || 'application/octet-stream')
  } catch (e) {
    return send(500, JSON.stringify({ error: String(e.message || e) }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const fish = loadFish()
  console.log(`鱼缸 → http://127.0.0.1:${PORT}`)
  console.log(`鱼 ${fish.length} 条：` + fish.map((f) => f.name).join('、'))
  console.log(`claude: ${CLAUDE}`)
})
