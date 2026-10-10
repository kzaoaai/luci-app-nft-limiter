#
# Copyright (C) 2025 kzaoaai (based on work by sirpdboy)
# This is free software, licensed under the MIT License.
# See ./LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-nft-limiter

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE

LUCI_TITLE:=LuCI app for NFT Limiter (nftables/fw4 per-device bandwidth control)
LUCI_DESCRIPTION:=Per-device download/upload rate limiting: downloads shaped (tc HTB + fq_codel) or policed (nftables), uploads policed. Supports IP, CIDR, and IP ranges. Requires OpenWrt 25.12+ with firewall4.
LUCI_DEPENDS:=+ip-full +nftables +bc +firewall4 +tc +kmod-sched-core +kmod-ifb
LUCI_PKGARCH:=all
# Ship the JavaScript unminified: the view loader (view/nft-limiter.js)
# reads nftlimiter/app.js over RPC and parses its leading require
# directives; loaders cached by browsers from v3.0.x expect one per line.
LUCI_MINIFY_JS:=0

PKG_VERSION:=1.6.0
PKG_RELEASE:=1
PKG_MAINTAINER:=kzaoaai

define Build/Compile
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
rm -f /tmp/luci-*
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/nft-limiter
endef

include $(TOPDIR)/feeds/luci/luci.mk

$(eval $(call BuildPackage,$(PKG_NAME)))
