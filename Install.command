#!/bin/bash
set -euo pipefail
TASK_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TASK_APP="${DSH_INSTALL_APP_BUNDLE:-}"
TASK_EXPECT_APP=0
for argument in "$@"; do
  if [ "$TASK_EXPECT_APP" -eq 1 ]; then TASK_APP="$argument"; TASK_EXPECT_APP=0; fi
  if [ "$argument" = "--app-bundle" ]; then TASK_EXPECT_APP=1; fi
done
if [ "$TASK_EXPECT_APP" -eq 1 ]; then echo "--app-bundle needs an application path."; exit 1; fi
if [ -z "$TASK_APP" ]; then
  for candidate in "/Applications/DeepSeek Harness.app" "$HOME/Applications/DeepSeek Harness.app"; do
    if [ -d "$candidate" ]; then TASK_APP="$candidate"; break; fi
  done
fi
TASK_RUNTIME=""
if [ -n "$TASK_APP" ]; then
  if [ ! -d "$TASK_APP" ]; then echo "The selected Harness app bundle does not exist."; exit 1; fi
  TASK_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$TASK_APP/Contents/Info.plist")"
  TASK_RUNTIME="$TASK_APP/Contents/MacOS/$TASK_EXECUTABLE"
  export DSH_INSTALL_APP_BUNDLE="$TASK_APP"
  export ELECTRON_RUN_AS_NODE=1
elif command -v node >/dev/null 2>&1; then
  TASK_RUNTIME="$(command -v node)"
else
  echo "Install DeepSeek Harness and open it once, or install Node.js 22 or newer, then run this installer again."
  exit 1
fi
echo "DeepSeek Harness plugins — Mac installer"
echo "Quit DeepSeek Harness completely. The installer selects the plugins included in this download."
echo "Archived-chat deletion alone needs no model server or key. Use --help for this download's options."
if [ "$#" -eq 0 ]; then
  "$TASK_RUNTIME" "$TASK_DIR/install.mjs" --apply
else
  "$TASK_RUNTIME" "$TASK_DIR/install.mjs" "$@"
fi
echo
if [ -t 0 ]; then read -r -p "Press Return to close this installer. " TASK_DONE; fi
