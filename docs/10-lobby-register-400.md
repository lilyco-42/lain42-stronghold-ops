# 10 · 大厅注册永远 400：`site.json` 的开关没人读（代码已备好，未部署）

现象：`https://sp.lain42.top/lobby` 注册一定失败 ——「邮箱、密码和验证码是必需的！」，可是页面上**根本没有验证码输入框**。

## 因果链（2026-10-05 实测的行号）

1. `data/site.json:6` → `"skip_email_verify": true`。
2. `pages/login.html:344-353` 前端读它（注释还写着「见 data/site.json」），为 true 时**把验证码那一行 `display:none`**。
3. 后端完全不读这个键。`wsgi.py:109` 是
   `SKIP_EMAIL_VERIFY = os.environ.get('SKIP_EMAIL_VERIFY', '0') == '1'`，
   而 systemd 没有设这个环境变量 → 标志恒为 False。
   （全仓库搜 `skip_email_verify` 的 Python 命中：**0 处**；只有 site.json 与 login.html。）
4. 于是 `wsgi.py:3031` 的注册校验仍然要 `verification_code` → 400；`wsgi.py:3050` 又要求先「获取邮箱验证码」，
   而这台机器没有 SMTP，验证码永远发不出去。

用户看到的就是：**框都没有，却告诉我必须有验证码** —— 注册通道等于关闭。
`wsgi.py:105` 那句注释「以下三项统一由 config.py（.env / data/site.json）控制」正是本该的做法，只有这一项漏在外面。

## 修法（两处，脚本 + 回归测试）

- `scripts/patch-lobby-skip-email-verify.py`（幂等）
  - `config.py`：`EMAIL_SERVICE_ENABLED` 之后新增
    `SKIP_EMAIL_VERIFY = (os.environ.get('SKIP_EMAIL_VERIFY') or ('1' if _SITE.get('skip_email_verify') else '0')) == '1'`
    —— 环境变量优先，其次 `site.json`；显式 `SKIP_EMAIL_VERIFY=0` 仍能关掉（`'0'` 是真值字符串，`!= '1'`）。
  - `wsgi.py:109`：改成 `SKIP_EMAIL_VERIFY = Config.SKIP_EMAIL_VERIFY`，与相邻三项同构。注册逻辑（3031/3050）一行没动。
- `scripts/test-patch-lobby-skip-email-verify.py` —— 不需要线上文件，夹具由脚本自己的锚点常量拼出，28 项检查。
  覆盖：`--dry-run` 不落盘、只改预期行、幂等、锚点缺失时**两个文件都不写**（原子性）、半补丁状态直接拒绝、
  优先级矩阵（site.json true→注册 201；关掉→仍 400；缺省→要验证码）。

## 为什么这里不能用 `.patch`

打这份改动时（2026-10-05 13:22 实测）线上 `config.py` / `wsgi.py` 是**全 CRLF** 的（134/134、4985/4985 行带 CR，裸 LF 0 行）。
本仓库 `.gitattributes` 有 `*.patch text eol=lf`（提交 7b88019「强制 LF」），签出的补丁里 CR 会被吃掉 →
`patch -p1` 报 `Hunk #1 FAILED (different line endings)`，两个文件都试过、确实如此。
所以运维改动凡是落在 CRLF 文件上的，一律写成按行匹配的 `scripts/patch-*.py`，并且**保留每个文件自己的换行符**
（顺手把 5000 行转成 LF 会造出一个没法 review 的假 diff）。

## 线上在 13:48 被别人动过（已重验，补丁仍然有效）

13:48 有人（另一个会话/人工）往大厅部署了一处 **ads** 改动：`models.py` 与 `wsgi.py` 各留了 `*.bak-ads` 备份，
13:49 `systemctl restart online-platform.service`（`NRestarts=0`、`Result=success` —— 是主动重启，不是崩溃）。
之后 `wsgi.py` 变成 **194,356 B、全 LF（5132 行）**，而 `config.py` **没动**（md5 仍是 `b2c9493a…`、134/134 CRLF）。

拿新的线上字节重跑了一遍（只在本机副本上，`--dry-run` rc=0，正式跑也在副本）：
- 锚点仍然命中：`config.py` 第 70 行后插 2 行、`wsgi.py` 第 109 行替换 1 行（那行 `os.environ.get('SKIP_EMAIL_VERIFY', '0')` 一字未变）；
- 两个文件**各自保持自己的换行符**：`config.py` 134→136 行仍全 CRLF、裸 LF 0；`wsgi.py` 仍全 LF（0 个 CR），行数不变；
- 改后两份都能 `compile()`，注册校验那一行（现在在第 3036 行）原样保留，`.bak-skipverify` 正常写出。

也就是说脚本按行匹配 + 保留换行符的做法正好扛住了这次外部改动 —— 但**部署前必须重新 `--dry-run`**，
因为线上文件是别人的活动靶子，不是我以为的静止状态。

## 部署（由人决定，本文档写作时**没有**动线上）

```
ssh root@lain42.top 'mkdir -p /opt/ops-staging'                       # 这个目录现在不存在
scp scripts/patch-lobby-skip-email-verify.py root@lain42.top:/opt/ops-staging/
python3 /opt/ops-staging/patch-lobby-skip-email-verify.py --dry-run /opt/online-platform   # 先看
python3 /opt/ops-staging/patch-lobby-skip-email-verify.py /opt/online-platform             # 再改（自动 .bak-skipverify）
systemctl restart online-platform.service                                                  # 必须重启才生效
```

代价评估：`online-platform.service`（python，MainPID 3824553，监听 127.0.0.1:5000）与
`stronghold.service`（node22，MainPID 3806556，监听 127.0.0.1:5150）是**两个进程、两个端口**。
重启大厅只断开大厅页面/登录态，**不会**动进行中的对局 —— 对局状态在 node 那边（README 硬规矩 6 说的是 stronghold）。
回滚：`cp /opt/online-platform/config.py.bak-skipverify /opt/online-platform/config.py`，wsgi.py 同理，再重启。
