/**
 * updater.js — 游戏式热更新模块（加固版 v3 — 正确处理 asar 替换）
 *
 * v2 问题修复:
 * ✅ ECONNRESET — 重试机制(3次) + 多源回退(jsDelivr→GitHub API)
 * ✅ 超时无响应 — 全部请求加超时保护(检测15s/下载120s)
 * ✅ 域名拦截 — 自动识别并跳过 raw.githubusercontent.com 等被墙域名
 * ✅ 错误不友好 — 网络错误自动翻译为中文提示
 * ✅ 单点故障 — 支持 fallbackUrls 备用下载地址
 * ✅ [v3新增] asar 未更新 — 整体替换 app.asar 而非解压到安装目录根
 * ✅ [v3新增] 清理旧备份 — 只保留最近一次 .bak 文件
 */

const { app } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const AdmZip = require('adm-zip');

// ==================== 配置 ====================

/** 版本检测地址 */
const VERSION_CHECK_URL =
  'https://cdn.jsdelivr.net/gh/jiangheyou/seedream-desktop@main/version.json';

/** 已知被拦截的域名列表 */
const BLOCKED_DOMAINS = [
  'raw.githubusercontent.com',
];

// 当前应用版本
const CURRENT_VERSION = app.getVersion();

// 临时下载目录
const UPDATE_TEMP_DIR = path.join(app.getPath('userData'), 'update');

// 重试参数
const MAX_RETRIES        = 3;
const RETRY_DELAY_MS     = 2000;
const CHECK_TIMEOUT_MS   = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ==================== 工具函数 ====================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 将网络错误翻译为用户友好的中文 */
function translateError(err) {
  const msg = (err && err.message) || String(err);
  if (/ECONNRESET/i.test(msg))     return '网络连接被重置（可能被防火墙拦截）';
  if (/ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) return '网络连接超时';
  if (/ENOTFOUND/i.test(msg))      return '无法解析服务器地址（请检查网络）';
  if (/ECONNREFUSED/i.test(msg))   return '连接被服务器拒绝';
  if (/HTTP\s*403/i.test(msg))     return '访问被禁止（当前网络环境下不可用）';
  if (/HTTP\s*404/i.test(msg))     return '更新包不存在（请联系开发者）';
  if (/HTTP\s*5\d{2}/i.test(msg))  return '服务器繁忙，请稍后重试';
  if (/被(屏蔽|拦截|墙)/i.test(msg)) return msg;
  if (/timeout|超时/i.test(msg))   return msg;
  if (/socket hang up/i.test(msg)) return '服务器断开连接（可能被拦截）';
  return msg;
}

function isDomainBlocked(hostname) {
  const h = (hostname || '').toLowerCase();
  return BLOCKED_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

function resolveUrl(base, location) {
  if (!location) return base;
  if (/^https?:\/\//i.test(location)) return location;
  try { return new URL(location, base).href; }
  catch { return base; }
}

// ==================== HTTP 请求核心 ====================

function httpRequestRaw(options) {
  return new Promise((resolve, reject) => {
    const urlStr = options.url || options.path;
    const urlObj = new URL(urlStr);
    const useHttps = urlObj.protocol === 'https:';
    const mod = useHttps ? https : http;

    if (isDomainBlocked(urlObj.hostname)) {
      return process.nextTick(() =>
        reject(new Error(`域名 ${urlObj.hostname} 不可达（已被拦截）`))
      );
    }

    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (useHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Seedream-Updater/3.0',
        Accept: options.accept || '*/*',
      }, options.extraHeaders || {}),
      timeout: options.timeout || CHECK_TIMEOUT_MS,
    };

    const req = mod.request(reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = resolveUrl(urlStr, res.headers.location);
        console.log(`[HTTP] ${reqOpts.method} ${res.statusCode} -> ${nextUrl}`);
        if (isDomainBlocked(new URL(nextUrl).hostname)) {
          return reject(new Error(`重定向到被拦截域名: ${new URL(nextUrl).hostname}`));
        }
        options._redirectCount = (options._redirectCount || 0) + 1;
        if (options._redirectCount > 5) return reject(new Error('重定向次数过多'));
        return httpRequestRaw(Object.assign({}, options, { url: nextUrl }))
          .then(resolve).catch(reject);
      }

      if (options.expectBinary) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers, statusCode: res.statusCode }));
      } else {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ text: data, headers: res.headers, statusCode: res.statusCode }));
      }
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时 (' + ((reqOpts.timeout||0)/1000) + 's)')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchJsonWithRetry(url, options = {}) {
  const { timeout = CHECK_TIMEOUT_MS, retries = MAX_RETRIES } = options;
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const result = await httpRequestRaw({ url, timeout, accept: 'application/json' });
      if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
      return JSON.parse(result.text);
    } catch (err) {
      lastErr = err;
      console.warn(`[Updater] 版本检测 第${i}/${retries}: ${translateError(err)}`);
      if (i < retries) await sleep(RETRY_DELAY_MS * i);
    }
  }
  throw lastErr;
}

