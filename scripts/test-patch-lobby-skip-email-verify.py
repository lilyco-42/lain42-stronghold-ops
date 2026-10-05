#!/usr/bin/env python3
"""patch-lobby-skip-email-verify.py 的回归测试（不需要线上文件）。

夹具由脚本自己的锚点常量拼出来，所以两边不可能各说各话；线上那两个文件是全 CRLF 的，
夹具也一律用 CRLF —— 换行符是这个补丁最容易翻车的地方（本仓库 *.patch 被 .gitattributes 强制成 LF，
所以带 CR 的 unified diff 补丁在这里天生不可用，只能用按行匹配的脚本）。

    python3 scripts/test-patch-lobby-skip-email-verify.py
"""
import importlib.util
import json
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'patch-lobby-skip-email-verify.py')
spec = importlib.util.spec_from_file_location('plsev', SCRIPT)
plsev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plsev)

ENV = dict(os.environ, PYTHONIOENCODING='utf-8')
fails = []


def check(name, ok, extra=''):
    print(('PASS  ' if ok else 'FAIL  ') + name + (('  | ' + str(extra)[:200]) if extra else ''))
    if not ok:
        fails.append(name)


def crlf(text):
    return text.replace('\n', '\r\n')


CONFIG_FIXTURE = crlf('''import json
import os

basedir = os.path.abspath(os.path.dirname(__file__))


def _load_site_config():
    try:
        with open(os.path.join(basedir, 'data', 'site.json'), encoding='utf-8') as fp:
            return json.load(fp)
    except (OSError, ValueError):
        return {}


_SITE = _load_site_config()


class Config:
    %s
    BLOCKED_EMAILS = set()
''' % plsev.CONFIG_ANCHOR)

WSGI_FIXTURE = crlf('''import os

from config import Config

EMAIL_SERVICE_ENABLED = Config.EMAIL_SERVICE_ENABLED
# 以下三项统一由 config.py（.env / data/site.json）控制
# 自建部署开关：置 1 时注册不校验邮箱验证码。
%s

def register(data):
    if not SKIP_EMAIL_VERIFY and not data.get('verification_code'):
        return 400
    return 201
''' % plsev.WSGI_ANCHOR)


def md5(p):
    return hashlib.md5(open(p, 'rb').read()).hexdigest()


def mkfixture(site_json=None):
    d = tempfile.mkdtemp(prefix='sp-lobbytest-')
    open(os.path.join(d, 'config.py'), 'w', encoding='utf-8', newline='').write(CONFIG_FIXTURE)
    open(os.path.join(d, 'wsgi.py'), 'w', encoding='utf-8', newline='').write(WSGI_FIXTURE)
    if site_json is not None:
        os.makedirs(os.path.join(d, 'data'), exist_ok=True)
        open(os.path.join(d, 'data', 'site.json'), 'w', encoding='utf-8').write(site_json)
    return d


def run(root, *flags):
    r = subprocess.run([sys.executable, SCRIPT, *flags, root], capture_output=True, text=True,
                       encoding='utf-8', env=ENV)
    return r.returncode, ((r.stdout or '') + (r.stderr or '')).strip()


def lines(p):
    return open(p, encoding='utf-8', newline='').read().splitlines(True)


def endings(p):
    b = open(p, 'rb').read()
    return b.count(b'\r\n'), b.count(b'\n') - b.count(b'\r\n')


# 1. --dry-run 不落盘
d = mkfixture()
snap = (md5(d + '/config.py'), md5(d + '/wsgi.py'))
rc, out = run(d, '--dry-run')
check('--dry-run rc 0', rc == 0, out)
check('--dry-run 一个字节都没写', (md5(d + '/config.py'), md5(d + '/wsgi.py')) == snap)

# 2. 打补丁：只改预期的行，换行符保持 CRLF
rc, out = run(d)
check('patch rc 0', rc == 0, out)
check('两个文件都改了', (md5(d + '/config.py'), md5(d + '/wsgi.py')) != snap)
cfg = open(d + '/config.py', encoding='utf-8').read()
check('config.py 插入了脚本 CONFIG_NEW 的原文',
      all(l in cfg for l in plsev.CONFIG_NEW), plsev.CONFIG_NEW)
want_cfg = CONFIG_FIXTURE.count('\r\n') + len(plsev.CONFIG_NEW)
want_wsgi = WSGI_FIXTURE.count('\r\n')
check('config.py 仍全 CRLF，且只多了 %d 行' % len(plsev.CONFIG_NEW),
      endings(d + '/config.py') == (want_cfg, 0), (endings(d + '/config.py'), want_cfg))
check('wsgi.py 仍全 CRLF，行数不变（%d）' % want_wsgi, endings(d + '/wsgi.py') == (want_wsgi, 0), endings(d + '/wsgi.py'))
wl = [l.strip() for l in lines(d + '/wsgi.py')]
check('wsgi.py 改成从 Config 取值', plsev.WSGI_MARK in wl)
check('wsgi.py 里不再有只认环境变量的定义',
      not any("os.environ.get('SKIP_EMAIL_VERIFY'" in l for l in wl))
