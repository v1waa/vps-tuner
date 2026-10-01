import {Client} from 'ssh2';
import {readFile,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,type Server,type Socket} from 'node:net';
import type {Profile,Credentials} from '../shared/types';
export function fingerprintOf(key:Buffer){return 'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');}
export class SSHSession {
 private client:Client|null=null;
 private forwarding:Array<{server:Server;sockets:Set<Socket>}>=[];
 id=''; profile:Profile|null=null;fingerprint='';sshPort=0;privileged=false;
 constructor(private trust:(host:string,fingerprint:string)=>Promise<boolean>,private closed:()=>void){}
 get connected(){return !!this.client&&!!this.profile;}
 async connect(profile:Profile,credentials:Credentials){
  if(this.client)throw new Error('Сначала отключитесь от текущего сервера');
  let key:Buffer|undefined;
  if(profile.auth==='key'){const s=await stat(profile.keyPath);if(!s.isFile()||s.size>1024*1024)throw new Error('Некорректный SSH-ключ');key=await readFile(profile.keyPath);}
  const client=new Client();this.client=client;let trusted='';
  try{await new Promise<void>((resolve,reject)=>{
   client.once('ready',resolve);client.on('error',reject);
   client.on('close',()=>{if(this.client===client){this.client=null;this.profile=null;this.id='';void this.closeTunnels();this.closed();}reject(new Error('SSH-соединение закрыто'));});
   client.connect({host:profile.host,port:profile.port,username:profile.username,privateKey:key,password:profile.auth==='password'?credentials.password:undefined,passphrase:credentials.passphrase,readyTimeout:120000,keepaliveInterval:15000,keepaliveCountMax:3,hostVerifier:(hostKey:Buffer,verify:(ok:boolean)=>void)=>{const fp=fingerprintOf(hostKey as Buffer);void this.trust(`${profile.host.toLowerCase()}:${profile.port}`,fp).then(ok=>{if(ok)trusted=fp;verify(ok);}).catch(()=>verify(false));}});
  });this.profile={...profile};this.id=randomUUID();this.fingerprint=trusted;
  const probe=await this.exec('printf "%s\\n" "$SSH_CONNECTION"\nid -u\n',false,15000);
  this.sshPort=Number(probe.output.split('\n')[0].trim().split(/\s+/)[3])||0;
  this.privileged=probe.output.split('\n')[1]?.trim()==='0';
  if(!this.privileged&&profile.sudo){const sudo=await this.exec('id -u\n',true,15000);this.privileged=sudo.code===0&&sudo.output.trim()==='0';}
  return {fingerprint:trusted};
  }catch(e){client.end();if(this.client===client){this.client=null;this.profile=null;}throw e;}finally{key?.fill(0);}
 }
 async exec(script:string,root=false,timeout=120000,onData?:(text:string)=>void):Promise<{code:number;output:string}>{
  const client=this.client,profile=this.profile;if(!client||!profile)throw new Error('Сначала подключитесь по SSH');
  if(root&&profile.username!=='root'&&!profile.sudo)throw new Error('Для операции нужен root или включённый sudo -n');
  return new Promise((resolve,reject)=>{
   const command=root&&profile.username!=='root'?'sudo -n -- bash -s':'bash -s';
   let output='',settled=false;
   client.exec(command,(err,stream)=>{
    if(err){reject(err);return;}
    const timer=setTimeout(()=>{if(settled)return;settled=true;try{stream.signal('TERM');}catch{}stream.close();reject(new Error('Время ожидания истекло. Состояние удалённой операции неизвестно: выполните аудит перед повтором.'));},timeout);
    const append=(data:Buffer)=>{const s=data.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');if(output.length<4*1024*1024)output+=s;onData?.(s);};
    stream.on('data',append);stream.stderr.on('data',append);
    stream.on('error',(e:Error)=>{clearTimeout(timer);if(!settled){settled=true;reject(e);}});
    stream.on('close',(code:number|undefined,signal:string|undefined)=>{clearTimeout(timer);if(settled)return;settled=true;if(typeof code!=='number')reject(new Error(`SSH-канал закрыт без кода завершения${signal?`: ${signal}`:''}. Проверьте состояние сервера.`));else resolve({code,output});});
    stream.end(script);
   });
  });
 }
 async tunnel(remotePort:number):Promise<number>{
  const client=this.client;if(!client||!this.profile)throw new Error('Нет SSH-соединения');
  const sockets=new Set<Socket>();
  const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>socket.destroy());socket.on('close',()=>sockets.delete(socket));client.forwardOut('127.0.0.1',socket.remotePort||0,'127.0.0.1',remotePort,(err,stream)=>{if(err){socket.destroy();return;}stream.on('error',()=>socket.destroy());socket.on('close',()=>stream.destroy());stream.on('close',()=>socket.destroy());socket.pipe(stream).pipe(socket);});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  this.forwarding.push({server,sockets});const addr=server.address();if(!addr||typeof addr==='string')throw new Error('Не удалось создать туннель');return addr.port;
 }
 async download(remotePath:string,localPath:string):Promise<void>{
  const client=this.client;if(!client||!this.profile)throw new Error('Нет SSH-соединения');
  await new Promise<void>((resolve,reject)=>client.sftp((err,sftp)=>{
   if(err){reject(err);return;}
   const timer=setTimeout(()=>{sftp.end();reject(new Error('Истекло время скачивания'));},300000);
   const done=(error?:Error|null)=>{clearTimeout(timer);sftp.end();error?reject(error):resolve();};
   sftp.stat(remotePath,(error,info)=>{if(error){done(error);return;}if(!info.isFile()||info.size>2*1024*1024*1024){done(new Error('Нужен обычный файл размером до 2 ГБ'));return;}sftp.fastGet(remotePath,localPath,{concurrency:16,chunkSize:32768},done);});
  }));
 }
 async closeTunnels(){for(const f of this.forwarding){f.sockets.forEach(s=>s.destroy());f.server.close();}this.forwarding=[];}
 async disconnect(){const c=this.client;this.client=null;this.profile=null;this.id='';await this.closeTunnels();c?.end();this.closed();}
}
