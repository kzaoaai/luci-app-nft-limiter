#!/bin/sh

# One-liner install:
#   wget -qO- https://raw.githubusercontent.com/kzaoaai/luci-app-nft-limiter/main/install.sh | sh

# GitHub repository details
USER="kzaoaai"
REPO="luci-app-nft-limiter"
BRANCH="main"
RAW_URL="https://raw.githubusercontent.com/$USER/$REPO/$BRANCH"
API_URL="https://api.github.com/repos/$USER/$REPO/releases/latest"

echo "Starting nft-limiter installation (OpenWrt 25.12+ / nftables edition)..."

# 1. Detect package manager
if command -v apk >/dev/null 2>&1; then
    PKG_MGR="apk"
    EXT=".apk"
    echo "Detected OpenWrt 25.12+ (apk)"
elif command -v opkg >/dev/null 2>&1; then
    PKG_MGR="opkg"
    EXT=".ipk"
    echo "Detected OpenWrt 24.10 (opkg)"
else
    echo "Error: neither apk nor opkg found."
    exit 1
fi

# 2. Fetch latest release asset URL from GitHub API
echo "Fetching latest release info..."
FILE_URL=$(wget -qO- "$API_URL" \
    | grep -o "https://[^\"]*${EXT}" \
    | head -n 1)

if [ -z "$FILE_URL" ]; then
    echo "Error: no ${EXT} asset found in latest release."
    exit 1
fi

FILE_NAME="${FILE_URL##*/}"
echo "Downloading $FILE_NAME ..."
cd /tmp
wget -q "$FILE_URL" -O "$FILE_NAME"

if [ ! -s "$FILE_NAME" ]; then
    echo "Error: download failed."
    exit 1
fi

# 3. Install
echo "Installing..."
if [ "$PKG_MGR" = "apk" ]; then
    apk add --allow-untrusted "./$FILE_NAME"
else
    opkg install "./$FILE_NAME"
fi

# 4. Enable and start
rm -rf /tmp/luci-indexcache
rm -f "/tmp/$FILE_NAME"

/etc/init.d/rpcd restart
/etc/init.d/nft-limiter enable
# Rebuild the rules in place (one atomic transaction). A firewall restart
# would drop every rule, the limiter's included, while it reloads.
/etc/init.d/nft-limiter reapply

echo "Done! Open LuCI -> Network -> NFT Limiter to configure rules."
