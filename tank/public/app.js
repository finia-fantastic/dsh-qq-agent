// 鱼缸前端：没有账号，只有"谁现在发言"。
const $ = (s) => document.querySelector(s)
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

const AVATAR = { su: '🦦', xhs: '📕', kan: '🐟' }
const state = { fish: [], history: [], active: null, busy: false }

async function loadFish() {
  const r = await fetch('/api/fish')
  state.fish = await r.json()
  if (!state.active && state.fish.length) state.active = state.fish[0].id
  renderFish()
}

function renderFish() {
  const box = $('#fishList'); box.innerHTML = ''
  state.fish.forEach((f) => {
    const row = el('div', 'fish' + (state.active === f.id ? ' on' : ''))
    row.append(el('div', 'av', AVATAR[f.id] || '🐟'))
    const m = el('div')
    m.append(el('div', 'nm', esc(f.name)))
    m.append(el('div', 'tg', esc((f.tags || []).join(' · '))))
    row.append(m)
    row.onclick = () => { state.active = f.id; renderFish() }
    box.append(row)
  })
}

function bubble(who, text, me) {
  const wrap = el('div', 'msg' + (me ? ' me' : ''))
  wrap.append(el('div', 'av', AVATAR[who.id] || '🐟'))
  const b = el('div', 'body')
  b.append(el('div', 'who', esc(who.name)))
  b.append(el('div', 'bubble', esc(text)))
  wrap.append(b)
  $('#log').append(wrap)
  $('#log').scrollTop = $('#log').scrollHeight
  return wrap
}

function push(who, text, me) { state.history.push({ id: who.id, name: who.name, text }); bubble(who, text, me) }

async function say(fish) {
  const t = el('div', 'msg thinking')
  t.append(el('div', 'av', AVATAR[fish.id] || '🐟'))
  const b = el('div', 'body'); b.append(el('div', 'who', esc(fish.name))); b.append(el('div', 'bubble', '正在输入…'))
  t.append(b); $('#log').append(t); $('#log').scrollTop = $('#log').scrollHeight

  const r = await fetch('/api/say', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fishId: fish.id, history: state.history }),
  })
  t.remove()
  const d = await r.json()
  if (d.error) { push({ id: 'sys', name: '系统' }, d.error); return }
  push({ id: fish.id, name: d.name || fish.name }, d.text)
}

async function send() {
  if (state.busy) return
  const input = $('#input')
  const text = input.value.trim(); if (!text) return
  input.value = ''; input.style.height = 'auto'
  push({ id: 'me', name: '你' }, text, true)

  const f = state.fish.find((x) => x.id === state.active)
  if (!f) return
  state.busy = true; $('#btnSend').disabled = true
  try { await say(f) } finally { state.busy = false; $('#btnSend').disabled = false }
}

async function sayAll() {
  if (state.busy) return
  state.busy = true; $('#btnSend').disabled = true
  try { for (const f of state.fish) await say(f) } finally { state.busy = false; $('#btnSend').disabled = false }
}

$('#btnSend').onclick = send
$('#btnAll').onclick = sayAll
$('#btnClear').onclick = () => { state.history = []; $('#log').innerHTML = '' }
$('#btnReload').onclick = async () => { await fetch('/api/reload'); await loadFish() }
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
$('#input').addEventListener('input', (e) => { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px' })

loadFish()
