export interface Profile { id: string; name: string; host: string; port: number; username: string; auth: 'password'|'key'; keyPath: string; sudo: boolean }
export interface Credentials {password?:string; passphrase?:string}
export interface Port { protocol:string; address:string; port:number; process:string; exposed:boolean }
export interface Service {name:string; state:string; detail:string}
export interface Container {id:string; name:string; image:string; state:string; ports:string; project:string}
export interface Project {name:string; path:string; kind:string; evidence:string}
export interface Finding {level:'danger'|'warning'|'info'|'ok'; title:string; detail:string}
export interface Section {code:number; text:string}
export interface Snapshot {
  at:string; hostname:string; os:string; osId:string; arch:string; kernel:string; uptime:string;
  cpuCount:number; load:number; memoryUsed:number; memoryTotal:number; diskUsed:number; diskTotal:number;
  ports:Port[]; services:Service[]; containers:Container[]; projects:Project[]; findings:Finding[];
  sections:Record<string,Section>; privileged:boolean; sshPort:number; timezone:string;
}
export interface RecipeField {key:string; label:string; type?:'text'|'number'|'password'|'textarea'|'select'; placeholder?:string; default?:string; options?:string[]; help?:string}
export interface Recipe {id:string; name:string; description:string; category:'system'|'security'|'database'|'web'|'project'|'vpn'; tag:string; fields:RecipeField[]; source?:string}
export interface ActionRequest {type:'recipe'|'service'|'container'|'logs'|'compose'|'command'|'read-config'; id:string; verb?:string; params?:Record<string,string>}
export interface Plan {id:string; title:string; description:string; script:string; warnings:string[]; root:boolean; risk:'read'|'change'|'critical'; expiresAt:number; session:string}
export interface Operation {id:string; title:string; host:string; startedAt:string; finishedAt?:string; status:'running'|'success'|'failed'|'interrupted'; code?:number}
export interface Connection {connected:boolean; profile?:Profile; fingerprint?:string; busy:boolean}
export type AppEvent = {type:'connection'; value:Connection}|{type:'output'; value:string}|{type:'operation';value:Operation};
export interface AppState {profiles:Profile[]; journal:Operation[]; connection:Connection; version:string; recipes:Recipe[]}
export interface API {
  state():Promise<AppState>; saveProfile(profile:Profile):Promise<Profile[]>; deleteProfile(id:string):Promise<Profile[]>;
  selectKey():Promise<string|null>; connect(profile:Profile,credentials:Credentials):Promise<Connection>; disconnect():Promise<void>;
  scan():Promise<Snapshot>; plan(action:ActionRequest):Promise<Plan>; execute(id:string):Promise<Operation>;
  tunnel(port:number):Promise<{port:number}>; closeTunnels():Promise<void>;
  download(path:string):Promise<boolean>; exportReport(snapshot:Snapshot):Promise<boolean>; exportOutput(text:string):Promise<boolean>;
  openExternal(url:string):Promise<void>; subscribe(fn:(event:AppEvent)=>void):()=>void;
}
declare global {interface Window {vps:API}}