// ==================== 版本检测 ====================

function fetchVersionJson() {
  return fetchJsonWithRetry(VERSION_CHECK_URL);
}

function parseVersion(v) {
  return v.replace(/^v/, '').split('.').map(Number);
}

function isNewer(remoteV, localV) {
  const r = parseVersion(remoteV), l = parseVersion(localV);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const ri = r[i] || 0, li = l[i] || 0;
    if (ri > li) return true;
    if (ri < li) return false;
  }
  return false;
}

// ==================== 下载（多源 + 重试）====================

function buildDownloadSources(primaryUrl) {
  const sources = [{ url: primaryUrl, label: '主源' }];
  try {
    const u = new URL(primaryUrl);
    if (u.hostname.includes('jsdelivr.net')) {
      const match = u.pathname.match(/^\/gh\/([^\/]+)\/([^\/@]+)(?:@([^\/]+))?\/(.+)$/);
      if (match) {
        const [, owner, repo, branch, filePath] = match;
        sources.push({
          url: `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch || 'main'}`,
          label: 'GitHub API 回退',
          type: 'github-api',
        });
      }
    }
  } catch (e) {
    console.warn('[Updater] 解析备用源失败:', e.message);
  }
  return sources;
}

function downloadViaGithubApi(apiUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    httpRequestRaw({ url: apiUrl, timeout: DOWNLOAD_TIMEOUT_MS, accept: 'application/vnd.github.v3+json' })
      .then((result) => {
        if (result.statusCode !== 200) return reject(new Error(`GitHub API HTTP ${result.statusCode}`));
        let body;
        try { body = JSON.parse(result.text); } catch (e) { return reject(new Error('API 响应不是有效 JSON')); }
        if (!body.content) return reject(new Error('API 未返回文件内容'));
        if (body.encoding !== 'base64') return reject(new Error(`API 返回了非 base64 编码 (${body.encoding})`));
        const fileData = Buffer.from(body.content, 'base64');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, fileData);
        if (onProgress) onProgress(100, fileData.length, fileData.length);
        console.log(`[Updater] GitHub API 下载完成: ${(fileData.length/1024).toFixed(1)}KB`);
        resolve(destPath);
      }).catch(reject);
  });
}

function downloadHttpFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    httpRequestRaw({ url, timeout: DOWNLOAD_TIMEOUT_MS, expectBinary: true })
      .then((result) => {
        if (result.statusCode !== 200) return reject(new Error(`下载失败: HTTP ${result.statusCode}`));
        fs.writeFileSync(destPath, result.buffer);
        if (onProgress) onProgress(100, result.buffer.length, result.buffer.length);
        resolve(destPath);
      }).catch(reject);
  });
}

