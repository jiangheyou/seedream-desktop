# Seedream 4.5 v1.0.1 热更新操作指南

## 本次更新内容

### BUG 修复
1. **🔴 P0 - 验证 API Key 返回 400 错误**
   - 根因：validateApiKey() 测试图尺寸为 1024×1024（仅104万像素），低于API最低要求3686400像素
   - 修复：改回 2048×2048

2. **🟡 P1 - 同步信息不准确**
   - 问题：手动同步时本地计数器被清零；baseline 只在首次同步设置
   - 修复：用云端余额变化校准计数器，不再强制归零

## 推送步骤（需要 Git 环境）

### Step 1: 提交代码修改
```bash
cd C:\Users\29423\WorkBuddy\seedream-desktop
git add main.js preload.js proxy.js updater.js renderer/index.html version.json
git commit -m "fix: 验证API尺寸1024→2048 + 同步校准逻辑优化 (v1.0.1)"
```

### Step 2: 推送代码 + version.json 到 GitHub
```bash
git push origin main
```

### Step 3: 创建 GitHub Release v1.0.1

方式 A — 使用 GitHub CLI（gh）：
```bash
gh release create v1.0.1 ./dist/seedream-desktop-1.0.1.zip \
  --title "v1.0.1 - 验证BUG修复 + 同步校准" \
  --notes "## 更新内容
### 🔴 验证 API Key 400 错误修复
- validateApiKey() 测试图尺寸从 1024×1024 改回 2048×2048
- 原因：API 要求最小 3686400 像素（1920×1920）

### 🟡 同步信息准确性优化
- 手动同步不再清零本地计数器
- 用云端余额变化自动校准消耗计数
- 消耗计算优先使用云端数据"
```

方式 B — 使用 GitHub网页：
1. 打开 https://github.com/jiangheyou/seedream-desktop/releases/new
2. Tag: `v1.0.1` / Title: `v1.0.1`
3. 上传 `dist/seedream-desktop-1.0.1.zip`
4. 发布

### Step 4: 验证 version.json 已推送到 main 分支
```bash
curl -s https://raw.githubusercontent.com/jiangheyou/seedream-desktop/main/version.json
# 应该显示 "version": "1.0.1"
```

### Step 5: 客户端触发更新
- 打开已安装的 Seedream 4.5 应用
- 启动后 3 秒自动检测版本更新
- 或点击更新弹窗中的「立即更新」按钮

## 热更新系统工作原理
```
GitHub (version.json + zip) → 客户端检测到新版本 → 弹窗确认
  → 下载 zip 到 %appdata%/seedream-desktop/update/
  → AdmZip 解压覆盖安装目录 → 清理临时文件 → 重启应用
```

## 文件清单（zip 包含）
- `main.js` — Electron 主进程
- `preload.js` — 安全桥接层
- `proxy.js` — 火山引擎代理
- `updater.js` — 热更新模块（自身也参与更新）
- `renderer/index.html` — 前端核心（含所有 UI 和业务逻辑）
- `version.json` — 版本信息
