#!/bin/bash
set -euo pipefail
TASK_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
exec /bin/bash "$TASK_DIR/Install.command" --rollback
