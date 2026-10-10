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

# 3. Dependencies. Refresh the package lists, then make sure what download
#    shaping needs is present: kmod-sched-core (HTB, fq_codel, filters),
#    kmod-ifb and a tc binary (tc-tiny unless some tc is already installed;
#    naming one avoids the package manager having to pick a "tc" provider).
#    The package depends on these too; installing them first is what makes
#    the dependency resolvable. If they cannot be installed (no matching
#    kernel modules in the feed), the limiter still runs and polices.
echo "Updating package lists..."
if [ "$PKG_MGR" = "apk" ]; then apk update >/dev/null 2>&1; else opkg update >/dev/null 2>&1; fi
NEED="kmod-sched-core kmod-ifb"
command -v tc >/dev/null 2>&1 || NEED="$NEED tc-tiny"
for p in $NEED; do
    if [ "$PKG_MGR" = "apk" ]; then
        apk info -e "$p" >/dev/null 2>&1 && continue
        echo "Installing dependency $p ..."
        apk add "$p" >/dev/null 2>&1 || echo "Warning: could not install $p; downloads will be policed, not shaped."
    else
        opkg list-installed | grep -q "^$p " && continue
        echo "Installing dependency $p ..."
        opkg install "$p" >/dev/null 2>&1 || echo "Warning: could not install $p; downloads will be policed, not shaped."
    fi
done

# 4. Install
echo "Installing..."
if [ "$PKG_MGR" = "apk" ]; then
    apk add --allow-untrusted "./$FILE_NAME" || { echo "Error: install failed."; exit 1; }
else
    opkg install "./$FILE_NAME" || { echo "Error: install failed."; exit 1; }
fi

# 5. Enable and start
rm -rf /tmp/luci-indexcache
rm -f "/tmp/$FILE_NAME"

/etc/init.d/rpcd restart
/etc/init.d/nft-limiter enable
# Rebuild the rules in place (one atomic transaction). A firewall restart
# would drop every rule, the limiter's included, while it reloads.
/etc/init.d/nft-limiter reapply

if [ "$PKG_MGR" = "apk" ]; then
    echo "Installed: $(apk list -I 2>/dev/null | grep -o 'luci-app-nft-limiter-[^ ]*')"
else
    echo "Installed: $(opkg list-installed | grep '^luci-app-nft-limiter ')"
fi
echo "Done! Open LuCI -> Network -> NFT Limiter to configure rules."
