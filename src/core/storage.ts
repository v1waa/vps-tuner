import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {profileSchema} from './validation';
import type {Profile,Operation} from '../shared/types';
interface Data {profiles:Profile[]; hosts:Record<string,string>; journal:Operation[]}
const schema=z.object({profiles:z.array(profileSchema).max(100),hosts:z.record(z.string(),z.string()),journal:z.array(z.object({id:z.string(),title:z.string(),host:z.string(),startedAt:z.string(),finishedAt:z.string().optional(),status:z.enum(['running','success','failed','interrupted']),code:z.number().optional()})).max(500)});
export class Storage {
 data:Data={profiles:[],hosts:{},journal:[]};private queue=Promise.resolve();
 constructor(private dir:string){}
 async load(){await mkdir(this.dir,{recursive:true,mode:0o700});try{this.data=schema.parse(JSON.parse(await readFile(join(this.dir,'state.json'),'utf8')));this.data.journal=this.data.journal.map(x=>x.status==='running'?{...x,status:'interrupted'}:x);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Файл настроек повреждён. Сохраните копию state.json и исправьте его перед запуском.');}}
 async persist(){const data=JSON.stringify(this.data,null,2);this.queue=this.queue.then(async()=>{const dest=join(this.dir,'state.json');await writeFile(dest+'.tmp',data,{mode:0o600});await rename(dest+'.tmp',dest);});await this.queue;}
 async saveProfile(input:unknown){const profile=profileSchema.parse(input);this.data.profiles=this.data.profiles.filter(p=>p.id!==profile.id).concat(profile);await this.persist();return this.data.profiles;}
 async deleteProfile(id:string){this.data.profiles=this.data.profiles.filter(p=>p.id!==id);await this.persist();return this.data.profiles;}
 async record(op:Operation){this.data.journal=[op,...this.data.journal.filter(x=>x.id!==op.id)].slice(0,500);await this.persist();}
}
