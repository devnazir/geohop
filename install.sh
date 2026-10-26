#!/bin/sh
# vpngate-cli installer
#
#   curl -fsSL https://raw.githubusercontent.com/devnazir/vpngate-cli/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/devnazir/vpngate-cli/main/install.sh | sh -s -- --uninstall
#
# Installs OpenVPN (via your package manager), Node.js if a recent one is missing,
# and the `vpngate` command.

set -eu

REPO="devnazir/vpngate-cli"
REF="${VPNGATE_REF:-main}"
INSTALL_DIR="${VPNGATE_INSTALL_DIR:-$HOME/.local/share/vpngate-cli}"
BIN_DIR="${VPNGATE_BIN_DIR:-/usr/local/bin}"
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
    *) die "Unsupported OS: $(uname -s). vpngate-cli supports macOS and Linux." ;;
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

  info "Downloading Node.js $NODE_MAJOR (private copy, only used by vpngate)" >&2
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
  info "Downloading vpngate-cli ($REF)"
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
  local node="$1" launcher="$INSTALL_DIR/vpngate"
  cat >"$launcher" <<EOF
#!/bin/sh
exec "$node" "$INSTALL_DIR/app/bin/vpngate.js" "\$@"
EOF
  chmod +x "$launcher"

  if [ -w "$BIN_DIR" ] || { [ ! -e "$BIN_DIR" ] && [ -w "$(dirname "$BIN_DIR")" ]; }; then
    mkdir -p "$BIN_DIR" && ln -sf "$launcher" "$BIN_DIR/vpngate"
  else
    info "Linking vpngate into $BIN_DIR (needs your password)"
    $SUDO mkdir -p "$BIN_DIR" && $SUDO ln -sf "$launcher" "$BIN_DIR/vpngate"
  fi
}

uninstall() {
  info "Removing vpngate-cli"
  if [ -L "$BIN_DIR/vpngate" ]; then
    if [ -w "$BIN_DIR" ]; then rm -f "$BIN_DIR/vpngate"; else $SUDO rm -f "$BIN_DIR/vpngate"; fi
  fi
  rm -rf "$INSTALL_DIR" "${XDG_CACHE_HOME:-$HOME/.cache}/vpngate-cli"
  ok "Uninstalled. OpenVPN was left installed; remove it with your package manager if you like."
}

main() {
  has curl || die "curl is required"
  if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    return
  fi

  printf '\n%svpngate-cli installer%s\n\n' "$BOLD" "$RESET"
  install_openvpn
  local node
  node="$(resolve_node)"
  install_app
  link_command "$node"
  "$BIN_DIR/vpngate" --version >/dev/null || die "Install finished but vpngate failed to run"

  ok "Installed! Try:"
  printf '\n  vpngate countries\n  vpngate connect JP\n\n'
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) printf '%sNote: %s is not on your PATH. Add it, or run %s/vpngate directly.%s\n' "$DIM" "$BIN_DIR" "$BIN_DIR" "$RESET" ;;
  esac
}

# Everything runs from main so a partially downloaded script never executes.
main "$@"