check('行数不变（替换而非追加）', len(lines(d + '/wsgi.py')) == len(WSGI_FIXTURE.splitlines(True)))
for f in ('config.py', 'wsgi.py'):
    try:
        compile(open(d + '/' + f, encoding='utf-8').read(), f, 'exec')
        ok, extra = True, ''
    except SyntaxError as e:
        ok, extra = False, e
    check('%s 改后能编译' % f, ok, extra)

# 3. 幂等
m1 = (md5(d + '/config.py'), md5(d + '/wsgi.py'))
rc, out = run(d)
check('第二次跑 rc 0 且提示已改好', rc == 0 and '无需修改' in out, out)
check('第二次跑字节不变', (md5(d + '/config.py'), md5(d + '/wsgi.py')) == m1)

# 4. 锚点丢失 -> 报错且两文件都不写（原子性：不能只写一半）
d2 = mkfixture()
bad = open(d2 + '/config.py', encoding='utf-8', newline='').read().replace(
    '    ' + plsev.CONFIG_ANCHOR + '\r\n', '    EMAIL_SERVICE_ENABLED = False\r\n')
check('夹具确实改坏了', bad != CONFIG_FIXTURE)
open(d2 + '/config.py', 'w', encoding='utf-8', newline='').write(bad)
snap2 = (md5(d2 + '/config.py'), md5(d2 + '/wsgi.py'))
rc, out = run(d2)
check('缺锚点 -> 非零退出', rc != 0, 'rc=%s %s' % (rc, out))
check('缺锚点 -> 两个文件都保持原样', (md5(d2 + '/config.py'), md5(d2 + '/wsgi.py')) == snap2)
check('报错里点名 config.py 与锚点', 'config.py' in out and '锚点' in out, out)

# 5. 只有一半打过补丁 -> 拒绝继续（这种状态会让 wsgi 取到不存在的属性）
d3 = mkfixture()
shutil.copy2(d + '/config.py', d3 + '/config.py')
snap3 = md5(d3 + '/wsgi.py')
rc, out = run(d3)
check('半补丁状态被拒绝', rc != 0 and '一半' in out, 'rc=%s %s' % (rc, out))
check('拒绝时没动 wsgi.py', md5(d3 + '/wsgi.py') == snap3)

# 6. 语义：环境变量优先，其次 site.json，缺省要验证码
def resolves(site_json, env):
    work = tempfile.mkdtemp(prefix='sp-lobbytest-cfg-')
    os.makedirs(os.path.join(work, 'data'))
    open(os.path.join(work, 'data', 'site.json'), 'w', encoding='utf-8').write(site_json)
    shutil.copy2(d + '/config.py', os.path.join(work, 'config.py'))
    code = ("import sys;"
            "sys.path.insert(0,%r);import config;"
            "print(config.Config.SKIP_EMAIL_VERIFY)" % work)
    e = dict(ENV)
    e.pop('SKIP_EMAIL_VERIFY', None)
    e.update(env)
    r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, encoding='utf-8', env=e)
    return (r.stdout or '').strip() or ('ERR ' + (r.stderr or '')[-200:])


TRUE_SITE = json.dumps({'skip_email_verify': True})
cases = [
    ('site.json true 无环境变量', (TRUE_SITE, {}), 'True'),
    ("site.json true + env '0'", (TRUE_SITE, {'SKIP_EMAIL_VERIFY': '0'}), 'False'),
    ("site.json true + env '1'", (TRUE_SITE, {'SKIP_EMAIL_VERIFY': '1'}), 'True'),
    ('site.json false', (json.dumps({'skip_email_verify': False}), {}), 'False'),
    ('site.json 没这个键', (json.dumps({}), {}), 'False'),
]
for label, (site, env), want in cases:
    got = resolves(site, env)
    check('语义 ' + label, got == want, 'got=%r want=%s' % (got, want))

# 7. 打过补丁的 wsgi 真的按 site.json 放行注册
def gate(site_json, env):
    work = tempfile.mkdtemp(prefix='sp-lobbytest-wsgi-')
    for f in ('config.py', 'wsgi.py'):
        shutil.copy2(os.path.join(d, f), os.path.join(work, f))
    os.makedirs(os.path.join(work, 'data'))
    open(os.path.join(work, 'data', 'site.json'), 'w', encoding='utf-8').write(site_json)
    code = ("import sys;"
            "sys.path.insert(0,%r);import wsgi;"
            "print(wsgi.register({'username':'a','password':'b'}))" % work)
    e = dict(ENV)
    e.pop('SKIP_EMAIL_VERIFY', None)
    e.update(env)
    r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, encoding='utf-8', env=e)
    return (r.stdout or '').strip() or ('ERR ' + (r.stderr or '')[-200:])


check('线上 site.json 配置下注册不再 400', gate(TRUE_SITE, {}) == '201', gate(TRUE_SITE, {}))
check('关掉开关时仍要验证码 400', gate(json.dumps({'skip_email_verify': False}), {}) == '400',
      gate(json.dumps({'skip_email_verify': False}), {}))

print('\n%d check(s) failed%s' % (len(fails), ': ' + ', '.join(fails) if fails else ''))
sys.exit(1 if fails else 0)
