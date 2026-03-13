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
yarn build              # Android APK
yarn build android aab  # Android AAB
yarn build ios          # iOS IPA
yarn build android upload   # 构建 APK 并上传到 Flops 后端
```

**前置：**

- **Android 签名**：打 Release 需 keystore。联系项目维护者获取 `flow.keystore` 与密码文件，放到 `~/.keystores/`（或设置 `FLOPS_KEYSTORE_PATH`、`FLOPS_PSW_PATH`）。Debug 不需要。
- **上传**：`upload` 需配置 `FlopsMobile/upload-config.json`（gitignore），格式 `{ "FLOPS_SERVER_URL": "https://...", "FLOPS_ACCESS_TOKEN": "..." }`，或对应环境变量。上传后需在 Web 后台发布版本。
