#!/usr/bin/env bash
# 本地发布前验证：build → verify → pack → 临时安装 → 包内容校验 → 替换活跃本地安装。
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

npm_bin="${MOCK_OLLAMA_NPM_BIN:-npm}"
if ! command -v "$npm_bin" >/dev/null 2>&1; then
  echo "✗ 未找到 npm: $npm_bin" >&2
  exit 1
fi

# 依赖缺失时才安装，避免不必要地改变本地依赖树。
if [ ! -d node_modules ]; then
  echo "→ 安装依赖"
  "$npm_bin" install --no-fund --no-audit
fi

pkg_version="$(node -p "require('./package.json').version")"

active_command="$(command -v mock-ollama 2>/dev/null || true)"
active_link_target=""
active_direct_bin=""
active_realpath=""
if [ -n "$active_command" ]; then
  # npm 全局 bin 常直接链接到 runtime bin；先读取这一层，避免 realpath 继续解到包内入口。
  active_link_target="$(readlink "$active_command" 2>/dev/null || true)"
  case "$active_link_target" in
    /*/bin/mock-ollama)
      active_direct_bin="$active_link_target"
      ;;
  esac
  active_realpath="$(node -e '
const fs = require("node:fs");
process.stdout.write(fs.realpathSync(process.argv[1]));
' "$active_command" 2>/dev/null || true)"
fi

if [ -n "${MOCK_OLLAMA_INSTALL_PREFIX:-}" ]; then
  target_prefix="$MOCK_OLLAMA_INSTALL_PREFIX"
  install_reason="使用 MOCK_OLLAMA_INSTALL_PREFIX 覆盖"
elif [ -n "$active_direct_bin" ]; then
  target_prefix="${active_direct_bin%/bin/mock-ollama}"
  install_reason="根据活跃 mock-ollama 的直接链接目标"
elif [ -n "$active_realpath" ] && [ "${active_realpath%/bin/mock-ollama}" != "$active_realpath" ]; then
  target_prefix="${active_realpath%/bin/mock-ollama}"
  install_reason="根据活跃 mock-ollama 的解析路径"
else
  target_prefix="$("$npm_bin" config get prefix)"
  if [ -z "$target_prefix" ] || [ "$target_prefix" = "null" ]; then
    echo "✗ 无法通过 $npm_bin config get prefix 确定安装目录" >&2
    exit 1
  fi
  install_reason="活跃 mock-ollama 不可用或无法安全识别，使用 npm prefix"
fi

if [ -x "$target_prefix/bin/npm" ]; then
  install_npm_bin="$target_prefix/bin/npm"
else
  install_npm_bin="$npm_bin"
fi

echo "→ 构建 dist/"
"$npm_bin" run build

echo "→ 运行验证"
"$npm_bin" run verify

echo "→ 打包"
pack_json="$("$npm_bin" pack --json --loglevel=error)"
tgz="$(printf '%s' "$pack_json" | node -e '
const fs = require("node:fs");
const output = fs.readFileSync(0, "utf8");
const jsonStart = output.search(/[\[{]/);
if (jsonStart === -1) {
  throw new Error("npm pack --json 未返回 JSON 输出");
}
const result = JSON.parse(output.slice(jsonStart));
const packages = Array.isArray(result) ? result : Object.values(result);
if (packages.length !== 1 || typeof packages[0]?.filename !== "string" || !packages[0].filename.endsWith(".tgz")) {
  throw new Error("npm pack --json 未返回唯一的 .tgz 产物");
}
process.stdout.write(packages[0].filename);
')"

if [ ! -f "$tgz" ]; then
  echo "✗ 未找到打包产物: $tgz" >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/mock-ollama-package.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

echo "→ 在临时目录验证安装"
(
  cd "$tmp_dir"
  "$npm_bin" install --no-save "$ROOT/$tgz"
)
mock_ollama_bin="$tmp_dir/node_modules/.bin/mock-ollama"
if [ ! -x "$mock_ollama_bin" ]; then
  echo "✗ 未找到可执行文件: $mock_ollama_bin" >&2
  exit 1
fi

installed_version="$("$mock_ollama_bin" --version 2>/dev/null || true)"
if [ "$installed_version" != "$pkg_version" ]; then
  echo "✗ mock-ollama --version 返回 \"$installed_version\"，期望 \"$pkg_version\"" >&2
  exit 1
fi

archive_contents="$(tar -tzf "$tgz")"
for required_file in package/package.json package/dist/index.js package/dist/page.html package/README.md; do
  if ! printf '%s\n' "$archive_contents" | grep -Fqx "$required_file"; then
    echo "✗ 包中缺少必需文件: $required_file" >&2
    exit 1
  fi
done

for forbidden_path in package/src/ package/tests/ package/node_modules/; do
  if printf '%s\n' "$archive_contents" | grep -Fq "$forbidden_path"; then
    echo "✗ 包中包含不应发布的路径: $forbidden_path" >&2
    exit 1
  fi
done

echo "→ 替换本地安装"
echo "  原因: $install_reason"
echo "  目标: $target_prefix"
echo "  安装命令: vp install -g ."
if [ -n "$active_command" ]; then
  echo "  活跃命令: $active_command"
fi
if [ -n "$active_link_target" ]; then
  echo "  活跃命令直接链接目标: $active_link_target"
fi
if [ -n "$active_realpath" ]; then
  echo "  活跃命令解析路径: $active_realpath"
fi
if ! command -v vp >/dev/null 2>&1; then
  echo "✗ 未找到 vp，请先安装 vite-plus" >&2
  exit 1
fi
(
  cd "$ROOT"
  vp install -g .
)

target_mock_ollama_bin="$target_prefix/bin/mock-ollama"
if [ ! -x "$target_mock_ollama_bin" ]; then
  echo "✗ 未找到目标可执行文件: $target_mock_ollama_bin" >&2
  exit 1
fi

target_version="$("$target_mock_ollama_bin" --version 2>/dev/null || true)"
if [ "$target_version" != "$pkg_version" ]; then
  echo "✗ $target_mock_ollama_bin --version 返回 \"$target_version\"，期望 \"$pkg_version\"" >&2
  exit 1
fi

if [ -n "$active_direct_bin" ]; then
  active_version="$("$active_direct_bin" --version 2>/dev/null || true)"
  if [ "$active_version" != "$pkg_version" ]; then
    echo "✗ $active_direct_bin --version 返回 \"$active_version\"，期望 \"$pkg_version\"" >&2
    exit 1
  fi
elif [ -n "$active_realpath" ]; then
  active_version="$("$active_realpath" --version 2>/dev/null || true)"
  if [ "$active_version" != "$pkg_version" ]; then
    echo "✗ $active_realpath --version 返回 \"$active_version\"，期望 \"$pkg_version\"" >&2
    exit 1
  fi
fi

echo "✓ mock-ollama $pkg_version 已验证并安装"
echo "  产物: $tgz"
echo "  安装目标: $target_prefix"
echo "  最终版本: $target_version"
