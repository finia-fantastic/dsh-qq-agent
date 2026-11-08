// 鱼群 · Fish Arena —— 纯静态，没有后端。
// key 只存在本机 localStorage，直接向接口发请求，不经过任何服务器。
// 没填 key 也能打开：走「演示模式」，回复是本地假台词，用来先看界面和节奏。

const LS = {
  cfg: 'fish.cfg', fish: 'fish.custom', msgs: 'fish.msgs',
  room: 'fish.room', part: 'fish.participants',
}

const $ = (s) => document.querySelector(s)
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

const DEFAULTS = {
  base: 'https://api.anthropic.com',
  model: 'claude-sonnet-5-5',
  key: '',
  burst: 2,          // 每轮最多几条鱼接话
  maxTurns: 40,      // 一个会话最多多少轮，防跑飞
}

const state = {
  cfg: load(LS.cfg, DEFAULTS),
  roster: [],        // 全部角色（含自定义）
  participants: new Set(load(LS.part, null) || []),   // 群聊里谁参加
  msgs: load(LS.msgs, {}),                            // { roomId: [{who,text,me,sys}] }
  room: load(LS.room, 'group'),
  turn: 0,
  busy: false,
}

function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d } catch { return d } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

// ── 角色 ──────────────────────────────────────────
async function loadRoster() {
  let base = []
  try { base = await (await fetch('roster.json', { cache: 'no-cache' })).json() } catch {}
  const custom = load(LS.fish, []) || []
  state.roster = [...base, ...custom]
  if (!state.participants.size) {
    // 默认全体参加（主持人除外）
    state.roster.filter((f) => !f.host).forEach((f) => state.participants.add(f.id))
    save(LS.part, [...state.participants])
  }
}

const byId = (id) => state.roster.find((f) => f.id === id)
const roomMsgs = (r) => (state.msgs[r] ||= [])

// ── 渲染 ──────────────────────────────────────────
function renderFishList() {
  const box = $('#fishList'); box.innerHTML = ''
  const q = ($('#search').value || '').trim()
  state.roster.filter((f) => !f.host).filter((f) => !q || f.name.includes(q) || (f.tags || []).join().includes(q))
    .forEach((f) => {
      const last = roomMsgs(f.id).slice(-1)[0]
      const row = el('div', 'room' + (state.room === f.id ? ' active' : ''))
      row.dataset.room = f.id
      row.append(el('span', 'avatar', f.avatar || '🐟'))
      const main = el('div', 'room-main')
      main.append(el('div', 'room-name', esc(f.name)))
      main.append(el('div', 'room-last', esc(last ? (last.me ? '你：' : '') + last.text.slice(0, 26) : (f.tags || []).join(' · '))))
      row.append(main)
      row.onclick = () => switchRoom(f.id)
      box.append(row)
    })
}

function renderMessages() {
  const box = $('#messages'); box.innerHTML = ''
  roomMsgs(state.room).forEach((m) => box.append(bubbleOf(m)))
  box.scrollTop = box.scrollHeight
}

function bubbleOf(m) {
  if (m.sys) return el('div', 'msg sys', `<div class="bubble">${esc(m.text)}</div>`)
  const f = m.me ? { name: state.cfg.meName || '你', avatar: '🧑' } : (byId(m.who) || { name: m.who || '？', avatar: '🐟' })
  const wrap = el('div', 'msg' + (m.me ? ' me' : ''))
  wrap.append(el('span', 'avatar', f.avatar || '🐟'))
  const body = el('div', 'body')
  body.append(el('div', 'who', esc(f.name)))
  body.append(el('div', 'bubble', esc(m.text)))
  wrap.append(body)
  return wrap
}

function typing(who) {
  const f = byId(who) || { name: who, avatar: '🐟' }
  const wrap = el('div', 'msg typing')
  wrap.dataset.typing = who
  wrap.append(el('span', 'avatar', f.avatar || '🐟'))
  const body = el('div', 'body')
  body.append(el('div', 'who', esc(f.name)))
  body.append(el('div', 'bubble', '正在输入…'))
  wrap.append(body)
  $('#messages').append(wrap)
  $('#messages').scrollTop = $('#messages').scrollHeight
}
const untype = (who) => document.querySelectorAll(`[data-typing="${who}"]`).forEach((n) => n.remove())

