/**
 * build-release.js — Seedream Desktop 发布脚本 v4
 *
 * 用途: 每次发布新版本时运行此脚本，完成以下工作：
 *   1. 用 electron-builder 打包 Windows NSIS 安装包
 *   2. 自动更新 version.json（版本号、下载地址）
 *   3. 输出发布后的手动操作步骤（推送到 Gitee + GitHub）
 *
 * 用法:
 *   node build-release.js [version] [notes]
 *
 * 示例:
 *   node build-release.js 1.0.4 "修复启动崩溃问题"
 *   node build-release.js 1.1.0
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

// ==================== 配置 ====================

const PROJECT_DIR = __dirname;
const DIST_DIR    = path.join(PROJECT_DIR, 'dist');

/** Gitee 仓库（用于生成下载地址） */
const GITEE_REPO  = 'jiang-heyou/seedream-4.5';
/** GitHub 仓库（备源） */
const GITHUB_REPO = 'jiangheyou/seedream-desktop';

// 从参数或 package.json 读取版本号
const pkgJson  = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
const VERSION  = process.argv[2] || pkgJson.version;
const NOTES    = process.argv[3] || '';

// ==================== 主流程 ====================

console.log('\n🚀 Seedream Desktop 发布脚本 v4');
console.log(`   版本: v${VERSION}`);
console.log(`   Gitee: ${GITEE_REPO}\n`);

// 1. 更新 package.json 中的版本号
if (pkgJson.version !== VERSION) {
  pkgJson.version = VERSION;
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'package.json'),
    JSON.stringify(pkgJson, null, 2) + '\n'
  );
  console.log(`✅ package.json 版本已更新 → ${VERSION}`);
} else {
  console.log(`   package.json 版本: ${VERSION} (无需更新)`);
}

// 2. 用 electron-builder 打包
console.log('\n📦 开始打包 NSIS 安装包...');
try {
  execSync('npm run build', {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    timeout: 300_000, // 5 分钟
  });
} catch (err) {
  console.error('\n❌ electron-builder 打包失败:', err.message);
  process.exit(1);
}

// 3. 找到生成的安装包
const expectedExeName = `Seedream 4.5 Setup ${VERSION}.exe`;
const distFiles = fs.existsSync(DIST_DIR) ? fs.readdirSync(DIST_DIR) : [];
const exeFile = distFiles.find(f => f.endsWith('.exe') && !f.startsWith('_'));
if (!exeFile) {
  console.error('\n❌ 未找到安装包 .exe 文件，请检查 electron-builder 输出');
  process.exit(1);
}

const exePath = path.join(DIST_DIR, exeFile);
const exeSize = fs.statSync(exePath).size;
console.log(`\n✅ 安装包已生成:`);
console.log(`   文件: ${exeFile}`);
console.log(`   大小: ${(exeSize / 1024 / 1024).toFixed(2)} MB`);

// 4. 更新 version.json
const releaseTag = `v${VERSION}`;
const exeNameForUrl = encodeURIComponent(exeFile);

// Gitee Release 下载地址格式
const giteeDownloadUrl  = `https://gitee.com/${GITEE_REPO}/releases/download/${releaseTag}/${exeNameForUrl}`;
// jsDelivr 备源（通过 GitHub dist/ 目录）
const jsdelivrFallback  = `https://cdn.jsdelivr.net/gh/${GITHUB_REPO}@main/dist/${exeNameForUrl}`;

const today = new Date().toISOString().slice(0, 10);
const versionJson = {
  version: VERSION,
  notes: NOTES || `Seedream 4.5 v${VERSION}（${today}）`,
  downloadUrl: giteeDownloadUrl,
  fallbackUrls: [ jsdelivrFallback ],
  force: false,
  releaseDate: today,
  installer: true,
};

fs.writeFileSync(
  path.join(PROJECT_DIR, 'version.json'),
  JSON.stringify(versionJson, null, 2) + '\n'
);
console.log('\n✅ version.json 已更新:');
console.log(`   主源(Gitee): ${giteeDownloadUrl}`);
console.log(`   备源(jsDelivr): ${jsdelivrFallback}`);

// 5. 输出下一步手动操作指引
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ 构建完成！接下来需要手动完成以下步骤：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

① 推送代码到 GitHub（含 version.json）:
   git add version.json package.json
   git commit -m "chore: release v${VERSION}"
   git push origin main

② 在 Gitee 创建 Release，上传安装包:
   地址: https://gitee.com/${GITEE_REPO}/releases/new
   Tag:  ${releaseTag}
   附件: ${exeFile} （${(exeSize / 1024 / 1024).toFixed(2)} MB）
   ⚠️  文件名必须与 version.json 中的 URL 一致

③ 推送代码到 Gitee（同步）:
   git remote add gitee https://gitee.com/${GITEE_REPO}.git  # 首次添加
   git push gitee main

④ 验证（等 Gitee Release 发布后）:
   curl "https://gitee.com/${GITEE_REPO}/raw/main/version.json"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
