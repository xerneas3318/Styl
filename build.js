const fs      = require('fs');
const esbuild = require('esbuild');

const watch  = process.argv.includes('--watch');
const target = process.argv.includes('--chrome') ? 'chrome' : 'firefox';

// Copy the right manifest into place so the extension folder is always loadable.
// Sources: manifest.firefox.json / manifest.chrome.json → manifest.json (active)
fs.copyFileSync(`manifest.${target}.json`, 'manifest.json');
console.log(`[styl] manifest → ${target}`);

const shared = {
  bundle:    true,
  target:    'es2020',
  format:    'iife',
  sourcemap: process.env.NODE_ENV !== 'production',
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

async function main() {
  if (watch) {
    const ctxs = await Promise.all(
      entries.map((e) => esbuild.context({ ...shared, ...e }))
    );
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log(`[styl] watching for changes (${target})...`);
  } else {
    await Promise.all(entries.map((e) => esbuild.build({ ...shared, ...e })));
    console.log(`[styl] build complete (${target})`);
  }
}

main().catch(() => process.exit(1));
