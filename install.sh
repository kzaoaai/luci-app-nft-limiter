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

# fetch <url> <file> [header]: curl when installed, else the system wget.
fetch() {
    if command -v curl >/dev/null 2>&1; then
        if [ -n "$3" ]; then curl -fsSL --max-time 300 -H "$3" -o "$2" "$1"
        else curl -fsSL --max-time 300 -o "$2" "$1"; fi
    else
        if [ -n "$3" ]; then wget -q -T 30 --header="$3" -O "$2" "$1"
        else wget -q -T 30 -O "$2" "$1"; fi
    fi
}

# A package, not an error page or JSON.
is_pkg() {
    [ -s "$1" ] || return 1
    case "$(head -c 1 "$1")" in "{"|"<") return 1 ;; esac
    return 0
}

# 2. Find the latest release's package
echo "Fetching latest release info..."
cd /tmp
REL="/tmp/nft-limiter-release.json"
if ! fetch "$API_URL" "$REL" || [ ! -s "$REL" ]; then
    rm -f "$REL"
    echo "Error: could not read the latest release from the GitHub API."
    exit 1
fi
FILE_NAME=""; FILE_URL=""; ASSET_URL=""
if command -v jsonfilter >/dev/null 2>&1; then
    FILE_NAME=$(jsonfilter -i "$REL" -e '@.assets[*].name' | grep "${EXT}\$" | head -n 1)
    if [ -n "$FILE_NAME" ]; then
        FILE_URL=$(jsonfilter -i "$REL" -e "@.assets[@.name=\"$FILE_NAME\"].browser_download_url")
        ASSET_URL=$(jsonfilter -i "$REL" -e "@.assets[@.name=\"$FILE_NAME\"].url")
    fi
else
    FILE_URL=$(grep -o "https://[^\"]*${EXT}" "$REL" | head -n 1)
    FILE_NAME="${FILE_URL##*/}"
fi
rm -f "$REL"

if [ -z "$FILE_NAME" ] || [ -z "$FILE_URL" ]; then
    echo "Error: no ${EXT} asset found in latest release."
    exit 1
fi

# Download through the API's asset address first: OpenWrt's own wget
# (uclient-fetch) times out on github.com responses with large headers,
# which the browser download link's redirect has, while the API's redirect
# is small. The browser link is the fallback.
echo "Downloading $FILE_NAME ..."
OK=""
if [ -n "$ASSET_URL" ]; then
    rm -f "$FILE_NAME"
    fetch "$ASSET_URL" "$FILE_NAME" "Accept: application/octet-stream" && is_pkg "$FILE_NAME" && OK=1
fi
if [ -z "$OK" ]; then
    rm -f "$FILE_NAME"
    fetch "$FILE_URL" "$FILE_NAME" && is_pkg "$FILE_NAME" && OK=1
fi
if [ -z "$OK" ]; then
    rm -f "$FILE_NAME"
    echo "Error: download failed."
    echo "Download it on another computer and copy it to /tmp on this router:"
    echo "  $FILE_URL"
    if [ "$PKG_MGR" = "apk" ]; then
        echo "then run: apk add --allow-untrusted /tmp/$FILE_NAME"
    else
        echo "then run: opkg install /tmp/$FILE_NAME"
    fi
    echo "and: /etc/init.d/rpcd restart; /etc/init.d/nft-limiter enabled && /etc/init.d/nft-limiter start"
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

# 5. Rebuild the rules
rm -rf /tmp/luci-indexcache
rm -f "/tmp/$FILE_NAME"

# The package enables the service on a first install; an upgrade keeps it
# on or off as it was.
/etc/init.d/rpcd restart
# Rebuild the rules in place (one atomic transaction). A firewall restart
# would drop every rule, the limiter's included, while it reloads. The
# service's start (not reapply) also registers the package's procd triggers
# again, so a trigger a new version adds (v3.1.7: dhcp changes) works now
# rather than after the next boot.
if /etc/init.d/nft-limiter enabled; then
    /etc/init.d/nft-limiter start
fi

if [ "$PKG_MGR" = "apk" ]; then
    echo "Installed: $(apk list -I 2>/dev/null | grep -o 'luci-app-nft-limiter-[^ ]*')"
else
    echo "Installed: $(opkg list-installed | grep '^luci-app-nft-limiter ')"
fi
echo "Done! Open LuCI -> Network -> NFT Limiter to configure rules."
