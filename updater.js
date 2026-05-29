/**
 * updater.js — 游戏式热更新模块
 * 流程：检测版本 → 推送弹窗 → 下载补丁包 → 解压覆盖 → 删除旧包 → 重启
 */

const { app, dialog } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const AdmZip = require('adm-zip');

// ====== 配置 ======
// 将此 URL 替换为你的 GitHub Releases version.json 原始地址
// 例: https://github.com/你的账号/seedream-desktop/releases/latest/download/version.json
const VERSION_CHECK_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/seedream-desktop/main/version.json';

// 当前应用版本（从 package.json 读取）
const CURRENT_VERSION = app.getVersion();

// 临时下载目录（%appdata%/seedream-desktop/update/）
const UPDATE_TEMP_DIR = path.join(app.getPath('userData'), 'update');

// ====== 版本比较工具 ======
function parseVersion(v) {
  return v.replace(/^v/, '').split('.').map(Number);
}

function isNewer(remoteV, localV) {
  const r = parseVersion(remoteV);
  const l = parseVersion(localV);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const ri = r[i] || 0;
    const li = l[i] || 0;
    if (ri > li) return true;
    if (ri < li) return false;
  }
  return false;
}

// ====== HTTP/HTTPS 通用 GET ======
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

// ====== 带进度的文件下载 ======
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    // 确保目录存在
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath, onProgress)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;

      const file = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        file.write(chunk);
        if (total > 0 && onProgress) {
          onProgress(Math.round((received / total) * 100), received, total);
        }
      });
      res.on('end', () => {
        file.close(() => resolve(destPath));
      });
      res.on('error', (err) => { file.close(); reject(err); });
    });
    req.on('error', reject);
  });
}

// ====== 解压并覆盖安装目录 ======
function applyUpdate(zipPath, mainWindow) {
  const installDir = path.dirname(app.getPath('exe'));

  // 如果是 asar 打包环境，目标是上层目录
  const targetDir = app.isPackaged ? installDir : path.join(__dirname);

  console.log('[Updater] 解压到:', targetDir);

  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    entries.forEach((entry, i) => {
      if (!entry.isDirectory) {
        const outPath = path.join(targetDir, entry.entryName);
        // 跳过系统保护文件
        if (outPath.includes('Uninstall') || outPath.includes('uninst')) return;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        zip.extractEntryTo(entry, path.dirname(outPath), false, true);
      }
      // 每解压一个文件通知进度
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-apply-progress', {
          current: i + 1,
          total: entries.length,
          percent: Math.round(((i + 1) / entries.length) * 100),
        });
      }
    });
  } catch (err) {
    throw new Error('解压失败: ' + err.message);
  }
}

// ====== 清理临时文件 ======
function cleanupTempFiles() {
  try {
    if (fs.existsSync(UPDATE_TEMP_DIR)) {
      fs.rmSync(UPDATE_TEMP_DIR, { recursive: true, force: true });
      console.log('[Updater] 临时文件已清理');
    }
  } catch (err) {
    console.warn('[Updater] 清理临时文件失败:', err.message);
  }
}

// ====== 重启应用 ======
function relaunchApp() {
  app.relaunch();
  app.exit(0);
}

// ====== 主入口: 检测并执行更新 ======
async function checkAndUpdate(mainWindow) {
  let versionInfo;

  // 1. 检测版本
  try {
    console.log('[Updater] 检测更新中...');
    versionInfo = await fetchJson(VERSION_CHECK_URL);
  } catch (err) {
    console.warn('[Updater] 版本检测失败:', err.message);
    return; // 静默失败，不打扰用户
  }

  const { version: remoteVersion, notes = '', downloadUrl, force = false } = versionInfo;

  // 2. 比较版本
  if (!isNewer(remoteVersion, CURRENT_VERSION)) {
    console.log(`[Updater] 已是最新版本 ${CURRENT_VERSION}`);
    return;
  }

  console.log(`[Updater] 发现新版本: ${remoteVersion} (当前: ${CURRENT_VERSION})`);

  // 3. 通知渲染进程弹出更新提示
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available', {
      version: remoteVersion,
      currentVersion: CURRENT_VERSION,
      notes,
      force,
      downloadUrl,
    });
  }
}

// ====== 执行完整更新流程（由渲染进程通过 IPC 触发）======
async function performUpdate(mainWindow, downloadUrl) {
  const zipName = path.basename(new URL(downloadUrl).pathname);
  const zipPath = path.join(UPDATE_TEMP_DIR, zipName);

  try {
    // 4. 下载补丁包
    console.log('[Updater] 开始下载:', downloadUrl);
    mainWindow.webContents.send('update-status', { phase: 'downloading', percent: 0 });

    await downloadFile(downloadUrl, zipPath, (percent, received, total) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          phase: 'downloading',
          percent,
          received,
          total,
        });
      }
    });

    console.log('[Updater] 下载完成:', zipPath);
    mainWindow.webContents.send('update-status', { phase: 'applying', percent: 0 });

    // 5. 解压合并
    applyUpdate(zipPath, mainWindow);

    // 6. 删除临时文件
    mainWindow.webContents.send('update-status', { phase: 'cleanup' });
    cleanupTempFiles();

    // 7. 完成 — 通知渲染进程可以重启
    mainWindow.webContents.send('update-status', { phase: 'done' });
    console.log('[Updater] 更新完成，等待用户重启');

  } catch (err) {
    console.error('[Updater] 更新失败:', err.message);
    cleanupTempFiles();
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { phase: 'error', message: err.message });
    }
  }
}

module.exports = { checkAndUpdate, performUpdate, relaunchApp };
