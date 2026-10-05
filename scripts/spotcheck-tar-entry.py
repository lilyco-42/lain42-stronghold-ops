"""Read one entry out of a hosted .tar.gz by Range, without downloading the whole thing.

Why: `.github/workflows/build-clients.yml` has a DEFAULT payload_url pointing at the OSS copy
(sp-client-payload.tar.gz). Whether that copy already carries the font mirror decides what an
un-parameterized CI run does — worth knowing before anyone presses the button.
gzip is not randomly seekable, but a tar writes its entries sequentially and the packager puts index.html
near the front, so we can decompress just a prefix (zlib wbits=31 tolerates an unfinished stream) and walk
512-byte headers until the wanted entry shows up.
"""
import sys
import urllib.request
import zlib

URL = sys.argv[1] if len(sys.argv) > 1 else 'https://dl.lain42.top/downloads/stronghold-protocol/client/sp-client-payload.tar.gz'
WANT = (sys.argv[2] if len(sys.argv) > 2 else 'index.html').lstrip('./')
CHUNK = int(sys.argv[3]) if len(sys.argv) > 3 else 4_000_000     # compressed bytes per Range request
MAXWALK = int(sys.argv[4]) if len(sys.argv) > 4 else 80_000_000  # decompressed bytes we are willing to walk


def fetch(start, end):
    req = urllib.request.Request(URL, headers={'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(req, timeout=240) as r:
        if r.status != 206:
            raise SystemExit(f'服务器没理 Range（{r.status}）—— 这条路不适用，只能整包下载')
        total = int((r.headers.get('Content-Range') or '/').split('/')[-1] or 0)
        return r.read(), total


class Reader:
    def __init__(self):
        self.obj = zlib.decompressobj(31)
        self.dec = b''
        self.pos = 0
        self.total = None
        self.pulled = 0

    def need(self, n):
        """Ensure at least n decompressed bytes are buffered; pull more ranges as needed."""
        while len(self.dec) < n and (self.total is None or self.pos < self.total):
            stop = self.pos + CHUNK - 1 if self.total is None else min(self.pos + CHUNK - 1, self.total - 1)
            chunk, self.total = fetch(self.pos, stop)
            self.pos += len(chunk)
            self.pulled += len(chunk)
            if not chunk:
                return False
            self.dec += self.obj.decompress(chunk)
        return len(self.dec) >= n


rd, found, names = Reader(), None, []
while len(names) * 512 < MAXWALK and rd.need(512):
    h = rd.dec[:512]
    if h[257:262] != b'ustar':            # magic lives at offset 257, NOT at the start (that is the name field)
        print('tar 头签名不对，停止于条目', len(names), '前缀', h[:16], h[257:263])
        break
    name = h[0:100].split(b'\0', 1)[0].decode('utf8', 'replace')
    size = int(h[124:136].split(b'\0', 1)[0].decode().strip() or '0', 8)
    need = 512 + ((size + 511) // 512) * 512
    if not rd.need(need):
        print(f'取不完这一条了（{name} size={size}）')
        break
    names.append((name, size))
    if name.lstrip('./') == WANT:
        found = rd.dec[512:512 + size]
        break
    rd.dec = rd.dec[need:]

print(f'object total {rd.total:,} B | pulled {rd.pulled:,} B compressed | walked {len(names)} entries')
print('first entries:', [n for n, _ in names[:6]])
if found is None:
    print(f'NOT FOUND: {WANT}')
    sys.exit(2)
text = found.decode('utf8', 'replace')
print(f'{WANT}: {len(found)} B')
if len(found) < 4096 and '--dump' in sys.argv:
    print('--- content ---')
    print(found.decode('utf8', 'replace'))
for k in ('fonts.googleapis.com', 'fonts.gstatic.com', '/webfonts/google/google.css', 'dl.lain42.top', '<link'):
    print('  %-30s %d' % (k, text.count(k)))
