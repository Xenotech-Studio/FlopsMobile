# Flops 移动端

React Native 客户端，与 Web/桌面共用同一后端。详见仓库根 [README](../README.md)。

---

## 开发

```bash
npm install   # 或 yarn
yarn dev ios
# 或
yarn dev android
yarn dev android:real   # 仅真机
```

`yarn dev` 会起 Metro 并直接跑应用，无需另开终端。

---

## 正式包

```bash
yarn build                   # Android APK
yarn build android aab       # Android AAB
yarn build android upload    # 构建 APK 并上传到 Flops 后端
yarn build ios               # iOS IPA（development export，自己 Sideload）
yarn build ios testflight    # iOS IPA（app-store export）+ 自动上传 ASC → TestFlight
```

**前置：**

- **Android 签名**：打 Release 需 keystore。联系项目维护者获取 `flow.keystore` 与密码文件，放到 `~/.keystores/`（或设置 `FLOPS_KEYSTORE_PATH`、`FLOPS_PSW_PATH`）。Debug 不需要。
- **Android upload**：需配置 `FlopsMobile/upload-config.json`（gitignore），格式 `{ "FLOPS_SERVER_URL": "https://...", "FLOPS_ACCESS_TOKEN": "..." }`，或对应环境变量。上传后需在 Web 后台发布版本。
- **iOS 通用**：Xcode → Settings → Accounts 必须先登录有 Apple Developer Program 资格的 Apple ID，xcodebuild 才能用 `-allowProvisioningUpdates` 自动管理 development / distribution cert + profile。
- **iOS testflight**：
  - 配置 `FlopsMobile/ios-upload-config.json`（gitignore），参考 `ios-upload-config.example.json` 模板填 `ASC_API_KEY_ID` / `ASC_ISSUER_ID` / `ASC_API_KEY_PATH`
  - 在 App Store Connect → Users and Access → Integrations 创建 API Key（角色 App Manager），下载 `.p8` 放到 `Flops/secrets/AuthKey_<KEY_ID>.p8`；详见 `Flops/secrets/README.md`
  - 在 ASC My Apps 为 bundle id `com.xenotech.FlopsMobile` 创建 app record，TestFlight tab 加 Internal Testers（不需要 Beta App Review）
  - build number 自动用 UTC `YYYYMMDDHHMM` 注入 `CURRENT_PROJECT_VERSION`，无需手动 bump；同 marketing version 下永远递增
  - marketing version（括号前的数字）默认取自 `package.json` 的 `version`，通过 xcodebuild 覆盖 `MARKETING_VERSION`；也可设环境变量 `FLOPS_IOS_MARKETING_VERSION`（须为 `1.2.3` 这类格式；不支持 semver 后缀如 `-beta`）
  - 首次 archive 较慢（自动建 distribution cert + profile），后续缓存命中
