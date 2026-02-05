#!/usr/bin/env bash
set -e

# ── DoctorClaw Installer ────────────────────────────────────────────────────
# Works on macOS and Linux. Installs Node.js if not found, runs npm install,
# and starts DoctorClaw.
# ─────────────────────────────────────────────────────────────────────────────

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

REQUIRED_NODE_MAJOR=18
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}  🩺 DoctorClaw Installer${RESET}"
  echo -e "${DIM}  ─────────────────────────────────${RESET}"
  echo ""
}

info()    { echo -e "  ${CYAN}ℹ${RESET}  $1"; }
success() { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail()    { echo -e "  ${RED}✗${RESET}  $1"; exit 1; }

# ── Detect OS ───────────────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Linux*)  OS="linux" ;;
    Darwin*) OS="macos" ;;
    *)       fail "Unsupported operating system: $(uname -s). Use install.bat for Windows." ;;
  esac
  success "Detected OS: ${BOLD}${OS}${RESET}"
}

# ── Check / Install Node.js ────────────────────────────────────────────────

check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver="$(node -v | sed 's/v//')"
    local major
    major="$(echo "$ver" | cut -d. -f1)"
    if [ "$major" -ge "$REQUIRED_NODE_MAJOR" ]; then
      success "Node.js ${BOLD}v${ver}${RESET} found"
      return 0
    else
      warn "Node.js v${ver} found but v${REQUIRED_NODE_MAJOR}+ is required"
      return 1
    fi
  else
    warn "Node.js not found"
    return 1
  fi
}

install_node() {
  info "Installing Node.js..."
  echo ""

  if [ "$OS" = "macos" ]; then
    # Try Homebrew first
    if command -v brew &>/dev/null; then
      info "Installing via Homebrew..."
      brew install node
    else
      info "Homebrew not found. Installing via official installer..."
      info "Downloading Node.js LTS..."
      local arch
      arch="$(uname -m)"
      if [ "$arch" = "arm64" ]; then
        arch="arm64"
      else
        arch="x64"
      fi
      local url="https://nodejs.org/dist/v20.18.0/node-v20.18.0-darwin-${arch}.tar.gz"
      local tmp="/tmp/node-install.tar.gz"
      curl -fSL "$url" -o "$tmp" || fail "Failed to download Node.js"
      sudo mkdir -p /usr/local/lib/nodejs
      sudo tar -xzf "$tmp" -C /usr/local/lib/nodejs
      local node_dir="/usr/local/lib/nodejs/node-v20.18.0-darwin-${arch}"
      sudo ln -sf "$node_dir/bin/node" /usr/local/bin/node
      sudo ln -sf "$node_dir/bin/npm" /usr/local/bin/npm
      sudo ln -sf "$node_dir/bin/npx" /usr/local/bin/npx
      rm -f "$tmp"
    fi

  elif [ "$OS" = "linux" ]; then
    # Try package managers in order
    if command -v apt-get &>/dev/null; then
      info "Installing via apt (NodeSource)..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || fail "Failed to add NodeSource repo"
      sudo apt-get install -y nodejs || fail "Failed to install Node.js"

    elif command -v dnf &>/dev/null; then
      info "Installing via dnf (NodeSource)..."
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash - || fail "Failed to add NodeSource repo"
      sudo dnf install -y nodejs || fail "Failed to install Node.js"

    elif command -v yum &>/dev/null; then
      info "Installing via yum (NodeSource)..."
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash - || fail "Failed to add NodeSource repo"
      sudo yum install -y nodejs || fail "Failed to install Node.js"

    elif command -v pacman &>/dev/null; then
      info "Installing via pacman..."
      sudo pacman -Sy --noconfirm nodejs npm || fail "Failed to install Node.js"

    else
      fail "No supported package manager found (apt, dnf, yum, pacman). Please install Node.js v${REQUIRED_NODE_MAJOR}+ manually from https://nodejs.org"
    fi
  fi

  # Verify
  if command -v node &>/dev/null; then
    success "Node.js $(node -v) installed successfully"
  else
    fail "Node.js installation failed. Please install manually from https://nodejs.org"
  fi
}

# ── Check / Install npm packages ───────────────────────────────────────────

install_deps() {
  cd "$SCRIPT_DIR"

  if [ ! -f "package.json" ]; then
    fail "package.json not found in ${SCRIPT_DIR}. Make sure this script is in the DoctorClaw directory."
  fi

  if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
    success "Dependencies already installed"
  else
    info "Installing dependencies..."
    npm install || fail "npm install failed"
    success "Dependencies installed"
  fi
}

# ── Check Ollama ────────────────────────────────────────────────────────────

check_ollama() {
  if command -v ollama &>/dev/null; then
    success "Ollama found at $(command -v ollama)"
  else
    warn "Ollama not installed. DoctorClaw needs Ollama to run."
    echo ""
    echo -e "  ${DIM}Install Ollama from: ${CYAN}https://ollama.com${RESET}"
    echo -e "  ${DIM}Then pull a model:   ${CYAN}ollama pull glm-4.7:cloud${RESET}"
    echo ""
  fi
}

# ── Start ───────────────────────────────────────────────────────────────────

start_server() {
  cd "$SCRIPT_DIR"
  echo ""
  echo -e "${GREEN}${BOLD}  ✓ Install complete!${RESET}"
  echo ""

  if [ -f "doctorclaw.config.json" ]; then
    echo -e "  ${DIM}Config already exists. Starting DoctorClaw...${RESET}"
    echo ""
    node server.mjs
  else
    echo -e "  ${DIM}Starting first-time setup...${RESET}"
    echo ""
    node server.mjs -i
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

banner
detect_os

if ! check_node; then
  echo ""
  read -rp "  Install Node.js now? [Y/n] " answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Yy] ]]; then
    install_node
  else
    fail "Node.js v${REQUIRED_NODE_MAJOR}+ is required. Install it from https://nodejs.org"
  fi
fi

echo ""
install_deps
check_ollama
start_server
