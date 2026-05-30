const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 选择下载目录
  selectDownloadDir: () => ipcRenderer.invoke('select-download-dir'),

  // 保存文件（url: 图片链接, filename: 文件名, saveDir: 可选保存目录）
  saveFile: (url, filename, saveDir) => ipcRenderer.invoke('save-file', { url, filename, saveDir }),

  // 在默认浏览器打开链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // ===== 更新相关 API =====
  // 触发执行更新（传入下载 URL）
  performUpdate: (downloadUrl, versionInfo) => ipcRenderer.invoke('perform-update', downloadUrl, versionInfo),

  // 重启应用
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),

  // 监听更新可用（主进程推送）
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, info) => callback(info));
  },

  // 监听更新进度状态（phase: 'downloading' | 'applying' | 'cleanup' | 'done' | 'error'）
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, status) => callback(status));
  },

  // 监听解压进度
  onUpdateApplyProgress: (callback) => {
    ipcRenderer.on('update-apply-progress', (event, progress) => callback(progress));
  },

  // 是否在 Electron 环境中
  isElectron: true,
});
