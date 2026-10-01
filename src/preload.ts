import {contextBridge,ipcRenderer} from 'electron';
import type {API,AppEvent} from './shared/types';
const call=(name:string,...args:unknown[])=>ipcRenderer.invoke('vps:'+name,...args);
const api:API={state:()=>call('state'),saveProfile:p=>call('saveProfile',p),deleteProfile:id=>call('deleteProfile',id),selectKey:()=>call('selectKey'),connect:(p,c)=>call('connect',p,c),disconnect:()=>call('disconnect'),scan:()=>call('scan'),plan:a=>call('plan',a),execute:id=>call('execute',id),tunnel:p=>call('tunnel',p),closeTunnels:()=>call('closeTunnels'),download:p=>call('download',p),exportReport:s=>call('exportReport',s),exportOutput:s=>call('exportOutput',s),openExternal:url=>call('openExternal',url),subscribe:fn=>{const listener=(_e:unknown,event:AppEvent)=>fn(event);ipcRenderer.on('vps:event',listener);return ()=>ipcRenderer.removeListener('vps:event',listener);}};
contextBridge.exposeInMainWorld('vps',api);
