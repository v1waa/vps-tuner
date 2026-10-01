import {app,BrowserWindow,ipcMain,dialog,protocol,net,shell,session as electronSession,type IpcMainInvokeEvent} from 'electron';
import {join,resolve,sep,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile,rename,rm,chmod} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Storage} from './core/storage';
import {SSHSession} from './core/ssh';
import {profileSchema,credentialsSchema,actionSchema,port,absolutePath} from './core/validation';
import {inventoryScript,parseSnapshot} from './core/inventory';
import {recipes,buildPlan,type InternalPlan} from './core/recipes';
import type {AppEvent,Connection,Operation,Snapshot} from './shared/types';
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let win:BrowserWindow;let store:Storage;let ssh:SSHSession;let busy=false;let snapshot:Snapshot|null=null;let connecting=false;
const plans=new Map<string,InternalPlan>();
const dev=!app.isPackaged&&process.env.VPS_TUNER_DEV==='1';
const entry=dev?'http://127.0.0.1:5173':'app://bundle/index.html';
function send(event:AppEvent){if(win&&!win.isDestroyed())win.webContents.send('vps:event',event);}
function connection():Connection{return {connected:ssh?.connected||false,profile:ssh?.profile||undefined,fingerprint:ssh?.fingerprint||undefined,busy:busy||connecting};}
function notifyConnection(){send({type:'connection',value:connection()});}
function validateSender(e:IpcMainInvokeEvent){if(e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame)throw new Error('Недоверенный IPC');const url=e.senderFrame.url;if(dev?!url.startsWith('http://127.0.0.1:5173/'):url!=='app://bundle/index.html')throw new Error('Недоверенный источник');}
function handle(name:string,fn:(...args:any[])=>unknown){ipcMain.handle('vps:'+name,async(e,...args)=>{validateSender(e);return fn(...args);});}
async function exclusive<T>(fn:()=>Promise<T>):Promise<T>{if(busy||connecting)throw new Error('Дождитесь завершения текущей операции');busy=true;notifyConnection();try{return await fn();}finally{busy=false;notifyConnection();}}
function initHandlers(){
 handle('state',()=>({profiles:store.data.profiles,journal:store.data.journal,connection:connection(),recipes,version:app.getVersion()}));
 handle('saveProfile',async(input:unknown)=>store.saveProfile(input));
 handle('deleteProfile',async(id:unknown)=>{const key=z.string().uuid().parse(id);if(ssh.profile?.id===key)throw new Error('Сначала отключите сервер');return store.deleteProfile(key);});
 handle('selectKey',async()=>{const r=await dialog.showOpenDialog(win,{title:'Выберите приватный SSH-ключ',properties:['openFile','showHiddenFiles']});return r.canceled?null:r.filePaths[0];});
 handle('connect',async(input:unknown,auth:unknown)=>{
  if(busy||connecting)throw new Error('Операция уже выполняется');connecting=true;notifyConnection();
  try{await ssh.connect(profileSchema.parse(input),credentialsSchema.parse(auth));snapshot=null;plans.clear();return {...connection(),busy:false};}finally{connecting=false;notifyConnection();}
 });
 handle('disconnect',async()=>{if(busy||connecting)throw new Error('Дождитесь завершения операции');plans.clear();snapshot=null;await ssh.disconnect();});
 handle('scan',()=>exclusive(async()=>{const result=await ssh.exec(inventoryScript,ssh.privileged,300000);if(result.code!==0)throw new Error('Аудит завершился с ошибкой: '+result.output.slice(-1000));snapshot=parseSnapshot(result.output,ssh.sshPort);return snapshot;}));
 handle('plan',async(input:unknown)=>{
  if(!ssh.profile)throw new Error('Сначала подключитесь к VPS');if(busy)throw new Error('Дождитесь завершения операции');
  const plan=buildPlan(actionSchema.parse(input),ssh.profile,ssh.id,snapshot,ssh.sshPort);
  if(plan.root&&!ssh.privileged)throw new Error('Операции нужны права root. Подключитесь как root или включите sudo без запроса пароля.');
  for(const [id,p] of plans)if(p.expiresAt<Date.now())plans.delete(id);
  if(plans.size>20)plans.clear();plans.set(plan.id,plan);
  const {command,action,...publicPlan}=plan;return publicPlan;
 });
 handle('execute',(input:unknown)=>exclusive(async()=>{
  const id=z.string().uuid().parse(input),plan=plans.get(id);plans.delete(id);
  if(!plan||plan.session!==ssh.id||plan.expiresAt<Date.now())throw new Error('План устарел. Сформируйте его заново.');
  const operation:Operation={id:randomUUID(),title:plan.title,host:ssh.profile!.host,startedAt:new Date().toISOString(),status:'running'};
  await store.record(operation);send({type:'operation',value:operation});
  try{const result=await ssh.exec(plan.command,plan.root,30*60*1000,value=>send({type:'output',value}));operation.code=result.code;operation.status=result.code===0?'success':'failed';}
  catch(e){operation.status='interrupted';send({type:'output',value:'\n'+(e instanceof Error?e.message:String(e))+'\n'});}
  operation.finishedAt=new Date().toISOString();await store.record(operation);send({type:'operation',value:operation});return operation;
 }));
 handle('tunnel',async(n:unknown)=>{const p=port(z.number().parse(n));if(connecting)throw new Error('Дождитесь подключения');return {port:await ssh.tunnel(p)};});
 handle('closeTunnels',()=>ssh.closeTunnels());
 handle('download',(input:unknown)=>exclusive(async()=>{
  const path=absolutePath(z.string().parse(input));
  if(!/^\/(opt\/vps-tuner\/(awg\/clients\/[a-z][a-z0-9-]{1,39}\.conf|xray\/clients\/[a-z][a-z0-9-]{1,39}\.txt|[a-z][a-z0-9-]{1,39}\/password\.txt)|var\/backups\/vps-tuner\/[a-zA-Z0-9_.-]+\.(sql\.gz|tar\.gz))$/.test(path))throw new Error('Разрешено скачивать только конфиги клиентов, пароли и резервные копии VPS Tuner');
  const result=await dialog.showSaveDialog(win,{title:'Скачать файл с VPS',defaultPath:basename(path)});if(result.canceled||!result.filePath)return false;
  const temp=result.filePath+'.vpst-'+randomUUID()+'.partial';
  try{await ssh.download(path,temp);await chmod(temp,0o600);await rename(temp,result.filePath);return true;}catch(e){await rm(temp,{force:true});throw e;}
 }));
 handle('exportReport',async(input:unknown)=>{if(!snapshot)throw new Error('Сначала выполните аудит');const r=await dialog.showSaveDialog(win,{title:'Экспорт аудита',defaultPath:`vps-audit-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'JSON',extensions:['json']}]});if(r.canceled||!r.filePath)return false;await writeFile(r.filePath,JSON.stringify(snapshot,null,2),{mode:0o600});return true;});
 handle('exportOutput',async(input:unknown)=>{const text=z.string().max(4*1024*1024).parse(input);const r=await dialog.showSaveDialog(win,{title:'Сохранить вывод / конфигурацию',defaultPath:'vps-output.txt'});if(r.canceled||!r.filePath)return false;await writeFile(r.filePath,text,{mode:0o600});return true;});
 handle('openExternal',async(input:unknown)=>{const url=new URL(z.string().max(4096).parse(input));if(url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&url.hostname==='127.0.0.1')))throw new Error('Допустимы HTTPS-ссылки и локальные SSH-туннели');await shell.openExternal(url.toString());});
}
if(!app.requestSingleInstanceLock())app.quit();
else {
 app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
 app.whenReady().then(async()=>{
  const root=resolve(__dirname,'../dist');
  protocol.handle('app',request=>{const url=new URL(request.url);if(url.host!=='bundle'||request.method!=='GET')return new Response('Forbidden',{status:403});let path:string;try{path=resolve(root,'.'+decodeURIComponent(url.pathname));}catch{return new Response('Bad path',{status:400});}if(!path.startsWith(root+sep))return new Response('Forbidden',{status:403});return net.fetch(pathToFileURL(path).toString());});
  store=new Storage(join(app.getPath('userData'),'config'));await store.load();
  ssh=new SSHSession(async(host,fingerprint)=>{
   const known=store.data.hosts[host];
   if(known&&known!==fingerprint){dialog.showErrorBox('SSH-ключ сервера изменился',`${host}\nСохранён: ${known}\nПолучен: ${fingerprint}\n\nПодключение заблокировано. Проверьте смену ключа через консоль провайдера. Для повторного доверия удалите только запись этого хоста из config/state.json при закрытом приложении.`);return false;}
   if(known===fingerprint)return true;
   const r=await dialog.showMessageBox(win,{type:'warning',title:'Первое подключение к VPS',message:`Доверять SSH-ключу ${host}?`,detail:`${fingerprint}\n\nСверьте отпечаток с консолью провайдера (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). Пароль будет отправлен только после подтверждения.`,buttons:['Отмена','Доверять и подключиться'],defaultId:0,cancelId:0,noLink:true});
   if(r.response!==1)return false;store.data.hosts[host]=fingerprint;await store.persist();return true;
  },()=>{plans.clear();snapshot=null;notifyConnection();});
  win=new BrowserWindow({width:1440,height:940,minWidth:1080,minHeight:720,backgroundColor:'#f6f7fa',title:'VPS Tuner',autoHideMenuBar:true,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged}});
  electronSession.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(()=>false);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(e,url)=>{if(url!==entry&&url!==entry+'/')e.preventDefault();});
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  win.on('close',e=>{if(!busy&&!connecting)return;const choice=dialog.showMessageBoxSync(win,{type:'warning',buttons:['Остаться','Закрыть приложение'],defaultId:0,cancelId:0,message:'Операция на VPS ещё выполняется',detail:'После закрытия её состояние может остаться неизвестным. Проверьте VPS перед повторным запуском.'});if(choice===0)e.preventDefault();});
  initHandlers();await win.loadURL(entry);
 }).catch(e=>{dialog.showErrorBox('Ошибка запуска VPS Tuner',String(e));app.quit();});
 app.on('window-all-closed',()=>{void ssh?.disconnect();app.quit();});
}
