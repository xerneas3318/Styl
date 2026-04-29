const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  target: 'es2020',
  format: 'iife',
  sourcemap: process.env.NODE_ENV !== 'production',
  logLevel: 'info',
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
    console.log('[styl] watching for changes...');
  } else {
    await Promise.all(entries.map((e) => esbuild.build({ ...shared, ...e })));
    console.log('[styl] build complete');
  }
}

main().catch(() => process.exit(1));
