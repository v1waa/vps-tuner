import {mkdirSync,writeFileSync} from 'node:fs';
import {recipeScript} from '../src/core/recipes';
import {scriptHeader} from '../src/core/validation';
import type {Profile} from '../src/shared/types';
if(process.env.VPST_DISPOSABLE_HOST!=='1')throw new Error('This script only prepares tests for a disposable CI runner. Set VPST_DISPOSABLE_HOST=1.');
const p:Profile={id:'eb6492d9-1006-4e7a-bf00-cafab912f980',name:'CI',host:'127.0.0.1',port:22,username:'root',auth:'key',keyPath:'',sudo:false};
mkdirSync('test-results/scripts',{recursive:true});
for(const [id,params] of Object.entries({postgres:{name:'smoke-pg',port:'15432'},mariadb:{name:'smoke-maria',port:'13306'},redis:{name:'smoke-redis',port:'16379'},static:{name:'smoke-site',port:'18080',html:'<h1>VPST_SMOKE</h1>'},xray:{port:'18443',sni:'www.microsoft.com'},'xray-client':{name:'testclient'},'xray-revoke':{name:'testclient'},wdtt:{password:'ci-smoke-only-password-123'},awg:{port:'51888'},'awg-client':{name:'testphone',address:'2'},'awg-revoke':{name:'testphone'},'db-backup':{name:'smoke-pg',engine:'postgres'}})){
 writeFileSync('test-results/scripts/'+id+'.sh',scriptHeader+recipeScript(id,params as Record<string,string>,p,22),{mode:0o600});
}
