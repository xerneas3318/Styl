const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const esbuild = require('esbuild');

const watch   = process.argv.includes('--watch');
const pkg     = process.argv.includes('--package');
const target  = process.argv.includes('--chrome') ? 'chrome' : 'firefox';

// Copy the right manifest into place so the extension folder is always loadable.
// Sources: manifest.firefox.json / manifest.chrome.json → manifest.json (active)
fs.copyFileSync(`manifest.${target}.json`, 'manifest.json');
console.log(`[styl] manifest → ${target}`);

const isProd = pkg || process.env.NODE_ENV === 'production';

const shared = {
  bundle:    true,
  target:    'es2020',
  format:    'iife',
  sourcemap: !isProd,
  logLevel:  'info',
  // Chrome: make `browser` an alias for `chrome` so the shared source works.
  banner: target === 'chrome'
    ? { js: 'if(typeof browser==="undefined"){var browser=chrome;}' }
    : {},
};

const entries = [
  { entryPoints: ['src/background/index.ts'], outfile: 'dist/background.js' },
  { entryPoints: ['src/newtab/index.ts'],     outfile: 'dist/newtab.js'     },
  { entryPoints: ['src/popup/index.ts'],       outfile: 'dist/popup.js'      },
  { entryPoints: ['src/settings/index.ts'],    outfile: 'dist/settings.js'   },
];

// Files/dirs to include in the submission zip — nothing else.
const DIST_FILES = [
  'manifest.json',
  'dist/background.js',
  'dist/popup.js',
  'dist/newtab.js',
  'dist/settings.js',
  'popup/popup.html',
  'popup/popup.css',
  'blocked/blocked.html',
  'blocked/blocked.js',
  'blocked/blocked.css',
  'newtab/newtab.html',
  'newtab/newtab.css',
  'settings/settings.html',
  'settings/settings.css',
  'shared/sound.js',
  'icons/icon.svg',
];

async function build() {
  await Promise.all(entries.map((e) => esbuild.build({ ...shared, ...e })));
  console.log(`[styl] build complete (${target})`);
}

async function packageExt() {
  await build();

  const zipName = path.resolve(`styl-${target}.zip`);
  // Remove stale zip
  try { fs.unlinkSync(zipName); } catch { /* didn't exist */ }

  // zip with explicit file list; run from the project root so paths inside
  // the archive are relative (manifest.json at root, not styl/manifest.json).
  const fileList = DIST_FILES.join(' ');
  execSync(`zip -r "${zipName}" ${fileList}`, { stdio: 'inherit' });

  console.log(`[styl] packaged → ${zipName}`);
}

async function main() {
  if (pkg) {
    await packageExt();
  } else if (watch) {
    const ctxs = await Promise.all(
      entries.map((e) => esbuild.context({ ...shared, ...e }))
    );
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log(`[styl] watching for changes (${target})...`);
  } else {
    await build();
  }
}

main().catch(() => process.exit(1));
