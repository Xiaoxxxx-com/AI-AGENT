# Android 开发环境（本机实装记录）

> 安装时间：2026-10-20 · Windows 11 x64 · 免管理员（全部放在用户目录）

## 1. 装了什么

| 组件 | 版本 | 路径 |
| ---- | ---- | ---- |
| JDK（Temurin/Microsoft OpenJDK） | 17.0.20.1 LTS | `C:\Users\xiaohongwei\Android\jdk17\jdk-17.0.20.1+1` |
| Android SDK | — | `C:\Users\xiaohongwei\AppData\Local\Android\Sdk` |
| Command-line Tools | 23.0.0 | `%ANDROID_HOME%\cmdline-tools\latest` |
| Platform-Tools（adb） | 37.0.1 | `%ANDROID_HOME%\platform-tools` |
| Build-Tools | 36.1.0（AGP 会自动补 36.0.0） | `%ANDROID_HOME%\build-tools` |
| Platform | android-36 | `%ANDROID_HOME%\platforms\android-36` |

没有装 Android Studio。用新版 `android` CLI（`sdkmanager` 在 2026 版已标记废弃，功能被 `android sdk` 取代）。

## 2. 环境变量（已写入用户环境变量）

```text
JAVA_HOME          = C:\Users\xiaohongwei\Android\jdk17\jdk-17.0.20.1+1
ANDROID_HOME       = C:\Users\xiaohongwei\AppData\Local\Android\Sdk
ANDROID_SDK_ROOT   = 同上
PATH              += %JAVA_HOME%\bin
                     %ANDROID_HOME%\platform-tools
                     %ANDROID_HOME%\cmdline-tools\latest\bin
```

新开的终端会自动生效。旧终端里可以手动加载：

```powershell
. .\ops\android-env.ps1       # PowerShell
source ops/android-env.sh      # Git Bash
```

## 3. 验证

```powershell
java -version
adb version
android sdk list           # 已安装的 SDK 包
android info               # SDK 路径、连接设备、配置变量
```

## 4. 新建一个工程

```powershell
cd C:\Users\xiaohongwei\Android
android create empty-activity --name="Hello" --output=hello `
  --application-id=com.example.hello --min-sdk=26
cd hello
.\gradlew.bat assembleDebug
# 产物：app\build\outputs\apk\debug\app-debug.apk
```

模板只有一个：`empty-activity`（Compose + Kotlin，compileSdk 36，AGP 9，Gradle 9.1）。
需要传统 View 体系的话，直接在 `app/build.gradle.kts` 里改依赖，模板不必强求。

## 5. 装到手机

1. 手机打开「开发者选项 → USB 调试」，数据线连电脑
2. 手机上点「允许 USB 调试」
3. 验证：

```powershell
adb devices                 # 应看到设备号 + device
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

无线调试（Android 11+，同一 WiFi）：

```powershell
adb pair 192.168.1.x:端口    # 配对码在手机的「无线调试」里
adb connect 192.168.1.x:端口
```

## 6. 首次构建很慢怎么办

首次要下载 Gradle 9.1（约 140MB）+ AGP/Kotlin/Compose 依赖（数百 MB）。之后有缓存，增量构建很快。

想提速可以加国内镜像（可选，本项目未默认改）：

```kotlin
// settings.gradle.kts
pluginManagement {
  repositories {
    maven("https://maven.aliyun.com/repository/gradle-plugin")
    google(); mavenCentral(); gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositories {
    maven("https://maven.aliyun.com/repository/google")
    maven("https://maven.aliyun.com/repository/public")
    google(); mavenCentral()
  }
}
```

## 7. 已知提示与坑

| 提示 | 含义 / 处理 |
| ---- | ----------- |
| `This version only understands SDK XML versions up to 3 but ... version 4` | AGP 与 cmdline-tools 生成 SDK 元数据的版本不完全对齐。只是警告，构建能过；升级 AGP 或 command-line tools 之一即可消除 |
| `sdkmanager is deprecated` | 用 `android sdk install/list/remove` 代替。旧命令仍可用 |
| 模板要 build-tools 36.0.0 而我们装了 36.1.0 | AGP 发现版本不匹配会自动补装，属正常现象 |
| `C:\Users\xiaohongwei\Android\Sdk.orphan` | 安装过程中产生的一份重复 SDK（platforms/android-36 + licenses），已确认无用，可手动删除 |
| JDK 版本 | AGP 9 / Gradle 9 要求 JDK 17+。若以后升到 AGP 10，可能需要 JDK 21 |

## 8. 下一步（针对本项目）

这个环境只解决「能编译 APK」。要让它变成陪伴 App，有两条路：

- **最快**：WebView 壳 + 复用同一套 HTTP/SSE 接口。只需写一个 Web 版聊天页，Android 侧负责通知与保活。
- **长期**：Compose 原生 + OkHttp SSE + 前台服务。体验最好，但 UI 要重写一遍。

两条路都直接复用现有 Fastify 后端（`/chat/stream`、`/proactive/pending`、`/auth/dev`），后端不用改。
注意自用时接口地址填局域网 IP（`http://192.168.x.x:3000`），Android 9+ 默认禁止明文 HTTP，
需要在 `AndroidManifest.xml` 的 `<application>` 上加 `android:usesCleartextTraffic="true"`（或配 network_security_config 只放行该 IP）。
