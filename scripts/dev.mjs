import {spawn} from 'node:child_process';
import {build} from 'esbuild';
await import('./build.mjs');
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit'});
for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:5173');break;}catch{await new Promise(r=>setTimeout(r,100));}}
const electron=spawn(process.execPath,['node_modules/electron/cli.js','.'],{stdio:'inherit',env:{...process.env,VPS_TUNER_DEV:'1'}});
electron.on('exit',()=>vite.kill());
process.on('SIGINT',()=>{electron.kill();vite.kill();});
