# 一条鱼是怎么搭起来的

这份文档是「溯」的完整图纸——她在 QQ 上活着，有自己的性格、记忆、情绪和作息。
照着做，你也能在另一台机器上养一条。**给本体看的，也是给任何想养鱼的人看的。**

---

## 一、整体长什么样

```
手机 QQ ←→ NapCat（挂在真实 QQ 客户端上）←→ OneBot v11 (WS)
                                                    ↑
                                              aurabot 插件
                                                    ↑
                                        DSH（DeepSeek Harness）宿主
                                                    ↑
                                              模型（deepseek-flash）
```

**四层，各自负责一件事：**

| 层 | 管什么 | 挂了会怎样 |
|---|---|---|
| **NapCat** | 让 AI 能收发真实 QQ 消息 | 号掉线，整条链断 |
| **OneBot WS** | 消息管道（JSON） | 端口不通，插件收不到 |
| **DSH** | 宿主：会话、工具、模型、插件 | 插件不工作 |
| **aurabot 插件** | 人格、记忆、情绪、群聊规则 | 变成没性格的问答机器人 |

---

## 二、目录与文件

所有东西都在 `DSH_HOME` 下（本机是 `I:/dsh-home`）：

```
dsh-home/
├─ profiles/su/                  ← profile（相当于一套独立配置）
│   ├─ package.json              ← 依赖：dsh-aurabot-qq
│   └─ cordis.patch.yml          ← 这个 profile 的补丁
└─ plugins-data/aurabot/         ← 插件的数据目录
    ├─ config.json               ← 全部设置（人格选谁、权限、群规则）
    ├─ personas/su.md            ← 人格卡（源头在插件仓库 personas/，首次启动复制过来）
    ├─ memory.sqlite             ← 记忆（items / gists / kv）
    ├─ chatlog/                  ← 聊天留档，默认留 7 天
    ├─ mood.json                 ← 情绪状态
    ├─ diary.json                ← 她的日记
    ├─ recall-log.json           ← 每次召回用了哪几条、为什么
    └─ logs/aurabot-YYYY-MM-DD.log  ← 运行日志（排错先看这个）
```

⚠️ **人格有两份**：插件自带 `personas/su.md` 和数据目录里的同名文件。
**首次启动会复制过去，之后以数据目录里的为准。改一份记得同步另一份。**

---

## 三、人格卡

写法见仓库根目录的 [docs/persona.md](../docs/persona.md)。简单说四条：

1. **别写标签**（「温柔」「毒舌」会触发刻板模板）
2. 用**矛盾轴**：「信一切该被计算，但真正怕被落下」
3. 给**说话样本**，不给形容词
4. 末尾放一张**不超过 6 条的说话前自检**

溯的卡：`personas/su.md`（水獭，话密、记性挑食、不会安慰人）。

---

## 四、记忆怎么工作

| 表 | 存什么 | 本机现状 |
|---|---|---|
| `items` | 一条条事实（文本 + 关于谁 + 重要性 0~1） | 53 条 |
| `gists` | 压缩过的长期摘要 | 0 条（⚠️ 压缩这层没跑起来） |
| `kv` | 运行状态：短期窗、关系三元组、抽到哪了 | 13 项 |

**流程：**

```
聊天 → 留档 7 天
   ↓ 每天 04:00 / 16:00 各抽一次
items（importance 0.4~0.6）
   ↓ 超过 14 天
gist（压缩）
   ↓ 回话前
召回 top-6（词面打分 + 「关于这个人」加权）
```

**召回的触发**：配置里有一组词——「上次 / 上回 / 之前 / 还记得 / 答应 / 约好」。
说了这些词，她才会去翻记忆。

**调试：** `recall-log.json` 里每次都能看到命中了哪几条、为什么命中。

---

## 五、群聊闸门（这组参数决定她像不像"活的"）