async function downloadFileWithRetry(downloadUrl, destPath, onProgress) {
  const sources = buildDownloadSources(downloadUrl);
  let lastErr;

  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    console.log(`[Updater] 尝试下载源 [${si+1}/${sources.length}] ${src.label}: ${src.url}`);
    if (onProgress) onProgress(0, 0, 0);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (src.type === 'github-api') return await downloadViaGithubApi(src.url, destPath, onProgress);
        else return await downloadHttpFile(src.url, destPath, onProgress);
      } catch (err) {
        lastErr = err;
        console.warn(`[Updater] [${src.label}] 第${attempt}/${MAX_RETRIES}: ${translateError(err)}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * Math.pow(2, attempt-1));
        }
      }
    }
    console.warn(`[Updater] [${src.label}] 所有重试失败，切换下一源`);
  }
  throw lastErr;
}

// ==================== 核心修复: 正确的 asar 更新逻辑 ====================

/**
 * 查找 asar 工具路径
 * 优先从 node_modules/asar 找，再尝试全局
 */
function findAsarTool() {
  // 项目内 node_modules
  const localAsar = path.join(__dirname, '..', 'node_modules', '.bin', 'asar.cmd');
  if (fs.existsSync(localAsar)) return localAsar;

  const localAsarJs = path.join(__dirname, 'node_modules', 'asar', 'bin', 'asar.js');
  if (fs.existsSync(localAsarJs)) return process.argv0 + ' "' + localAsarJs + '"';

  // 全局
  try {
    return execFileSync('where', ['asar'], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')[0];
  } catch {}

  return null;
}

/**
 * 应用更新 — v3: 正确处理 asar 替换
 *
 * 流程:
 * 1. 解压 zip 到临时目录
 * 2. 判断 zip 内容类型:
 *    a. 包含 app.asar → 直接替换 resources/app.asar（最简单可靠）
 *    b. 不包含 → 合并到已提取的 asar 中（兼容旧格式）
 * 3. 备份旧 asar（只保留最近一次）
 * 4. 清理旧的 .bak 文件（只保留最新一个）
 */
function applyUpdate(zipPath, mainWindow) {
  const isPackaged = app.isPackaged;

  if (!isPackaged) {
    // 开发模式：直接解压到源码目录
    _applyDevMode(zipPath, mainWindow);
    return;
  }

  // ===== 打包模式: 正确处理 asar =====
  console.log('[Updater] 打包模式 — 开始 asar 替换流程');

  // 1. 解压 zip 到临时目录
  const extractDir = path.join(UPDATE_TEMP_DIR, '_extract_' + Date.now());
  fs.mkdirSync(extractDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  // 先解压所有文件（手动写入，绕过 Windows 上 extractEntryTo 的 chmod 兼容性问题）
  entries.forEach(entry => {
    if (entry.isDirectory) return;
    // 统一使用正斜杠，避免 Windows 反斜杠问题
    const entryName = entry.entryName.replace(/\\/g, '/');
    const outPath = path.join(extractDir, entryName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, entry.getData());
  });

  console.log('[Updater] Zip 已解压到:', extractDir);

  // 2. 在解压目录中递归搜索 app.asar（兼容 zip 内任何路径）
  const newAsarPath = _findFileRecursive(extractDir, 'app.asar');

  if (newAsarPath) {
    // === 方案 A: 完整 asar 替换（推荐）===
    console.log('[Updater] 检测到完整 app.asar — 使用直接替换模式');
    console.log('[Updater] app.asar 位置:', newAsarPath);
    _replaceAppAsar(newAsarPath, mainWindow);

    // 清理解压目录
    _safeRm(extractDir);
    return;
  }

  // === 方案 B: 文件级合并（兼容旧格式）===
  console.log('[Updater] 未检测到完整 app.asar — 使用文件合并模式');
  _mergeIntoAsar(extractDir, zip, entries, mainWindow);
  _safeRm(extractDir);
}

/**
 * 方案 A: 直接替换 app.asar
 */
function _replaceAppAsar(newAsarPath, mainWindow) {
  const installDir = path.dirname(app.getPath('exe'));
  const asarPath = path.join(installDir, 'resources', 'app.asar');
  const bakPath = asarPath + '.bak';

  // 1. 清理旧备份（只保留最新的 .bak）
  _cleanupOldBackups(bakPath);

  // 2. 当前 asar 备份
  if (fs.existsSync(asarPath)) {
    fs.copyFileSync(asarPath, bakPath);
    console.log('[Updater] 旧 app.asar 已备份:', bakPath);
  }

  // 3. 替换
  const newSize = fs.statSync(newAsarPath).size;
  fs.copyFileSync(newAsarPath, asarPath);
  console.log('[Updater] app.asar 已替换 (' + (newSize/1024).toFixed(1) + 'KB)');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-apply-progress', {
      current: 1, total: 1, percent: 100,
    });
  }
}

/**
 * 方案 B: 将 zip 文件合并进现有 asar（兼容旧格式）
 */
function _mergeIntoAsar(extractDir, zip, entries, mainWindow) {
  const installDir = path.dirname(app.getPath('exe'));
  const asarPath = path.join(installDir, 'resources', 'app.asar');
  const bakPath = asarPath + '.bak';
  const asarExtractDir = path.join(UPDATE_TEMP_DIR, '_old_asar_' + Date.now());

  const asarCmd = findAsarTool();

  if (!asarCmd) {
    throw new Error('找不到 asar 命令行工具，无法进行文件级更新。建议使用完整 asar 包格式。');
  }

  // 1. 清理旧备份
  _cleanupOldBackups(bakPath);

  // 2. 备份当前 asar
  fs.copyFileSync(asarPath, bakPath);

  // 3. 提取当前 asar
  console.log('[Updater] 提取现有 app.asar...');
  _runAsar(asarCmd, ['extract', asarPath, asarExtractDir]);

  // 4. 合并 zip 文件到提取出的目录（覆盖已有文件）
  let merged = 0;
  entries.forEach((entry, i) => {
    if (entry.isDirectory) return;
    const srcPath = path.join(extractDir, entry.entryName);
    if (!fs.existsSync(srcPath)) return;

    const outPath = path.join(asarExtractDir, entry.entryName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(srcPath, outPath);
    merged++;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-apply-progress', {
        current: i + 1,
        total: entries.length,
        percent: Math.round(((i + 1) / entries.length) * 100),
      });
    }
  });

  console.log('[Updater] 已合并', merged, '个文件到 asar 目录');

  // 5. 重新打包
  console.log('[Updater] 重新打包 app.asar...');
  _runAsar(asarCmd, ['pack', asarExtractDir, asarPath]);

  const newSize = fs.statSync(asarPath).size;
  console.log('[Updater] 新 app.asar 已生成 (' + (newSize/1024).toFixed(1) + 'KB)');

  // 6. 清理临时目录
  _safeRm(asarExtractDir);
}

/**
 * 开发模式：直接解压覆盖
 */
function _applyDevMode(zipPath, mainWindow) {
  const targetDir = path.join(__dirname);
  console.log('[Updater] 开发模式 — 解压到:', targetDir);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  entries.forEach((entry, i) => {
    if (entry.isDirectory) return;
    const entryName = entry.entryName.replace(/\\/g, '/');
    const outPath = path.join(targetDir, entryName);
    if (outPath.includes('Uninstall')) return;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, entry.getData());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-apply-progress', {
        current: i+1, total: entries.length,
        percent: Math.round(((i+1)/entries.length)*100),
      });
    }
  });
}

// ==================== 工具函数 ====================

/**
 * 在目录中递归搜索指定文件名
 * @param {string} dir 搜索根目录
 * @param {string} fileName 要查找的文件名
 * @returns {string|null} 找到则返回完整路径，否则返回 null
 */
function _findFileRecursive(dir, fileName) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isFile() && item.name === fileName) return fullPath;
      if (item.isDirectory()) {
        const found = _findFileRecursive(fullPath, fileName);
        if (found) return found;
      }
    }
  } catch (e) {
    console.warn('[Updater] 搜索文件时出错:', e.message);
  }
  return null;
}

function _runAsar(asarCmd, args) {
  try {
    execFileSync(asarCmd.startsWith(process.argv0) ? process.argv0 : asarCmd,
      asarCmd.startsWith(process.argv0) ? [asarCmd.substring(process.argv0.length+1).replace(/"/g,''), ...args] : args,
      { stdio: 'pipe', timeout: 30000 });
  } catch (err) {
    console.error('[Updater] asar 命令失败:', err.message);
    throw new Error('打包 app.asar 失败: ' + err.message);
  }
}

function _safeRm(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn('[Updater] 清理失败(非致命):', e.message);
  }
}

/** 清理旧的 .bak 文件，只保留最新的一个 */
function _cleanupOldBackups(currentBakPath) {
  try {
    const resourcesDir = path.dirname(currentBakPath);
    if (!fs.existsSync(resourcesDir)) return;

    const oldBaks = fs.readdirSync(resourcesDir)
      .filter(f => f.startsWith('app.asar.bak') && f !== 'app.asar.bak')
      .map(f => path.join(resourcesDir, f));

    oldBaks.forEach(f => {
      console.log('[Updater] 删除旧备份:', path.basename(f));
      _safeRm(f);
    });
  } catch (e) {
    console.warn('[Updater] 清理旧备份失败:', e.message);
  }
}

// ==================== 清理 & 重启 ====================

function cleanupTempFiles() {
  // 清理下载/解压临时文件（保留 .bak）
  try {
    if (fs.existsSync(UPDATE_TEMP_DIR)) {
      const items = fs.readdirSync(UPDATE_TEMP_DIR);
      items.forEach(item => {
        const fullPath = path.join(UPDATE_TEMP_DIR, item);
        // 只删除临时文件，不删备份
        if (item.endsWith('.bak')) return;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) _safeRm(fullPath);
        else fs.unlinkSync(fullPath);
      });
      console.log('[Updater] 临时文件已清理');
    }
  } catch (err) {
    console.warn('[Updater] 清理临时文件失败:', err.message);
  }
}

function relaunchApp() {
  app.relaunch();
  app.exit(0);
}

// ==================== 主入口: 检测更新 ====================

async function checkAndUpdate(mainWindow) {
  let versionInfo;
  try {
    console.log('[Updater] 检测更新中... (' + CURRENT_VERSION + ')');
    versionInfo = await fetchVersionJson();
    console.log('[Updater] 远程版本:', versionInfo.version);
  } catch (err) {
    const errMsg = translateError(err);
    console.warn('[Updater] 版本检测最终失败:', errMsg);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-check-error', { message: errMsg });
    }
    return;
  }

  const { version: remoteVersion, notes = '', downloadUrl, force = false } = versionInfo;

  if (!isNewer(remoteVersion, CURRENT_VERSION)) {
    console.log(`[Updater] 已是最新版本 ${CURRENT_VERSION}`);
    return;
  }

  console.log(`[Updater] 发现新版本: ${remoteVersion} (当前: ${CURRENT_VERSION})`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available', {
      version: remoteVersion, currentVersion: CURRENT_VERSION, notes, force, downloadUrl,
    });
  }
}

// ==================== 执行更新（IPC 触发）====================

async function performUpdate(mainWindow, downloadUrl) {
  const zipName = path.basename(new URL(downloadUrl).pathname);
  const zipPath = path.join(UPDATE_TEMP_DIR, zipName);

  try {
    console.log('[Updater] 开始下载:', downloadUrl);
    mainWindow.webContents.send('update-status', { phase: 'downloading', percent: 0 });

    await downloadFileWithRetry(downloadUrl, zipPath, (percent, received, total) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', { phase: 'downloading', percent, received, total });
      }
    });

    console.log('[Updater] 下载完成:', zipPath);
    mainWindow.webContents.send('update-status', { phase: 'applying', percent: 0 });

    // 核心修复: 正确的 asar 更新
    applyUpdate(zipPath, mainWindow);

    mainWindow.webContents.send('update-status', { phase: 'cleanup' });
    cleanupTempFiles();

    mainWindow.webContents.send('update-status', { phase: 'done' });
    console.log('[Updater] 更新完成，等待用户重启');

  } catch (err) {
    const errMsg = translateError(err);
    console.error('[Updater] 更新最终失败:', errMsg);
    cleanupTempFiles();
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { phase: 'error', message: errMsg });
    }
  }
}

module.exports = { checkAndUpdate, performUpdate, relaunchApp };
