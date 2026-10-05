#!/usr/bin/env python3
"""让大厅注册的 SKIP_EMAIL_VERIFY 真正读 data/site.json（幂等，兼容 CRLF）。

问题：/opt/online-platform/data/site.json 里写着 "skip_email_verify": true，但没有任何代码读这个键。
wsgi.py:109 只认环境变量 SKIP_EMAIL_VERIFY，而 systemd 里没有设它 —— 于是 3031 行的注册校验仍然要验证码，
而服务器没有 SMTP 发不出验证码，结果注册永远 400「邮箱、密码和验证码是必需的！」。
wsgi.py:105-106 已经写了「以下三项统一由 config.py（.env / data/site.json）控制」，只有这一项漏在外面。

改两处：
  config.py  EMAIL_SERVICE_ENABLED 之后新增 SKIP_EMAIL_VERIFY：环境变量优先，其次 site.json。
  wsgi.py    那行 os.environ.get 改成从 Config 取值，和相邻三项一样。
环境变量显式设 0 仍能关掉（'0' 是真值字符串，!= '1'），所以 site.json 不会盖掉运维的临时意图。

线上两个文件是全 CRLF 的（实测 config.py 134/134、wsgi.py 4985/4985 行带 CR），本仓库的 .gitattributes
强制 *.patch 为 LF，补丁里的 CR 会被吃掉 → unified diff 一律 apply 失败。所以这里用按行匹配的脚本，
并且保留每个文件自己的换行符，不顺手把整个文件转成 LF（那会产生 5000 行的假 diff）。

用法：
    python3 scripts/patch-lobby-skip-email-verify.py                    # 改 /opt/online-platform
    python3 scripts/patch-lobby-skip-email-verify.py --dry-run <root>   # 只看会改成什么，不落盘
两个锚点都找到、且改后源码能编译，才会写盘；任一不满足则一个字节都不动。
"""
import os
import shutil
import sys

DEFAULT_ROOT = '/opt/online-platform'

CONFIG_ANCHOR = "EMAIL_SERVICE_ENABLED = os.environ.get('EMAIL_SERVICE_ENABLED', '1') == '1'"
CONFIG_NEW = [
    "    # 注册是否跳过邮箱验证码：环境变量优先，其次 data/site.json 的 skip_email_verify（自建实例没有 SMTP）。",
    "    SKIP_EMAIL_VERIFY = (os.environ.get('SKIP_EMAIL_VERIFY') or ('1' if _SITE.get('skip_email_verify') else '0')) == '1'",
]
CONFIG_MARK = 'SKIP_EMAIL_VERIFY'

WSGI_ANCHOR = "SKIP_EMAIL_VERIFY = os.environ.get('SKIP_EMAIL_VERIFY', '0') == '1'"
WSGI_NEW = ['SKIP_EMAIL_VERIFY = Config.SKIP_EMAIL_VERIFY']
WSGI_MARK = 'SKIP_EMAIL_VERIFY = Config.SKIP_EMAIL_VERIFY'


def read_lines(path):
    """按原样读入，保留每行的换行符（CRLF 不会被转成 LF）。"""
    with open(path, encoding='utf-8', newline='') as f:
        return f.read().splitlines(True)


def split_ending(line):
    return '\r\n' if line.endswith('\r\n') else '\n'


def locate(lines, anchor, path):
    """按去掉首尾空白的内容精确匹配锚点；0 个或多个匹配都直接报错，绝不猜。"""
    hits = [i for i, l in enumerate(lines) if l.strip() == anchor]
    if not hits:
        raise SystemExit(f'{path}: 找不到锚点 {anchor!r} —— 文件未修改')
    if len(hits) > 1:
        raise SystemExit(f'{path}: 锚点 {anchor!r} 匹配到 {len(hits)} 行，无法确定改哪一处 —— 文件未修改')
    return hits[0]


def report(title, start, new_lines, end):
    print(f'  {title}: 在第 {start + 1} 行{end}')
    for l in new_lines:
        print('    + ' + l.rstrip())


def main():
    args = [a for a in sys.argv[1:] if a != '--dry-run']
    dry = '--dry-run' in sys.argv[1:]
    root = args[0] if args else DEFAULT_ROOT
    config_path = os.path.join(root, 'config.py')
    wsgi_path = os.path.join(root, 'wsgi.py')
    for p in (config_path, wsgi_path):
        if not os.path.isfile(p):
            raise SystemExit(f'找不到 {p} —— 请给出大厅目录，例如：{sys.argv[0]} /opt/online-platform')

    config_lines = read_lines(config_path)
    wsgi_lines = read_lines(wsgi_path)

    config_done = any(l.strip().startswith('SKIP_EMAIL_VERIFY') for l in config_lines)
    wsgi_done = any(l.strip() == WSGI_MARK for l in wsgi_lines)
    if config_done and wsgi_done:
        print('已经是改好的状态 —— 无需修改')
        return 0
    if config_done != wsgi_done:
        raise SystemExit('只有一半打过补丁（config.py 与 wsgi.py 状态不一致），请先人工确认再跑')

    ci = locate(config_lines, CONFIG_ANCHOR, config_path)
    wi = locate(wsgi_lines, WSGI_ANCHOR, wsgi_path)
    c_end = split_ending(config_lines[ci])
    w_end = split_ending(wsgi_lines[wi])
    if config_lines[ci].lstrip().startswith('SKIP_EMAIL_VERIFY'):
        raise SystemExit('config.py 锚点行本身就是 SKIP_EMAIL_VERIFY —— 结构已变，请人工检查')

    new_config = config_lines[:ci + 1] + [l + c_end for l in CONFIG_NEW] + config_lines[ci + 1:]
    new_wsgi = wsgi_lines[:wi] + [l + w_end for l in WSGI_NEW] + wsgi_lines[wi + 1:]

    # 语法闸门：编译的是即将写盘的源码，任何一次跑都在落盘之前拦住坏语法。
    for path, lines in ((config_path, new_config), (wsgi_path, new_wsgi)):
        src = ''.join(lines)
        try:
            compile(src, path, 'exec')
        except SyntaxError as e:
            raise SystemExit(f'改后 {path} 语法不过（{e.lineno}: {e.msg}）—— 文件未修改')

    report('config.py', ci, CONFIG_NEW, ' 后插入 2 行')
    report('wsgi.py', wi, WSGI_NEW, ' 替换为 1 行')

    if dry:
        print('--dry-run：未写盘')
        return 0

    for path, lines in ((config_path, new_config), (wsgi_path, new_wsgi)):
        bak = path + '.bak-skipverify'
        if not os.path.exists(bak):
            shutil.copy2(path, bak)
            print(f'备份 -> {bak}')
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(''.join(lines))
    print('已补丁：config.py 新增 SKIP_EMAIL_VERIFY，wsgi.py 改为从 Config 取值')
    print('注意：Flask 进程不会自动加载，要生效需 restart online-platform.service（会断开大厅连接，请自行选时间）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
