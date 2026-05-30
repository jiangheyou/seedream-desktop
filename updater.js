/**
 * updater.js — 全量安装包更新模块 v4
 *
 * v4 更新策略（彻底告别 asar 替换）:
 * ✅ 下载新版安装包 .exe（NSIS）
 * ✅ 静默安装 /S 参数，覆盖旧版本，用户无感知
 * ✅ 国内主源: Gitee（速度快，无需翻墙）
 * ✅ 海外备源: jsDelivr CDN → GitHub API
 * ✅ 版本检测也走 Gitee 主源，jsDelivr 为备
 * ✅ 下载进度实时上报
 * ✅ 多源重试 + 超时保护
 */

const { app } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('original-fs') || require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ==================== 配置 ====================

/**
 * 版本检测 URL 列表（按优先级排列）
 * jsDelivr CDN 在国内速度快且稳定，作为主源
 * Gitee 作为备源（有时会返回 403）
 */
const VERSION_CHECK_URLS = [
  'https://cdn.jsdelivr.net/gh/jiangheyou/seedream-desktop@main/version.json',
  'https://gitee.com/jiang-heyou/seedream-4.5/raw/main/version.json',
];

/** 已知被拦截/不稳定的域名 */
const BLOCKED_DOMAINS = [
  'raw.githubusercontent.com',
];

// 当前版本
const CURRENT_VERSION = app.getVersion();

// 临时下载目录
const UPDATE_TEMP_DIR = path.join(app.getPath('userData'), 'update');

// 重试/超时参数
const MAX_RETRIES         = 3;
const RETRY_DELAY_MS      = 2000;
const CHECK_TIMEOUT_MS    = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;  // exe 比 asar 大，给 3 分钟

// ==================== 工具函数 ====================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function translateError(err) {
  const msg = (err && err.message) || String(err);
  if (/ECONNRESET/i.test(msg))     return '网络连接被重置（可能被防火墙拦截）';
  if (/ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) return '网络连接超时';
  if (/ENOTFOUND/i.test(msg))      return '无法解析服务器地址（请检查网络）';
  if (/ECONNREFUSED/i.test(msg))   return '连接被服务器拒绝';
  if (/HTTP\s*403/i.test(msg))     return '访问被禁止（当前网络环境下不可用）';
  if (/HTTP\s*404/i.test(msg))     return '安装包不存在（请联系开发者）';
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

// ==================== HTTP 核心 ====================

/**
 * 带重定向跟踪的原始 HTTP 请求
 * expectBinary: true 时返回 Buffer，否则返回 text 字符串
 */
function httpRequestRaw(options) {
  return new Promise((resolve, reject) => {
    const urlStr = options.url;
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
        'User-Agent': 'Seedream-Updater/4.0',
        Accept: options.accept || '*/*',
      }, options.extraHeaders || {}),
      timeout: options.timeout || CHECK_TIMEOUT_MS,
    };

    const req = mod.request(reqOpts, (res) => {
      // 重定向处理
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = resolveUrl(urlStr, res.headers.location);
        console.log(`[HTTP] ${res.statusCode} -> ${nextUrl}`);
        if (isDomainBlocked(new URL(nextUrl).hostname)) {
          return reject(new Error(`重定向到被拦截域名: ${new URL(nextUrl).hostname}`));
        }
        options._redirectCount = (options._redirectCount || 0) + 1;
        if (options._redirectCount > 5) return reject(new Error('重定向次数过多'));
        return httpRequestRaw(Object.assign({}, options, { url: nextUrl }))
          .then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (options.onData) options.onData(c, chunks);
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentLength = res.headers['content-length'];
        if (contentLength && buffer.length !== parseInt(contentLength, 10)) {
          return reject(new Error(
            `响应不完整: 收到 ${buffer.length} 字节, 期望 ${contentLength} 字节`
          ));
        }
        if (options.expectBinary) {
          resolve({ buffer, headers: res.headers, statusCode: res.statusCode });
        } else {
          resolve({ text: buffer.toString('utf8'), headers: res.headers, statusCode: res.statusCode });
        }
      });
      res.on('error', (err) => reject(new Error('响应流错误: ' + err.message)));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时 (' + ((reqOpts.timeout || 0) / 1000) + 's)'));
    });
    req.end();
  });
}

// ==================== 版本检测 ====================

/**
 * 从多个 URL 逐个尝试拉取 version.json
 * 先 Gitee，再 jsDelivr
 */
