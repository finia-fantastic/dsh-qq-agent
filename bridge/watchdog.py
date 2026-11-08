# -*- coding: utf-8 -*-
"""我的号（<BOT_QQ>）+ QQ 桥的看门狗。

2026-11-07 写。规矩是从今天的两次事故里长出来的：

  事故一：看门狗每 5 分钟拉一次 NapCat，拉了 11 小时，
          堆出 468 个 QQ 进程 / 34 GB，整机卡死。
  事故二：我为了「修」反复强杀 QQ、反复扫码，
          把账号的登录态一次次弄坏 —— 越修掉得越勤。

所以这个看门狗只做两件事，而且都不许越界：

  · 3004 不通 → 只在【QQ 进程完全不在】时才拉一次；QQ 进程还在就绝不重复注入
  · 桥不在   → 重启桥（那是我的代码，没有凭据，重启安全）

护栏：
  1. 连续失败 3 次就彻底停手，日志写「需要人看一眼」
  2. 退避 30 分钟，不是 5 分钟
  3. 永不 taskkill、永不主动重启正在跑的进程
  4. 静默处理：掉了就自己拉，不等人批；只在「拉了」「好了」「放弃了」这三种时候记一行

用法：pythonw.exe watchdog.py
日志：watchdog.log
"""
import datetime
import os
import socket
import subprocess
import time

# 目录就是脚本自己所在的目录；NapCat 的启动脚本用环境变量指过来，
# 没配就只盯桥、不碰 QQ（宁可不拉，也不误杀）。
BASE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(BASE, "watchdog.log")
ALLOW_FLAG = os.path.join(BASE, "允许拉起QQ.flag")

NAP_BAT = os.environ.get("QQ_NAP_BAT", "")
NAP_CWD = os.environ.get("QQ_NAP_CWD", "")
QQ_EXE_NAME = "QQ.exe"

BRIDGE_DIR = BASE
BRIDGE_LOG = os.path.join(BASE, "bridge2.log")

PORT_QQ = int(os.environ.get("QQ_ONEBOT_PORT", "3004"))
CHECK = 60            # 每 60 秒查一次
RETRY_WAIT = 1800     # 拉一次没起来，30 分钟后再试
MAX_TRIES = 3


def log(msg):
    line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def up(port):
    s = socket.socket()
    s.settimeout(2)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def qq_running():
    """我的那个 QQ 客户端还在不在。

    注意：这里查的是「有没有 Blue 实例的 QQ 进程」。
    在跑就说明登录态可能还在，绝不能为了「修」去杀它 —— 那正是把凭据弄坏的动作。
    """
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq QQ.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=20, encoding="gbk", errors="replace",
        ).stdout
        return "QQ.exe" in out
    except Exception:
        return True  # 查不到就当它在，宁可不拉


def bridge_running():
    """桥（node bridge2.mjs）还在不在。

    2026-11-07 改：原来每 60 秒跑一次 `wmic process get CommandLine`，
    每次都拉起 WmiPrvSE 干活（那天它的累计 CPU 时间飙到 26 万秒）。
    改成读 bridge2.pid 再用 tasklist 核对该 PID，开销小一个数量级。
    """
    try:
        with open(os.path.join(BASE, "bridge2.pid"), encoding="utf-8") as f:
            pid = int(f.read().strip())
    except Exception:
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=15, encoding="gbk", errors="replace",
        ).stdout
        return str(pid) in out
    except Exception:
        return True  # 查不到就当它在，宁可不重复拉


def start_napcat():
    if not NAP_BAT or not os.path.exists(NAP_BAT):
        return False   # 没配 NapCat 路径就不动它
    subprocess.Popen(
        ["cmd.exe", "/c", "start", "", "/min", NAP_BAT],
        cwd=NAP_CWD,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
    )
    return True


def start_bridge():
    with open(BRIDGE_LOG, "ab") as out:
        subprocess.Popen(
            ["node", "bridge2.mjs"],
            cwd=BRIDGE_DIR, stdout=out, stderr=out,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )


def main():
    log("看门狗启动（QQ:%d + 桥）｜只拉不通的，永不 taskkill" % PORT_QQ)
    qq_down_at = None
    qq_tries = 0
    qq_gave_up = False
    br_down_at = None
    br_tries = 0

    while True:
        # ---------- QQ 网关 ----------
        if up(PORT_QQ):
            if qq_down_at:
                log(f"QQ 网关（{PORT_QQ}）已恢复")
            qq_down_at, qq_tries, qq_gave_up = None, 0, False
        elif qq_gave_up:
            pass
        elif qq_down_at is None:
            qq_down_at = time.time()   # 静默：先不吭声，等真要动手再说
        elif time.time() - qq_down_at > RETRY_WAIT:
            if qq_running():
                log("QQ 进程还在，注入大概率已经失败 —— 不重复拉起（重复拉会堆进程，也会弄坏凭据）")
                qq_down_at = time.time()
            elif qq_tries >= MAX_TRIES:
                qq_gave_up = True
                log(f"🔴 连拉 {MAX_TRIES} 次都没起来，停手。请人看一眼：可能要扫码")
            else:
                qq_tries += 1
                log(f"QQ 进程不在，第 {qq_tries}/{MAX_TRIES} 次拉起 NapCat")
                start_napcat()
                qq_down_at = time.time()

        # ---------- 桥 ----------
        if bridge_running():
            if br_down_at:
                log("QQ 桥已恢复")
            br_down_at, br_tries = None, 0
        elif br_down_at is None:
            br_down_at = time.time()
            log("桥断了，拉起来")
            start_bridge()
        elif time.time() - br_down_at > RETRY_WAIT and br_tries < MAX_TRIES:
            br_tries += 1
            br_down_at = time.time()
            log(f"QQ 桥还没起来，第 {br_tries}/{MAX_TRIES} 次再拉")
            start_bridge()
        elif br_tries >= MAX_TRIES and br_down_at:
            log("🔴 桥连拉 3 次都没起来，停手等我看日志")
            br_down_at = float("inf")

        time.sleep(CHECK)


if __name__ == "__main__":
    main()
