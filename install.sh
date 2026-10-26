#!/bin/sh
# geohop installer
#
#   curl -fsSL https://raw.githubusercontent.com/devnazir/geohop/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/devnazir/geohop/main/install.sh | sh -s -- --uninstall
#
# Installs OpenVPN (via your package manager), Node.js if a recent one is missing,
# and the `geohop` command.

set -eu

REPO="devnazir/geohop"
REF="${GEOHOP_REF:-main}"
INSTALL_DIR="${GEOHOP_INSTALL_DIR:-$HOME/.local/share/geohop}"
BIN_DIR="${GEOHOP_BIN_DIR:-/usr/local/bin}"
NODE_MAJOR=22
MIN_NODE_MAJOR=18

if [ -t 1 ]; then
  ESC="$(printf '\033')"
  BOLD="$ESC[1m" DIM="$ESC[2m" RED="$ESC[31m" GREEN="$ESC[32m" RESET="$ESC[0m"
else
  BOLD='' DIM='' RED='' GREEN='' RESET=''
fi

info() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
die() { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then
  has sudo || die "sudo is required (or run this script as root)"
  SUDO='sudo'
fi

# Homebrew and distro packages put openvpn in sbin, which is often not on PATH.
find_openvpn() {
  local dir
  for dir in $(printf '%s' "$PATH" | tr ':' ' ') /opt/homebrew/sbin /usr/local/sbin /usr/sbin /sbin; do
    [ -x "$dir/openvpn" ] && return 0
  done
  return 1
}

install_openvpn() {
  if find_openvpn; then
    ok "OpenVPN already installed"
    return
  fi
  info "Installing OpenVPN"
  case "$(uname -s)" in
    Darwin)
      has brew || die "Homebrew is required on macOS. Install it from https://brew.sh and run this again."
      brew install openvpn
      ;;
    Linux)
      if has apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y openvpn
      elif has dnf; then $SUDO dnf install -y openvpn
      elif has yum; then $SUDO yum install -y openvpn
      elif has pacman; then $SUDO pacman -S --noconfirm openvpn
      elif has zypper; then $SUDO zypper install -y openvpn
      elif has apk; then $SUDO apk add openvpn
      else die "Unsupported package manager. Install OpenVPN yourself and run this again."
      fi
      ;;
    *) die "Unsupported OS: $(uname -s). geohop supports macOS and Linux." ;;
  esac
  find_openvpn || die "OpenVPN install finished but the openvpn binary was not found"
  ok "OpenVPN installed"
}

sha256() {
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Prints the node binary to use, downloading a private copy if the system one is missing or too old.
resolve_node() {
  if has node; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      ok "Using Node.js $(node -v)" >&2
      command -v node
      return
    fi
  fi

  # Official Node builds need glibc, so musl distros (Alpine) use their own package instead.
  if [ -f /etc/alpine-release ] && has apk; then
    info "Installing Node.js" >&2
    $SUDO apk add nodejs >&2
    ok "Using Node.js $(node -v)" >&2
    command -v node
    return
  fi

  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "Unsupported OS" ;; esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "Unsupported CPU: $(uname -m). Install Node.js $MIN_NODE_MAJOR+ yourself and run this again." ;;
  esac

  info "Downloading Node.js $NODE_MAJOR (private copy, only used by geohop)" >&2
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  local tmp file expected
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v[0-9.]*-${os}-${arch}\.tar\.gz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "No Node.js build found for $os-$arch"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  expected="$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  [ "$(sha256 "$tmp/$file")" = "$expected" ] || die "Node.js download failed its checksum"

  rm -rf "$INSTALL_DIR/node"
  mkdir -p "$INSTALL_DIR/node"
  tar -xzf "$tmp/$file" -C "$INSTALL_DIR/node" --strip-components 1
  rm -rf "$tmp"
  ok "Node.js $("$INSTALL_DIR/node/bin/node" -v) installed" >&2
  echo "$INSTALL_DIR/node/bin/node"
}

install_app() {
  info "Downloading geohop ($REF)"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" -o "$tmp/src.tar.gz"
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/app"
  mkdir -p "$INSTALL_DIR/app"
  tar -xzf "$tmp/src.tar.gz" -C "$INSTALL_DIR/app" --strip-components 1
  rm -rf "$tmp"
}

link_command() {
  local node="$1" launcher="$INSTALL_DIR/geohop"
  cat >"$launcher" <<EOF
#!/bin/sh
exec "$node" "$INSTALL_DIR/app/bin/geohop.js" "\$@"
EOF
  chmod +x "$launcher"

  if [ -w "$BIN_DIR" ] || { [ ! -e "$BIN_DIR" ] && [ -w "$(dirname "$BIN_DIR")" ]; }; then
    mkdir -p "$BIN_DIR" && ln -sf "$launcher" "$BIN_DIR/geohop"
  else
    info "Linking geohop into $BIN_DIR (needs your password)"
    $SUDO mkdir -p "$BIN_DIR" && $SUDO ln -sf "$launcher" "$BIN_DIR/geohop"
  fi
}

# geohop used to be called vpngate-cli and installed a `vpngate` command.
remove_legacy() {
  if [ -L "$BIN_DIR/vpngate" ] && readlink "$BIN_DIR/vpngate" | grep -q vpngate-cli; then
    info "Removing the old vpngate command (it's now geohop)"
    if [ -w "$BIN_DIR" ]; then rm -f "$BIN_DIR/vpngate"; else $SUDO rm -f "$BIN_DIR/vpngate"; fi
  fi
  rm -rf "$HOME/.local/share/vpngate-cli" "${XDG_CACHE_HOME:-$HOME/.cache}/vpngate-cli"
  # Old proxies would otherwise keep holding their ports, unseen by geohop.
  if has docker && docker info >/dev/null 2>&1; then
    old="$(docker ps -aq --filter label=vpngate-proxy)"
    [ -n "$old" ] && docker rm -f $old >/dev/null
    images="$(docker image ls -q 'vpngate-openvpn' 2>/dev/null; docker image ls -q 'vpngate-tor' 2>/dev/null; docker image ls -q 'vpngate-proxy' 2>/dev/null)"
    [ -n "$images" ] && docker image rm -f $images >/dev/null 2>&1
  fi
  return 0
}

uninstall() {
  remove_legacy
  info "Removing geohop"
  if [ -L "$BIN_DIR/geohop" ]; then
    if [ -w "$BIN_DIR" ]; then rm -f "$BIN_DIR/geohop"; else $SUDO rm -f "$BIN_DIR/geohop"; fi
  fi
  rm -rf "$INSTALL_DIR" "${XDG_CACHE_HOME:-$HOME/.cache}/geohop"
  ok "Uninstalled. OpenVPN was left installed; remove it with your package manager if you like."
}

main() {
  has curl || die "curl is required"
  if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    return
  fi

  printf '\n%sgeohop installer%s\n\n' "$BOLD" "$RESET"
  install_openvpn
  local node
  node="$(resolve_node)"
  install_app
  link_command "$node"
  remove_legacy
  "$BIN_DIR/geohop" --version >/dev/null || die "Install finished but geohop failed to run"

  ok "Installed! Try:"
  printf '\n  geohop countries\n  geohop proxy JP\n  geohop check https://example.com\n\n'
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) printf '%sNote: %s is not on your PATH. Add it, or run %s/geohop directly.%s\n' "$DIM" "$BIN_DIR" "$BIN_DIR" "$RESET" ;;
  esac
}

# Everything runs from main so a partially downloaded script never executes.
main "$@"
