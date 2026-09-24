#!/usr/bin/env bash
# Cross-compile the browser for Windows x64 (MSVC ABI) from Linux.
#
# Toolchain: clang-cl (C/C++), lld-link (linker), llvm-lib (archiver) from LLVM, plus the
# MSVC CRT + Windows SDK headers/libs downloaded with `xwin splat --output $XWIN`
# (https://github.com/Jake-Shadle/xwin). The CRT is linked statically, so the resulting
# browser.exe has no runtime dependencies besides Windows itself.
#
# Usage: tools/build-windows.sh [extra cargo args]
set -euo pipefail
cd "$(dirname "$0")/.."
XWIN=${XWIN:-/home/claude/xwin}
LLVM_BIN=${LLVM_BIN:-/usr/lib/llvm-18/bin}
export PATH="$LLVM_BIN:$PATH"

T=x86_64_pc_windows_msvc
FLAGS="--target=x86_64-pc-windows-msvc -Wno-unused-command-line-argument -fuse-ld=lld-link \
 /imsvc$XWIN/crt/include /imsvc$XWIN/sdk/include/ucrt /imsvc$XWIN/sdk/include/um \
 /imsvc$XWIN/sdk/include/shared /imsvc$XWIN/sdk/include/winrt"
export "CC_${T}=clang-cl" "CXX_${T}=clang-cl" "AR_${T}=llvm-lib"
export "CFLAGS_${T}=$FLAGS" "CXXFLAGS_${T}=$FLAGS"
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=lld-link
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-C target-feature=+crt-static --cfg reqwest_unstable \
 -Lnative=$XWIN/crt/lib/x86_64 -Lnative=$XWIN/sdk/lib/um/x86_64 -Lnative=$XWIN/sdk/lib/ucrt/x86_64"
# Resource compiler for the exe icon/manifest (if any crate needs it).
export RC="llvm-rc"

cargo build --release --target x86_64-pc-windows-msvc -p browser-core -p browser-launcher "$@"
cargo xtask package --target x86_64-pc-windows-msvc