function switchRoom(id) {
  state.room = id; save(LS.room, id)
  const f = byId(id)
  $('#chatTitle').textContent = f ? f.name : '鱼缸'
  $('#chatSub').textContent = f ? '单聊 · 只有你们两条鱼' : `群聊 · ${state.participants.size} 条鱼`
  document.querySelectorAll('.room').forEach((n) => n.classList.toggle('active', n.dataset.room === id))
  renderMessages(); renderFishList()
}

// ── 说话 ──────────────────────────────────────────
function push(room, m) {
  roomMsgs(room).push(m); save(LS.msgs, state.msgs)
  if (state.room === room) { $('#messages').append(bubbleOf(m)); $('#messages').scrollTop = $('#messages').scrollHeight }
}

async function send() {
  const input = $('#input')
  const text = input.value.trim()
  if (!text || state.busy) return
  if (state.turn >= state.cfg.maxTurns) {
    push(state.room, { sys: true, text: `到 ${state.cfg.maxTurns} 轮上限了，清空会话可以重来。` })
    return
  }
  input.value = ''; input.style.height = 'auto'
  push(state.room, { me: true, text })
  state.turn++

  const speakers = pickSpeakers()
  if (!speakers.length) { push(state.room, { sys: true, text: '这个会话里没有鱼，去「👥」里勾几条。' }); return }

  state.busy = true; $('#btnSend').disabled = true
  try {
    for (const f of speakers) {
      typing(f.id)
      const reply = await speak(f)
      untype(f.id)
      push(state.room, { who: f.id, text: reply })
      state.turn++
      if (state.turn >= state.cfg.maxTurns) break
    }
  } catch (e) {
    push(state.room, { sys: true, text: '出错了：' + (e.message || e) })
  } finally {
    state.busy = false; $('#btnSend').disabled = false
  }
}

// 谁接话：群聊里按轮转，避免总是同几条抢话
let cursor = 0
function pickSpeakers() {
  if (state.room !== 'group') { const f = byId(state.room); return f ? [f] : [] }
  const pool = state.roster.filter((f) => !f.host && state.participants.has(f.id))
  if (!pool.length) return []
  const n = Math.min(state.cfg.burst, pool.length)
  const out = []
  for (let i = 0; i < n; i++) out.push(pool[(cursor + i) % pool.length])
  cursor = (cursor + n) % pool.length
  return out
}

