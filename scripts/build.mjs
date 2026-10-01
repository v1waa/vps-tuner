import {build} from 'esbuild';
await build({entryPoints:['src/main.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:'dist-electron/main.cjs',external:['electron','ssh2']});
await build({entryPoints:['src/preload.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:'dist-electron/preload.cjs',external:['electron']});