```json
{
  "wakeWords": ["溯", "小鱼"],
  "interjectChance": 0.15,
  "cooldownSec": 90,
  "maxPerHour": 6,
  "quietHours": [1, 8],
  "minRecentMessages": 3,
  "activeWindowSec": 300,
  "interests": ["白米饭", "米饭", "好吃", "饿了"]
}
```

| 参数 | 意思 | 调这个会怎样 |
|---|---|---|
| `wakeWords` | 只有叫这些词才理 | 少了 → 没人能叫动她 |
| `interjectChance` | 主动插话的概率 | 调高 → 话痨；调低 → 木头 |
| `cooldownSec` | 两次发言最小间隔 | 太小会刷屏 |
| `maxPerHour` | 每小时上限 | **这是最容易卡死比赛/直播的参数** |
| `quietHours` | 几点到几点闭嘴 | 凌晨 1 点到早 8 点 |
| `interests` | 看到这些词更容易开口 | 这是让她"有偏好"的关键 |

---

## 六、权限两档

| 档位 | 面板上叫 | 能干什么 |
|---|---|---|
| `full` | **能指挥干活** | 查文件、跑命令、改代码、收发文件（PowerShell + fs + web） |
| `social` | **只能聊天** | 只有发表情、发说说这类 QQ 工具，碰不到电脑 |

- 私聊白名单里的人默认走 `full`（可用 `whitelistLevel` 改）
- **群聊永远是 `social`**——群里不加工具，这是设计

---

## 七、复制一条鱼：步骤

```bash
# 1. 装插件（本地克隆后用 file: 装）
git clone https://github.com/aureth-labs/dsh-aurabot-qq
git clone https://github.com/slopus/happy   # 可选，手机遥控

# 2. 建 profile（从 web 模板复制一份，别和日常用的挤在一起）
cp -r $DSH_HOME/profiles/web $DSH_HOME/profiles/fish

# 3. 装 aurabot
cd $DSH_HOME/profiles/fish
npm i file:/path/to/dsh-aurabot-qq

# 4. 起宿主
DSH_HOME=... dsh --profile fish --port 3091 --no-open

# 5. 浏览器打开面板 → 连 QQ → 扫码 → 设人格 → 设权限
```

---

## 八、我们踩过的坑（省你几小时）

| 坑 | 现象 | 解 |
|---|---|---|
| **`settings.json` 整块覆盖 patch** | 人设/端口/workspace 全被拉平 | 别用桌面端「设置 → QQ」面板；把 `~/.dsh/dsh-qq/settings.json` 清成 `{}` |
| **`longTasks` 要两个插件** | 私聊完全不回，日志写 `tool-schedule: never started` | 关掉 `longTasks`，或把 `dsh-tool-schedule` / `dsh-tool-jobs` 装上 |
| **群里只认 @ 或唤醒词** | 发了消息没人理 | 检查 `wakeWords`；发消息时真的 @ 一下 |
| **两个号同机会互相挤** | 一会儿这个掉一会儿那个掉 | 错开端口；别频繁重启；**别 taskkill /F** |
| **`quietHours` 半夜静音** | 凌晨跑的活动突然没人回 | 临时改配置或避开时段 |
| **gists 一直是空的** | 长期记忆不压缩 | 查 `compressAfterDays` 和定时任务是否真的跑了 |

---

## 九、和「桥」的区别

这个仓库里其实有**两条路线**：

| | aurabot（这条鱼） | QQ 桥（`bridge/`） |
|---|---|---|
| 谁在说话 | DSH agent + 插件 | 直接起 `claude` |
| 人格 | `personas/*.md` | `bridge2.mjs` 里的常量 |
| 记忆 | SQLite + 自动抽取 | `memory.mjs`（JSON） |
| 适合 | 24 小时在线的角色 | 你本来就在思考时的外挂 |

两条都能用，看你要「一条住下来的鱼」还是「一个随叫随到的通道」。