// ── 调模型 ────────────────────────────────────────
async function speak(fish) {
  const cfg = state.cfg
  const history = roomMsgs(state.room).slice(-14)
    .map((m) => `${m.me ? (cfg.meName || '你') : (byId(m.who)?.name || m.who)}：${m.text}`).join('\n')

  if (!cfg.key) return demoLine(fish)

  const system = `${fish.persona}\n\n你在一个 QQ 群式的聊天室里。一次只说一到两句，不要写 Markdown，不要总结，不要复述别人的话。`
  const prompt = `最近的对话：\n${history}\n\n现在轮到你说话。只回你要说的内容，不要加名字前缀。`

  const body = {
    model: cfg.model,
    max_tokens: 400,
    system,
    messages: [{ role: 'user', content: prompt }],
  }
  const r = await fetch(cfg.base.replace(/\/$/, '') + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`)
  const d = await r.json()
  const txt = (d.content || []).map((c) => c.text || '').join('').trim()
  return txt || '（没说话）'
}

// 演示模式：没填 key 时的假台词，只为看清界面和节奏
const DEMO = {
  ache: ['你信我，我们就都活；你不信，我也活。', '我先说，但我说的是事实，不是话。'],
  paopao: ['我我我知道一件事！真的真的。', '他昨天说他不投，结果他投了。'],
  tietou: ['有什么好想的，来啊。', '别看我，我没什么好说的。'],
  xiaoman: ['那个…我都可以，你们先说。', '我不是不投，我是怕投错。'],
  ageng: ['我哪错了？你倒是说清楚。', '我没错，我只是没说全。'],
  laoxian: ['随便吧。', '急什么，又不会少块肉。'],
  tangtang: ['对不起，是不是我拖累大家了。', '你们别生气，我投谁都可以。'],
  ahuang: ['你猜我刚说的那句是真的吗？', '我从不骗人，我只是没说完。'],
  host: ['规则很简单：这一轮，只活一个。'],
}
function demoLine(fish) {
  const pool = DEMO[fish.id] || ['……']
  return pool[Math.floor(Math.random() * pool.length)] + '\n（演示模式：填了 key 才会真的回话）'
}

// ── 界面事件 ──────────────────────────────────────
function openCfg() {
  $('#cfgBase').value = state.cfg.base
  $('#cfgModel').value = state.cfg.model
  $('#cfgKey').value = state.cfg.key
  $('#cfgBurst').value = state.cfg.burst
  $('#dlgSettings').showModal()
}

function saveCfg() {
  state.cfg = {
    ...state.cfg,
    base: $('#cfgBase').value.trim() || DEFAULTS.base,
    model: $('#cfgModel').value.trim() || DEFAULTS.model,
    key: $('#cfgKey').value.trim(),
    burst: Math.max(1, Math.min(6, Number($('#cfgBurst').value) || 2)),
  }
  save(LS.cfg, state.cfg)
  $('#connState').textContent = state.cfg.key ? '已连接（自带 key）' : '演示模式（未填 key）'
}

function openRoster() {
  const box = $('#rosterList'); box.innerHTML = ''
  state.roster.filter((f) => !f.host).forEach((f) => {
    const lab = el('label')
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.participants.has(f.id)
    cb.onchange = () => {
      cb.checked ? state.participants.add(f.id) : state.participants.delete(f.id)
      save(LS.part, [...state.participants]); switchRoom(state.room)
    }
    lab.append(cb, el('span', 'avatar', f.avatar || '🐟'), el('span', '', esc(f.name)))
    box.append(lab)
  })
  $('#dlgRoster').showModal()
}

function openAdd() {
  $('#addName').value = ''; $('#addAvatar').value = '🐟'; $('#addPersona').value = ''
  $('#dlgAdd').showModal()
}

function saveFish() {
  const name = $('#addName').value.trim()
  const persona = $('#addPersona').value.trim()
  if (!name || !persona) return
  const id = 'c' + Date.now().toString(36)
  const custom = load(LS.fish, []) || []
  custom.push({ id, name, avatar: $('#addAvatar').value.trim() || '🐟', tags: ['自定义'], persona })
  save(LS.fish, custom)
  state.roster.push(custom[custom.length - 1])
  state.participants.add(id); save(LS.part, [...state.participants])
  renderFishList(); switchRoom(state.room)
}

function exportRoster() {
  const all = state.roster.map(({ id, name, avatar, tags, persona, host }) => ({ id, name, avatar, tags, persona, ...(host ? { host } : {}) }))
  const blob = new Blob([JSON.stringify(all, null, 1)], { type: 'application/json' })
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'roster.json'; a.click()
}

function init() {
  $('#connState').textContent = state.cfg.key ? '已连接（自带 key）' : '演示模式（未填 key）'
  $('#btnSettings').onclick = openCfg
  $('#btnSaveCfg').onclick = saveCfg
  $('#btnRoster').onclick = openRoster
  $('#btnCloseRoster').onclick = () => $('#dlgRoster').close()
  $('#btnExportRoster').onclick = exportRoster
  $('#btnAddFish').onclick = openAdd
  $('#btnCancelAdd').onclick = () => $('#dlgAdd').close()
  $('#btnSaveFish').onclick = saveFish
  $('#btnClear').onclick = () => {
    if (!confirm('清空这个会话？')) return
    state.msgs[state.room] = []; state.turn = 0; save(LS.msgs, state.msgs); renderMessages()
  }
  $('#btnSend').onclick = send
  $('#search').oninput = renderFishList
  $('#roomGroup').onclick = () => switchRoom('group')
  const input = $('#input')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px' })

  loadRoster().then(() => {
    renderFishList(); switchRoom(state.room)
    if (!roomMsgs(state.room).length) {
      push(state.room, { sys: true, text: '鱼缸开张了。说句话，让鱼接。' })
    }
  })
}

init()
