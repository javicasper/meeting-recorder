#!/usr/bin/env bash
# Prepares what the installer ships next to the app: the backend (server + built UI +
# production node_modules) and an official Node binary as a Tauri sidecar.
set -euo pipefail
NODE_VERSION=v24.22.0
app=$(cd "$(dirname "$0")/.." && pwd)
tauri="$app/src-tauri"

npm --prefix "$app" run build

rm -rf "$tauri/backend"
mkdir -p "$tauri/backend/src"
cp -r "$app/server" "$app/dist" "$app/package.json" "$app/package-lock.json" "$tauri/backend/"
cp -r "$app/src/lib" "$tauri/backend/src/lib"
npm --prefix "$tauri/backend" ci --omit=dev --ignore-scripts --no-audit --no-fund

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) dist=linux-x64 ext=tar.xz triple=x86_64-unknown-linux-gnu ;;
  Darwin-arm64) dist=darwin-arm64 ext=tar.gz triple=aarch64-apple-darwin ;;
  Darwin-x86_64) dist=darwin-x64 ext=tar.gz triple=x86_64-apple-darwin ;;
  *) echo "Plataforma no soportada" >&2; exit 1 ;;
esac
sidecar="$tauri/binaries/node-$triple"
if [[ ! -x "$sidecar" ]]; then
  mkdir -p "$tauri/binaries"
  tmp=$(mktemp -d)
  name="node-$NODE_VERSION-$dist"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name.$ext" -o "$tmp/$name.$ext"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $name.$ext\$" SHASUMS256.txt | sha256sum -c -)
  tar -xf "$tmp/$name.$ext" -C "$tmp" "$name/bin/node"
  mv "$tmp/$name/bin/node" "$sidecar"
  rm -rf "$tmp"
fi
echo "Listo: backend en $tauri/backend, Node en $sidecar"
