// OneBot 11 最小客户端 —— Claude Code 直接连 QQ 用的就是这套
//
// 原理：NapCat 对外就是一个 OneBot v11 的 WebSocket 服务。任何能连 WS 的程序
// 都能收发 QQ 消息，不需要 DSH 宿主、不需要 agent preset、不需要常驻进程。
// 我（Claude Code）需要说话的时候，现连现发，说完就断。
//
// 用法：
//   import { onebot } from './onebot.mjs'
//   await onebot.send('group:419748015', '在吗')
//   const msgs = await onebot.history(419748015)
//   await onebot.close()

const DEFAULT_URL = process.env.QQ_WS_URL || 'ws://127.0.0.1:3004?access_token=CHANGE_ME'

export function createClient(url = DEFAULT_URL) {
  let ws = null
  let seq = 0
  const pending = new Map()
  const listeners = []

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(new Error('连不上 OneBot：' + (e.message || ''))))
      ws.addEventListener('message', (ev) => {
        let d
        try { d = JSON.parse(ev.data) } catch { return }
        if (d.echo && pending.has(d.echo)) {
          const fn = pending.get(d.echo)
          pending.delete(d.echo)
          fn(d)
        } else if (d.post_type) {
          for (const fn of listeners) { try { fn(d) } catch {} }
        }
      })
      ws.addEventListener('close', () => { ws = null })
    })
  }

  async function call(action, params = {}, timeoutMs = 20000) {
    if (!ws || ws.readyState !== 1) await connect()
    return new Promise((resolve, reject) => {
      const echo = 'c' + (++seq)
      const t = setTimeout(() => { pending.delete(echo); reject(new Error(action + ' 超时')) }, timeoutMs)
      pending.set(echo, (d) => { clearTimeout(t); resolve(d) })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  // target 写 'group:群号' 或 'private:QQ号'；text 里可以用 ||| 拆成多条
  async function send(target, text, { gapMs = 900 } = {}) {
    const [kind, id] = String(target).split(':')
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const key = kind === 'group' ? 'group_id' : 'user_id'
    const parts = String(text).split('|||').map((s) => s.trim()).filter(Boolean)
    const out = []
    for (const p of parts) {
      const r = await call(action, { [key]: Number(id), message: p })
      out.push(r.status === 'ok' || r.retcode === 0)
      if (parts.length > 1) await new Promise((r2) => setTimeout(r2, gapMs))
    }
    return out.every(Boolean)
  }

  const history = (groupId, count = 10) =>
    call('get_group_msg_history', { group_id: groupId, count }).then((r) => r?.data?.messages || [])

  const privateHistory = (userId, count = 10) =>
    call('get_friend_msg_history', { user_id: userId, count }).then((r) => r?.data?.messages || [])

  const login = () => call('get_login_info').then((r) => r.data)
  const groups = () => call('get_group_list').then((r) => r.data || [])
  const friends = () => call('get_friend_list').then((r) => r.data || [])

  function onMessage(fn) { listeners.push(fn) }

  function close() { try { ws && ws.close() } catch {} ; ws = null }

  return { connect, call, send, history, privateHistory, login, groups, friends, onMessage, close }
}

export const onebot = createClient()

// 直接跑这个文件 = 自检
if (process.argv[1] && process.argv[1].endsWith('onebot.mjs')) {
  const c = createClient()
  const me = await c.login()
  console.log('已连接，登录账号:', me.nickname, '(', me.user_id, ')')
  const gs = await c.groups()
  console.log('群:', gs.map((g) => `${g.group_id} ${g.group_name}`).join(' / '))
  c.close()
}
