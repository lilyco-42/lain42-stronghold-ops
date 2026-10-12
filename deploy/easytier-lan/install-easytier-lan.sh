#!/bin/bash
# EasyTier LAN M1 部署脚本（对应 docs/20-easytier-lan-m1.md §2）
set -euo pipefail
echo "=== 1) 下载安装 EasyTier v2.6.4 ==="
mkdir -p /etc/easytier
cd /tmp && rm -rf et et.zip && mkdir et
curl -fL --retry 2 --connect-timeout 10 -o et.zip \
  https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-linux-x86_64-v2.6.4.zip
unzip -o -q et.zip -d /tmp/et
CORE=$(find /tmp/et -name easytier-core -type f | head -1)
CLI=$(find /tmp/et -name easytier-cli -type f | head -1)
[ -n "$CORE" ] && [ -n "$CLI" ] || { echo "FATAL: zip 里没找到 easytier-core/cli"; exit 1; }
install -m 0755 "$CORE" /usr/local/bin/easytier-core
install -m 0755 "$CLI" /usr/local/bin/easytier-cli
/usr/local/bin/easytier-core --version || true

echo "=== 2) 安装 socat ==="
apt-get update -qq -o Acquire::Retries=2
DEBIAN_FRONTEND=noninteractive apt-get install -y socat
socat -V | head -1 || true

echo "=== 3) 生成网络凭据（0600，只落这台机器）==="
if [ ! -f /etc/easytier/env ]; then
  ( umask 077
    printf 'NETWORK_NAME=stronghold-lan\nNETWORK_SECRET=%s\n' \
      "$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)" > /etc/easytier/env )
fi
chmod 600 /etc/easytier/env
echo "env 权限: $(stat -c '%a %U:%G' /etc/easytier/env)，密钥长度: $(grep -c NETWORK_SECRET /etc/easytier/env) 行"

echo "=== 4) 安装 systemd 单元 ==="
install -m 0644 /tmp/easytier-lan.service /etc/systemd/system/easytier-lan.service
install -m 0644 /tmp/easytier-lan-bridge.service /etc/systemd/system/easytier-lan-bridge.service
systemctl daemon-reload
systemctl enable --now easytier-lan.service
systemctl enable --now easytier-lan-bridge.service
echo "=== 安装完成 ==="
