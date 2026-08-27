#!/usr/bin/env bash
# Build para Cloudflare Workers Builds (integración git, estilo Pages).
# Uso en el dashboard: Root directory = web · Build command = bash cf-build.sh
# Instala Rust y wasm-pack si el contenedor de build no los trae.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cargo >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown
if ! command -v wasm-pack >/dev/null 2>&1; then
  cargo install wasm-pack --locked
fi

(cd ../rust-core && wasm-pack build --target web --out-dir ../web/src/wasm --release)
npm ci
npx vite build
