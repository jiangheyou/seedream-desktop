/**
 * build-hotfix.js — 构建热更新补丁包
 *
 * 生成: dist/seedream-desktop-{version}.zip
 * 内容: app.asar（完整替换包）+ version.json
 *
 * 用法: node build-hotfix.js [version]
 * 示例: node build-hotfix.js 1.0.1
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const AdmZip = require('./node_modules/adm-zip');

// ==================== 配置 ====================
const PROJECT_DIR = __dirname;
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const VERSION = process.argv[2] || JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8')).version;

// asar 工具路径（用全局或项目内的）
function findAsar() {
  // 尝试项目内 node_modules/.bin
  const localBin = path.join(PROJECT_DIR, 'node_modules', '.bin', 'asar.cmd');
  if (fs.existsSync(localBin)) return localBin;
  const localJs = path.join(PROJECT_DIR, 'node_modules', 'asar', 'bin', 'asar.js');
  if (fs.existsSync(localJs)) return localJs;

  // 尝试 workbuddy 管理的
  const wbAsar = path.join(
    process.env.USERPROFILE || '',
    '.workbuddy', 'binaries', 'node', 'workspace',
    'node_modules', 'asar', 'bin', 'asar.js'
  );
  if (fs.existsSync(wbAsar)) return wbAsar;

  // 尝试 where
  try {
    return execFileSync('where', ['asar'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {}

  return null;
}

// ==================== 构建 ====================

console.log(`\n📦 Seedream Hotfix Builder`);
console.log(`   版本: v${VERSION}\n`);

// 1. 找到 asar
const asarPath = findAsar();
if (!asarPath) {
  console.error('❌ 找不到 asar 命令行工具！请先安装: npm install -g asar');
  process.exit(1);
}
console.log('✅ asar:', asarPath);

// 2. 确定 Node 路径
let nodePath = process.execPath;
// 检查是否是 Electron 的 Node（不能用来跑 asar）
if (nodePath.toLowerCase().includes('electron')) {
  // 尝试找系统 Node
  const candidates = [
    path.join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'node', 'versions', '22.12.0', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { nodePath = c; break; }
  }
}
console.log('✅ Node:', nodePath);

// 3. 准备临时目录
const tmpDir = path.join(DIST_DIR, '_tmp_build_' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const asarOutput = path.join(tmpDir, 'app.asar');

// 4. 收集需要打包进 asar 的文件
// 基于 package.json build.files 规则 + 额外必要文件
const filesToPack = [];

// 必须包含的核心文件
const coreFiles = ['main.js', 'preload.js', 'proxy.js', 'updater.js', 'version.json'];
coreFiles.forEach(f => {
  const fp = path.join(PROJECT_DIR, f);
  if (fs.existsSync(fp)) filesToPack.push(fp);
});

// 图标文件
['icon.ico', 'icon.png'].forEach(f => {
  const fp = path.join(PROJECT_DIR, f);
  if (fs.existsSync(fp)) filesToPack.push(fp);
});

// renderer 目录（递归）
const rendererDir = path.join(PROJECT_DIR, 'renderer');
if (fs.existsSync(rendererDir)) {
  function collectFiles(dir) {
    fs.readdirSync(dir).forEach(item => {
      const full = path.join(dir, item);
      if (fs.statSync(full).isDirectory()) collectFiles(full);
      else filesToPack.push(full);
    });
  }
  collectFiles(rendererDir);
}

// proxy 目录（如果存在）
const proxyDir = path.join(PROJECT_DIR, 'proxy');
if (fs.existsSync(proxyDir)) {
  function collectProxy(dir) {
    fs.readdirSync(dir).forEach(item => {
      const full = path.join(dir, item);
      if (fs.statSync(full).isDirectory()) collectProxy(full);
      else filesToPack.push(full);
    });
  }
  collectProxy(proxyDir);
}

// package.json（asar 内需要）
filesToPack.push(path.join(PROJECT_DIR, 'package.json'));

// node_modules/adm-zip（运行时需要，打包进去）
const admZipDir = path.join(PROJECT_DIR, 'node_modules', 'adm-zip');
if (fs.existsSync(admZipDir)) {
  function collectNpm(dir) {
    fs.readdirSync(dir).forEach(item => {
      if (item === 'node_modules') return; // 不嵌套依赖
      const full = path.join(dir, item);
      if (fs.statSync(full).isDirectory()) collectNpm(full);
      else filesToPack.push(full);
    });
  }
  collectNpm(admZipDir);
}

// 5. 将精选文件复制到临时目录再打包（避免打包 .git/node_modules 等）
const packDir = path.join(tmpDir, '_pack_' + Date.now());
fs.mkdirSync(packDir, { recursive: true });

filesToPack.forEach(fp => {
  const rel = path.relative(PROJECT_DIR, fp);
  const dest = path.join(packDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(fp, dest);
});

console.log(`\n📋 打包 ${filesToPack.length} 个文件进 app.asar...`);

// 6. 打包 asar（从精选文件临时目录打包）
try {
  const isCmd = asarPath.endsWith('.cmd');
  if (isCmd) {
    execFileSync(asarPath, ['pack', packDir, asarOutput], { stdio: 'pipe', cwd: PROJECT_DIR });
  } else {
    execFileSync(nodePath, [asarPath, 'pack', packDir, asarOutput], { stdio: 'pipe', cwd: PROJECT_DIR });
  }
} catch (err) {
  console.error('❌ asar pack 失败:', err.stderr || err.message);
  process.exit(1);
}

const asarSize = fs.statSync(asarOutput).size;
console.log(`✅ app.asar 已生成 (${(asarSize / 1024).toFixed(1)} KB)`);

// 7. 创建 zip（包含完整 app.asar）
const zipName = `seedream-desktop-${VERSION}.zip`;
const zipPath = path.join(DIST_DIR, zipName);
const zip = new AdmZip();

// 加入 app.asar
zip.addLocalFile(asarOutput, '', 'app.asar');

// 也加入 version.json 方便预检
const verJsonPath = path.join(PROJECT_DIR, 'version.json');
if (fs.existsSync(verJsonPath)) {
  zip.addLocalFile(verJsonPath, '', 'version.json');
}

zip.writeZip(zipPath);
const zipSize = fs.statSync(zipPath).size;
console.log(`✅ 补丁包已生成: ${zipName} (${(zipSize / 1024).toFixed(1)} KB)`);

// 8. 清理临时目录
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// 9. 输出摘要
zip.getEntries().forEach(e => {
  if (!e.isDirectory) {
    console.log(`   ${e.entryName.padEnd(20)} ${(e.header.size/1024).toFixed(1)} KB`);
  }
});
console.log('');
console.log(`🎉 构建完成! 文件: ${zipPath}`);
