'use strict';

// На macOS без платной подписи Apple делаем «ad-hoc» подпись, иначе на Apple Silicon
// приложение пишет «повреждено». Это бесплатно и не требует аккаунта разработчика.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`[after-pack] ad-hoc подпись: ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