async function fetchVersionJson() {
  let lastErr;
  for (const baseUrl of VERSION_CHECK_URLS) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = baseUrl + sep + '_t=' + Date.now();
    for (let i = 1; i <= MAX_RETRIES; i++) {
      try {
        console.log(`[Updater] 检测版本 [${VERSION_CHECK_URLS.indexOf(baseUrl)+1}/${VERSION_CHECK_URLS.length}]: ${baseUrl}`);
        const result = await httpRequestRaw({ url, timeout: CHECK_TIMEOUT_MS });
        if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
        return JSON.parse(result.text);
      } catch (err) {
        lastErr = err;
        console.warn(`[Updater] 版本检测 第${i}/${MAX_RETRIES}: ${translateError(err)}`);
        if (i < MAX_RETRIES) await sleep(RETRY_DELAY_MS * i);
      }
    }
    console.warn('[Updater] 该源所有重试失败，切换下一源...');
  }
  throw lastErr;
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

// ==================== 下载安装包（带进度）====================

/**
 * 构建下载源列表
 * version.json 中的 downloadUrl 是主源（Gitee）
 * fallbackUrls 是备源列表（jsDelivr / GitHub API）
 */
function buildDownloadSources(versionInfo) {
  const sources = [];

  // 主源
  if (versionInfo.downloadUrl) {
    sources.push({ url: versionInfo.downloadUrl, label: '主源(Gitee)' });
  }

  // 备源（version.json 中可选字段）
  if (Array.isArray(versionInfo.fallbackUrls)) {
    versionInfo.fallbackUrls.forEach((url, i) => {
      sources.push({ url, label: `备源${i + 1}` });
    });
  }

  return sources;
}

/**
 * 流式下载大文件（支持实时进度回调）
 * onProgress(percent, received, total)
 */
function streamDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = destPath + '.tmp';
    const writeStream = fs.createWriteStream(tmpPath);

    const urlObj = new URL(url);
    const useHttps = urlObj.protocol === 'https:';
    const mod = useHttps ? https : http;

    if (isDomainBlocked(urlObj.hostname)) {
      return reject(new Error(`域名 ${urlObj.hostname} 不可达（已被拦截）`));
    }

    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (useHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': 'Seedream-Updater/4.0' },
      timeout: DOWNLOAD_TIMEOUT_MS,
    };

    function doRequest(currentUrl, redirectCount) {
      const obj = new URL(currentUrl);
      const mod2 = obj.protocol === 'https:' ? https : http;
      const opts2 = Object.assign({}, reqOpts, {
        hostname: obj.hostname,
        port: obj.port || (obj.protocol === 'https:' ? 443 : 80),
        path: obj.pathname + obj.search,
      });

      const req = mod2.request(opts2, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = resolveUrl(currentUrl, res.headers.location);
          console.log(`[Download] ${res.statusCode} -> ${nextUrl}`);
          if ((redirectCount || 0) >= 5) return reject(new Error('重定向次数过多'));
          res.resume();
          return doRequest(nextUrl, (redirectCount || 0) + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          writeStream.write(chunk);
          if (onProgress && total > 0) {
            onProgress(Math.round((received / total) * 100), received, total);
          } else if (onProgress) {
            // 没有 content-length，只上报已下载量
            onProgress(-1, received, 0);
          }
        });

        res.on('end', () => {
          writeStream.end(() => {
            // 最终完整性检测
            if (total > 0 && received !== total) {
              fs.unlink(tmpPath, () => {});
              return reject(new Error(`下载不完整: 收到 ${received} / ${total} 字节`));
            }
            // 重命名 .tmp → 正式文件
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              fs.renameSync(tmpPath, destPath);
            } catch (e) {
              return reject(new Error('临时文件重命名失败: ' + e.message));
            }
            if (onProgress) onProgress(100, received, total || received);
            console.log(`[Download] 完成: ${(received / 1024 / 1024).toFixed(2)} MB`);
            resolve(destPath);
          });
        });

        res.on('error', (err) => {
          writeStream.destroy();
          fs.unlink(tmpPath, () => {});
          reject(new Error('下载流错误: ' + err.message));
        });
      });

      req.on('error', (err) => {
        writeStream.destroy();
        fs.unlink(tmpPath, () => {});
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        writeStream.destroy();
        fs.unlink(tmpPath, () => {});
        reject(new Error('下载超时'));
      });
      req.end();
    }

    doRequest(url, 0);
  });
}

