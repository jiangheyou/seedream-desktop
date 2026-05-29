const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { startProxyServer } = require('./proxy');
const { checkAndUpdate, performUpdate, relaunchApp } = require('./updater');

let mainWindow = null;
let proxyServer = null;

function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Seedream 4.5',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'Seedream 4.5 图片生成',
              detail: '基于豆包 Doubao-Seedream-4.5 模型\n版本 1.0.0\nARK 平台 API',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Seedream 4.5 图片生成',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 外部链接用默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===== IPC 处理：下载 =====
ipcMain.handle('select-download-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择图片保存目录',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('save-file', async (event, { url, filename, saveDir }) => {
  try {
    // 如果指定了保存目录，直接保存
    if (saveDir) {
      const filePath = path.join(saveDir, filename);
      await downloadToFile(url, filePath);
      return { success: true, path: filePath };
    }

    // 否则弹出保存对话框
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存图片',
      defaultPath: filename,
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (result.canceled) return { success: false, canceled: true };

    await downloadToFile(url, result.filePath);
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function downloadToFile(url, filePath) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        https.get(response.headers.location, (redirectRes) => {
          const file = fs.createWriteStream(filePath);
          redirectRes.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', reject);
        }).on('error', reject);
        return;
      }
      const file = fs.createWriteStream(filePath);
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
  return true;
});

// ===== IPC 处理：更新 =====
ipcMain.handle('perform-update', async (event, downloadUrl) => {
  await performUpdate(mainWindow, downloadUrl);
});

ipcMain.handle('relaunch-app', async () => {
  relaunchApp();
});

// ===== 应用生命周期 =====
app.whenReady().then(async () => {
  // 启动代理服务器
  try {
    proxyServer = await startProxyServer(3001);
  } catch (err) {
    console.error('[Main] 代理启动失败:', err.message);
  }

  createMenu();
  createWindow();

  // 启动后 3 秒检测更新（让主界面先加载完）
  setTimeout(() => {
    checkAndUpdate(mainWindow);
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 关闭代理服务器
  if (proxyServer) {
    proxyServer.close();
    console.log('[Main] 代理已关闭');
  }
  app.quit();
});

app.on('before-quit', () => {
  if (proxyServer) {
    proxyServer.close();
  }
});
