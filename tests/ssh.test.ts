import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Server,utils} from 'ssh2';
import {createServer,connect as connectTCP} from 'node:net';
import {SSHSession,fingerprintOf} from '../src/core/ssh';
import type {Profile} from '../src/shared/types';
const key=utils.generateKeyPairSync('ed25519');
async function fixture(){
 const received:string[]=[];const commands:string[]=[];let auths=0;
 const server=new Server({hostKeys:[key.private]},client=>{
  client.on('authentication',ctx=>{auths++;if(ctx.method==='password'&&ctx.password==='test-password')ctx.accept();else ctx.reject();});
  client.on('error',()=>{});
  client.on('ready',()=>{client.on('session',accept=>{const session=accept();session.on('exec',(accept,_reject,info)=>{commands.push(info.command);const stream=accept();let input='';stream.on('data',(s:Buffer)=>input+=s.toString());stream.on('end',()=>{received.push(input);if(input.includes('SSH_CONNECTION')){stream.write('127.0.0.1 11111 127.0.0.1 2222\n0\n');stream.exit(0);stream.end();}else if(input.includes('test-nonzero')){stream.stderr.write('real failure');stream.exit(7);stream.end();}else if(input.includes('test-close')){stream.close();}else{stream.write('hello\n');stream.exit(0);stream.end();}});});});
   client.on('tcpip',(accept,_reject,info)=>{const stream=accept();const socket=connectTCP(info.destPort,info.destIP);socket.on('error',()=>stream.close());stream.pipe(socket).pipe(stream);stream.on('close',()=>socket.destroy());});
  });
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(typeof address==='string'||!address)throw new Error('listen');
 const profile:Profile={id:'eb6492d9-1006-4e7a-bf00-cafab912f980',name:'Test',host:'127.0.0.1',port:address.port,username:'root',auth:'password',keyPath:'',sudo:false};
 return {server,profile,received,commands,get auths(){return auths;}};
}
test('SSH verifies host before auth, captures remote port and exit status',async()=>{const f=await fixture();let verifications=0;const ssh=new SSHSession(async(_host,fp)=>{verifications++;assert.equal(f.auths,0);assert.match(fp,/^SHA256:/);return true;},()=>{});try{await ssh.connect(f.profile,{password:'test-password'});assert.equal(verifications,1);assert.equal(ssh.sshPort,2222);assert.equal(ssh.privileged,true);assert.equal((await ssh.exec('echo hi')).output,'hello\n');assert.equal((await ssh.exec('test-nonzero')).code,7);assert.ok(f.commands.every(c=>c==='bash -s'));assert.equal(f.received[1],'echo hi');}finally{await ssh.disconnect();f.server.close();}});
test('untrusted host is rejected before credentials are sent',async()=>{const f=await fixture();const ssh=new SSHSession(async()=>false,()=>{});try{await assert.rejects(ssh.connect(f.profile,{password:'test-password'}));assert.equal(f.auths,0);}finally{await ssh.disconnect();f.server.close();}});
test('closed command without exit status is not reported successful',async()=>{const f=await fixture();const ssh=new SSHSession(async()=>true,()=>{});try{await ssh.connect(f.profile,{password:'test-password'});await assert.rejects(ssh.exec('test-close'),/без кода/);}finally{await ssh.disconnect();f.server.close();}});
test('SSH local forwarding transfers bytes and closes with session',async()=>{const f=await fixture();const echo=createServer(s=>s.pipe(s));await new Promise<void>(r=>echo.listen(0,'127.0.0.1',r));const addr=echo.address();if(!addr||typeof addr==='string')throw Error();const ssh=new SSHSession(async()=>true,()=>{});try{await ssh.connect(f.profile,{password:'test-password'});const local=await ssh.tunnel(addr.port);const result=await new Promise<string>((resolve,reject)=>{const client=connectTCP(local,'127.0.0.1',()=>client.write('tunnel-data'));client.on('data',b=>{resolve(b.toString());client.destroy();});client.on('error',reject);});assert.equal(result,'tunnel-data');await ssh.closeTunnels();await new Promise(r=>setTimeout(r,20));await assert.rejects(new Promise((resolve,reject)=>{const c=connectTCP(local,'127.0.0.1',()=>{c.destroy();resolve(undefined);});c.on('error',reject);}));}finally{await ssh.disconnect();f.server.close();echo.close();}});
