# QQ ⇄ AI Agent 桥

在 QQ 里给 AI 派活，让它真的干活——改代码、跑命令、收发文件。

这个仓库是两件事拼起来的，缺一件都不完整：

1. **`bridge/`** —— 一个自写的 OneBot v11 桥。它把 QQ 消息喂给本机的 `claude`（Claude Code 的无头模式），
   把回答发回去。**权限放开后，被唤醒的 agent 有读写文件和执行命令的能力**，不只是聊天。
2. **`patches/`** —— 给 [dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq)（MIT）打的两个补丁，
   让跑在 DSH 里的另一个 QQ 机器人也能**把收到的文件存到本机**、并给白名单用户开满权限。

一句话：**Claude Code 和一个 DSH 实例，都能通过 QQ 收文件、干活。**

另外附了一份 [给 AI 加人格的写法](docs/persona.md)（含示例 `personas/example.md`）——
人格是决定它像人还是像客服的那一半，权限只是另一半。

> 🌐 **网页版**：`docs/` 下是一个纯静态的 QQ 风格聊天室，挂在 GitHub Pages 上，
> 谁的浏览器打开都能用，也能自己加鱼。见 [网页版](#网页版鱼缸) 一节。

---

## 它解决什么问题

在 QQ 上跟 AI 说话很容易，但绝大多数方案只能聊天：

- 官方机器人插件（AppID/AppSecret 那类）能驱动完整 agent，但**绑的是一个新的机器人号**，不是你的号；
- 能接个人号的插件，大多只做「收发消息 + 存档」，收到消息**不会有人去干活**；
- 而 Claude Code 的官方 Remote Control 只对 claude.ai 订阅开放，走第三方中转的用不了。

所以这里是自己拼的一套：**个人号 + OneBot + 无头 CLI + 放开工具权限**。

---

## 架构

```
你的手机 QQ
     │  OneBot v11 (WS)
     ▼
 NapCat / Lagrange / LLOneBot  ── 注入真实 QQ 客户端
     │  ws://127.0.0.1:3004?access_token=…
     ▼
 bridge2.mjs ── 常驻会话（一个 claude 进程吃到底，不每条消息起一个）
     │  stdin / stdout (stream-json)
     ▼
 claude -p --input-format stream-json --output-format stream-json
     │  --allowedTools Read,Grep,Glob,Write,Edit,Bash,…
     ▼
 你的电脑：改代码 / 跑命令 / 读文件 / 发文件回 QQ
```

另一条线（`patches/`）：

```
QQ 私聊 ── OneBot ──> DSH + dsh-aurabot-qq ──> aurabot-private 预设
                                                  ├─ dsh-tool-pwsh  (PowerShell)
                                                  ├─ dsh-tool-fs    (读写文件)
                                                  └─ qq_save_file   (收文件/压缩包，补丁加的)
```

---

## 快速开始（桥）

### 0. 前提

- Node ≥ 20
- 一个 OneBot v11 实现（Windows 上常用 [NapCat](https://github.com/NapNeko/NapCatQQ)），已登录你的 QQ
- 本机有可用的 `claude` 命令（`npm i -g @anthropic-ai/claude-code`；
  Windows 上如果报 `native binary not installed`，还要装平台包
  `npm i -g @anthropic-ai/claude-code-win32-x64` 再跑一次它自带的 `install.cjs`）

### 1. 配置

```bash
cd bridge
cp bridge.config.example.json bridge.config.json
# 填：wsUrl / me（机器人号）/ owner（你的号）/ peers（同事号）
```

`wsUrl` 里的 `access_token` 要和 NapCat 里那个 OneBot WS 服务器的 token 一致。

### 2. 跑

```bash
node bridge2.mjs
```

它会连上 NapCat，收到消息后在本地拉起一个常驻 `claude` 会话。

### 3. 说话

- **私聊**：直接说
- **群里**：只有 @ 它、或消息里带 `wakeNames` 里的词才会接——不然就是插话

### 4. 保活（可选）

```bash
pythonw watchdog.py
```

看门狗只盯端口，规矩写在文件头：**连续失败 3 次就停手、退避 30 分钟、永不 taskkill**。
`QQ_NAP_BAT` / `QQ_NAP_CWD` 环境变量指向 NapCat 的启动脚本；不配就只盯桥、不碰 QQ。

---

## 补丁（给 DSH 的 aurabot）

```bash
git clone https://github.com/aureth-labs/dsh-aurabot-qq
cd dsh-aurabot-qq
git apply /path/to/patches/aurabot-save-file.patch        # 新增 qq_save_file 工具
git apply /path/to/patches/aurabot-two-tier-access.patch  # 权限收成两档
```

**`aurabot-save-file.patch`** 加了一个工具 `qq_save_file`：

| 之前的 `qq_read_file` | 新增的 `qq_save_file` |
|---|---|
| 只认文本（txt/md/json/代码），2MB | 任何类型，200MB |
| 只读进上下文，不落盘 | 存到本地并返回路径 |
| zip/7z/rar 一律「读不了」 | 压缩包顺手列出内容清单 |

**`aurabot-two-tier-access.patch`**：把权限收成**两档**，面板上只有两个选项：

| 档位 | 面板上叫什么 | 能干什么 |
|---|---|---|
| `full` | **能指挥干活** | 查文件、跑命令、改代码、收发文件（PowerShell + fs + web） |
| `social` | **只能聊天** | 只有发表情、发说说这类 QQ 工具，碰不到电脑 |

原来还有第三档「纯聊天」，已经并进「只能聊天」（老配置里的 `chat` 仍然认，只是面板不再提供）。
主人和私聊白名单**各有一个开关**，可以分别设——白名单给「能指挥干活」等于把这台电脑的命令行交给他们。

---

## 安全边界（这段请务必读）

- **桥里 owner 通道能执行任意命令。** 拿到那个 QQ 号的人 = 拿到这台电脑。请只对可信账号放开，
  并且把 `disallowedTools` 里不需要的东西继续禁掉（默认禁 `Task,Agent`，防止它自己在后台开一堆子 agent）。
- **同事/白名单通道保持只读**（`Read,Grep,Glob`），不能写、不能跑命令。
- **群聊只认 @ 或点名**，不要做「醒着就全接」——那就是刷屏。
- **别反复强杀 QQ 进程**：`taskkill /F` 会破坏本地快速登录凭据，下次必须重扫二维码。
  也不要在同一个号上反复重连 / 反复注入，容易被判异常设备。
- 桥的 `sessions.json` 里存的是 claude 的会话 id，不存密码；但 `bridge.config.json` 里有 OneBot token，
  **别提交进仓库**（`.gitignore` 已经排掉）。

---

## 已知问题 / 没做的

- 只测过 Windows + NapCat；macOS/Linux 上没验证。
- 桥本身不做多号负载，一个进程管一条 OneBot 连接。
- 群文件上传（`upload_group_file`）在某些 NapCat 版本上会超时无回执，没深究。
- 补丁基于 aurabot v1.2.0 的文件结构，上游改版后可能要重做。

---

## License

桥的代码：MIT。
`patches/` 是对 [dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq)（MIT）的修改，遵循其原许可证。

---

## 网页版 · 鱼缸

`docs/` 里是一个**纯静态**的 QQ 风格聊天室，直接由 GitHub Pages 提供，没有后端。

### 怎么用

打开 <https://finia-fantastic.github.io/dsh-qq-agent/>，第一次进：

1. 点右上 **⚙** 填接口地址 / 模型 / API Key
   - **不填也能用**：走演示模式，回复是本地假台词，只为了先看界面和节奏
   - key 只存在你浏览器的 localStorage 里，**不会发往任何服务器**（这个页面压根没有服务器）
   - 想接本机中转：地址填 `http://127.0.0.1:15721`，本机开着就能用
2. 点 **👥** 勾选这一场谁参加
3. 点左侧 **+** 加一条自己的鱼：名字 + 一个 emoji 头像 + 人格正文

### 加一条鱼进仓库（让大家都能用）

页面上「导出全部角色 JSON」，把内容提 PR 到 `docs/roster.json` 即可。

### 刹车

- 「每轮最多几条鱼接话」默认 2，最多 6
- 一个会话最多 40 轮，超了要手动清空
- 🗑 一键清空当前会话

### 安全提醒

- **不要在别人的设备上填 key**，localStorage 是同设备共享的
- 页面是公开的，**不要把自己的 key 写进代码或提交到仓库**
- 直连 Anthropic API 需要 `anthropic-dangerous-direct-browser-access` 头，这是官方给浏览器直连开的口子；不想暴露 key 就走自己的中转

### 它不是什么

- 不是真的 QQ，接不进你的 QQ 号（那要走 `bridge/`）
- 不支持多人在线同房——每个人的浏览器各聊各的，**没有共享房间**
- 要做「大家看到同一个战场」，需要后端（WebSocket/Firestore），那就不是纯静态了

---

## 双人对决 · 最少 token 赢 100 万 token

`game/duel.mjs` —— 两个人做同一件事，**谁花的 token 少谁赢**，奖金一百万 token。

```bash
node game/duel.mjs --dry            # 离线演练
node game/duel.mjs --live --judge   # 真跑 + 裁判判是否都完成
```

计费口径：`input + output + 缓存读写` 全部算进去，**人格也算**——写得越长越贵，这是故意的。

实测一局（任务：写 `is_palindrome`）：

| 选手 | 消耗 | 成本 | 用时 |
|---|---|---|---|
| 阿澈 #406（把每个字都算一遍） | **12,200** token | $0.046 | 30.2s |
| 老咸 #024（能躺着绝不坐着） | **1,194** token | $0.015 | 7.6s |

两人写出来的代码几乎一样，差的全是"想"的成本——阿澈那份还额外重读了 8,832 缓存 token。

**赢：老咸，省 90%。**

---

## 记忆层（2026-11-08 加）

桥原来只有「会话 id」——上下文靠 claude 的 session 延续，没有结构化记忆。现在照 aurabot 那套补上了：

```
聊天留档 → 定时抽事实 → 一条条存（带「关于谁」+ 重要性）→ 回话前召回 top-6 → 旧的压缩
```

| 文件 | 内容 |
|---|---|
| `bridge/memory.mjs` | 整个记忆层，无外部依赖 |
| `memory/memories.json` | 记忆条目 |
| `memory/chatlog/YYYY-MM-DD.jsonl` | 聊天留档，留 7 天 |
| `memory/state.json` | 抽到哪了、什么时候抽的 |

**召回**：中文按「双字组 + 单字」两级取特征打分（只靠双字组，问法一变就全落空——这条是实测踩出来的），再加上「关于这个人」和「越新越容易被想起」两项加权。

**抽事实**：攒够 40 条聊天，后台调一次模型抽最多 8 条稳定事实（偏好、约定、近况），不记寒暄。

调试：

```bash
node bridge/memory.mjs stats        # 有多少条、攒了多少没抽
node bridge/memory.mjs recall 关键词
node bridge/memory.mjs consolidate  # 立刻抽一次
```