async function downloadWithRetry(sources, destPath, onProgress) {
  let lastErr;
  for (const src of sources) {
    console.log(`[Updater] 尝试下载 [${src.label}]: ${src.url}`);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await streamDownload(src.url, destPath, onProgress);
      } catch (err) {
        lastErr = err;
        console.warn(`[Updater] [${src.label}] 第${attempt}/${MAX_RETRIES}: ${translateError(err)}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
        }
      }
    }
    console.warn(`[Updater] [${src.label}] 所有重试失败，切换下一源`);
  }
  throw lastErr;
}

// ==================== 安装逻辑 ====================

/**
 * 静默执行 NSIS 安装包
 * /S — 静默安装，无界面
 * 安装完成后应用会被覆盖，调用 relaunchApp 重启
 *
 * @param {string} exePath 下载的安装包路径
 * @param {Function} onDone 安装完成回调（安装程序会结束当前进程，这个回调可能不会被调用）
 */
function runSilentInstaller(exePath, onDone) {
  console.log('[Updater] 启动静默安装:', exePath);

  // 标记安装启动成功，Electron 可以退出让安装程序接管
  const installer = spawn(exePath, ['/S'], {
    detached: true,       // 安装程序独立运行，不随主进程退出
    stdio: 'ignore',      // 忽略 stdout/stderr（静默模式下无输出）
    windowsHide: false,   // NSIS /S 已经隐藏了界面，这里设 false 以防兼容性问题
  });

  installer.unref();  // 不阻塞主进程退出

  installer.on('error', (err) => {
    console.error('[Updater] 安装程序启动失败:', err.message);
    if (onDone) onDone(err);
  });

  // NSIS /S 安装完成后会自动结束进程
  // 我们在这里延迟 1s 后退出当前 Electron，让安装程序接管
  setTimeout(() => {
    console.log('[Updater] 退出当前进程，等待安装程序完成...');
    app.exit(0);
  }, 1000);
}

// ==================== 清理 ====================

function cleanupTempFiles() {
  try {
    if (!fs.existsSync(UPDATE_TEMP_DIR)) return;
    const items = fs.readdirSync(UPDATE_TEMP_DIR);
    items.forEach(item => {
      const fullPath = path.join(UPDATE_TEMP_DIR, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {
        console.warn('[Updater] 清理单项失败:', item, e.message);
      }
    });
    console.log('[Updater] 临时文件已清理');
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
      version: remoteVersion,
      currentVersion: CURRENT_VERSION,
      notes,
      force,
      downloadUrl,
      // 将完整 versionInfo 也传过去，performUpdate 需要 fallbackUrls
      versionInfo,
    });
  }
}

// ==================== 执行更新（IPC 触发）====================

async function performUpdate(mainWindow, downloadUrl, versionInfoArg) {
  // versionInfoArg 可能在旧版 IPC 里没有传，做兼容
  const versionInfo = versionInfoArg || { downloadUrl };

  // 从 URL 解析文件名（通常是 seedream-desktop-x.x.x-Setup.exe）
  let exeName;
  try {
    exeName = path.basename(new URL(downloadUrl).pathname);
    if (!exeName.endsWith('.exe')) exeName = 'seedream-update.exe';
  } catch {
    exeName = 'seedream-update.exe';
  }

  const exePath = path.join(UPDATE_TEMP_DIR, exeName);
  const sources = buildDownloadSources(versionInfo);

  if (sources.length === 0) {
    const errMsg = 'version.json 中未配置下载地址';
    console.error('[Updater]', errMsg);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { phase: 'error', message: errMsg });
    }
    return;
  }

  try {
    console.log('[Updater] 开始下载安装包:', downloadUrl);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { phase: 'downloading', percent: 0 });
    }

    await downloadWithRetry(sources, exePath, (percent, received, total) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          phase: 'downloading', percent, received, total,
        });
      }
    });

    console.log('[Updater] 下载完成:', exePath);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { phase: 'installing', percent: 100 });
    }

    // 短暂延迟让前端显示"安装中..."
    await sleep(800);

    // 启动静默安装，当前进程随后退出
    runSilentInstaller(exePath, (err) => {
      if (err) {
        const errMsg = '安装程序启动失败: ' + err.message;
        console.error('[Updater]', errMsg);
        cleanupTempFiles();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-status', { phase: 'error', message: errMsg });
        }
      }
    });

  } catch (err) {
    const errMsg = translateError(err);
    console.error('[Updater] 更新最终失败:', errMsg);
    cleanupTempFiles();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { phase: 'error', message: errMsg });
    }
  }
}

module.exports = { checkAndUpdate, performUpdate, relaunchApp };
