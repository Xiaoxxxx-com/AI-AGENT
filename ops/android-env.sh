#!/usr/bin/env bash
# Android 环境变量（Git Bash 会话内生效）
#
#   source ops/android-env.sh
#
# 注意：Git Bash 里 PATH 用冒号分隔，Windows 风格的 C:/... 直接拼进 PATH 会失效，
# 所以这里统一转成 /c/... 形式。

ANDROID_HOME_WIN="${ANDROID_HOME:-${LOCALAPPDATA:-C:/Users/$USER/AppData/Local}/Android/Sdk}"
ANDROID_HOME_WIN="${ANDROID_HOME_WIN//\\//}"
JDK_WIN="${JAVA_HOME:-$(ls -d "C:/Users/$USER/Android/jdk17/jdk-"* 2>/dev/null | head -1)}"

export JAVA_HOME="$JDK_WIN"
export ANDROID_HOME="$ANDROID_HOME_WIN"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

to_posix() { echo "/$(echo "$1" | sed 's|^\([A-Za-z]\):|/\L\1|; s|\\|/|g')"; }

for dir in "$JDK_WIN/bin" "$ANDROID_HOME/platform-tools" "$ANDROID_HOME/cmdline-tools/latest/bin"; do
  [ -d "$dir" ] || continue
  p="$(to_posix "$dir")"
  case ":$PATH:" in
    *":$p:"*) ;;
    *) PATH="$p:$PATH" ;;
  esac
done
export PATH

echo "JAVA_HOME    = $JAVA_HOME"
echo "ANDROID_HOME = $ANDROID_HOME"
command -v adb >/dev/null && echo "adb          = $(command -v adb)"
command -v android >/dev/null && echo "android      = $(command -v android)"
