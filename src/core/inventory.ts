import type {Snapshot,Section,Port,Container,Finding,Project} from '../shared/types';
export const inventoryScript=String.raw`export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
section() {
  local key="$1"; shift
  local result code
  result=$(timeout 18 bash -c "$1" 2>&1); code=$?
  printf '\n__VPST_SECTION__%s:%s\n' "$key" "$code"
  printf '%s' "$result" | base64 | tr -d '\n'
  printf '\n'
}
section system 'hostname; uname -m; uname -r; id -u; getconf _NPROCESSORS_ONLN; cat /proc/loadavg; uptime -p; timedatectl show -p Timezone --value'
section os 'cat /etc/os-release'
section memory 'cat /proc/meminfo'
section disk 'df -B1 --output=size,used,avail,pcent,target /'
section network 'ip -br addr; ip route; ip -6 route'
section ports 'ss -H -lntup'
section services 'systemctl list-units --type=service --all --no-legend --plain --no-pager'
section containers 'docker ps -a --no-trunc --format "{{json .}}"'
section compose 'docker compose ls --all --format json'
section projects 'find /opt /srv /var/www /home -maxdepth 4 -type f \( -name compose.yml -o -name compose.yaml -o -name docker-compose.yml -o -name docker-compose.yaml -o -name package.json -o -name pyproject.toml -o -name requirements.txt -o -name Cargo.toml -o -name go.mod -o -name "*.csproj" \) -not -path "*/node_modules/*" -not -path "*/.venv/*" 2>/dev/null | head -150'
section ufw 'ufw status verbose'
section nft 'nft list ruleset'
section iptables 'iptables -S; ip6tables -S'
section ssh 'sshd -T'
section forwarding 'sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding'
section tun 'test -c /dev/net/tun && echo available'
section vpn 'for t in wg awg xray wdtt; do command -v "$t" || :; done; ip -br link'
section failed 'systemctl --failed --no-legend --plain --no-pager'
section updates 'if command -v apt >/dev/null; then apt list --upgradable 2>/dev/null; else echo "Проверка обновлений: доступна для Debian/Ubuntu"; fi'
printf '\n__VPST_END__\n'
`;
export function parseSections(output:string):Record<string,Section>{
  if(!output.includes('__VPST_END__'))throw new Error('Аудит не завершён: соединение прервано или отсутствует bash/base64/timeout');
  const sections:Record<string,Section>={};
  const re=/__VPST_SECTION__(\w+):(\d+)\r?\n([A-Za-z0-9+/=]*)/g;
  for(const m of output.matchAll(re))sections[m[1]]={code:Number(m[2]),text:Buffer.from(m[3],'base64').toString('utf8')};
  if(!sections.system||!sections.os)throw new Error('Некорректный ответ аудита');return sections;
}
export function parsePorts(text:string):Port[]{return text.split('\n').flatMap(line=>{const m=line.trim().split(/\s+/);if(m.length<6||!['tcp','udp'].includes(m[0]))return [];const local=m[4];const end=local.lastIndexOf(':');const p=Number(local.slice(end+1));if(!Number.isInteger(p)||p<1||p>65535)return [];const address=local.slice(0,end).replace(/^\[|\]$/g,'');return [{protocol:m[0],address,port:p,process:m.slice(6).join(' ')||'—',exposed:!/^127\./.test(address)&&address!=='::1'&&address!=='::ffff:127.0.0.1'}];});}
export function parseContainers(text:string):Container[]{return text.split('\n').flatMap(line=>{try{const c=JSON.parse(line);if(!c.ID)return [];const label=String(c.Labels||'').split(',').find((l:string)=>l.startsWith('com.docker.compose.project='));return [{id:c.ID,name:c.Names,image:c.Image,state:c.State||c.Status,ports:c.Ports||'',project:label?.split('=')[1]||''}];}catch{return [];}});}
export function parseSnapshot(output:string,sshPort:number):Snapshot{
 const sections=parseSections(output),get=(k:string)=>sections[k]?.text||'';
 const sys=get('system').split('\n'),os=get('os'),mem=get('memory');
 const val=(name:string)=>Number(mem.match(new RegExp(`^${name}:\\s+(\\d+)`,'m'))?.[1]||0)*1024;
 const disk=get('disk').trim().split('\n')[1]?.trim().split(/\s+/)||[];
 const ports=parsePorts(get('ports'));
 const services=get('services').split('\n').flatMap(line=>{const p=line.trim().replace(/^●\s*/,'').split(/\s+/);return p[0]?.endsWith('.service')?[{name:p[0],state:p[2],detail:p.slice(4).join(' ')}]:[];});
 const containers=parseContainers(get('containers'));
 const paths=new Map<string,Project>();
 get('projects').split('\n').filter(p=>p.startsWith('/')).forEach(path=>{const dir=path.slice(0,path.lastIndexOf('/'));const file=path.slice(path.lastIndexOf('/')+1);const kind=/compose/.test(file)?'Compose':file==='package.json'?'Node.js':/pyproject|requirements/.test(file)?'Python':file==='go.mod'?'Go':file==='Cargo.toml'?'Rust':'.NET';if(!paths.has(dir)||kind==='Compose')paths.set(dir,{name:dir.split('/').pop()||dir,path:dir,kind,evidence:file});});
 try{const compose=JSON.parse(get('compose'));if(Array.isArray(compose))for(const c of compose){if(typeof c.ConfigFiles!=='string')continue;const path=c.ConfigFiles.split(',')[0];const dir=path.slice(0,path.lastIndexOf('/'));paths.set(dir,{name:c.Name,path:dir,kind:'Compose',evidence:c.ConfigFiles});}}catch{/* Docker unavailable is reported through sections. */}
 const findings:Finding[]=[];
 const privileged=sys[3]==='0';
 if(!privileged)findings.push({level:'warning',title:'Аудит с ограниченными правами',detail:'Firewall, процессы портов и конфигурация SSH могут быть недоступны. Для полного аудита нужен root или sudo без запроса пароля.'});
 const ssh=get('ssh');
 if(sections.ssh?.code===0){
  if(/^permitrootlogin yes$/m.test(ssh))findings.push({level:'warning',title:'Разрешён вход root по паролю',detail:'Создайте отдельного администратора и проверьте вход по SSH-ключу перед изменением настроек SSH.'});
  if(/^passwordauthentication yes$/m.test(ssh))findings.push({level:'warning',title:'SSH принимает пароли',detail:'Предпочтителен вход по ключу. Автоматическое отключение паролей не выполняется.'});
  else if(/^passwordauthentication no$/m.test(ssh))findings.push({level:'ok',title:'Вход по SSH-паролю отключён',detail:'Проверено по sshd -T. Условия Match могут менять параметры отдельных подключений.'});
 }else findings.push({level:'info',title:'Параметры SSH не прочитаны',detail:'Аудит не смог выполнить sshd -T.'});
 const firewallActive=/Status: active/.test(get('ufw'))||/hook input/.test(get('nft'))||/-P INPUT (DROP|REJECT)|^-A INPUT /m.test(get('iptables'));
 findings.push(firewallActive?{level:'info',title:'Обнаружены правила firewall',detail:'Наличие правил не гарантирует защиту. Проверьте входящие цепочки, IPv6 и публикацию Docker-портов.'}:{level:'warning',title:'Фильтрация входящего трафика не подтверждена',detail:'Правила не найдены или недоступны. Внешний firewall провайдера этим аудитом не проверяется.'});
 const sensitive=[2375,2376,3306,5432,6379,27017,9200,2860,2861];
 const exposed=ports.filter(p=>p.exposed&&sensitive.includes(p.port));
 if(exposed.length)findings.push({level:'danger',title:'Служебные порты слушают внешние интерфейсы',detail:exposed.map(p=>`${p.port}/${p.protocol}`).join(', ')+'. Проверьте firewall; для БД и панелей используйте localhost и SSH-туннель.'});
 if(services.some(s=>s.name==='fail2ban.service'&&s.state==='active'))findings.push({level:'ok',title:'Fail2ban запущен',detail:'Проверьте состояние jail sshd в разделе защиты.'});
 else findings.push({level:'info',title:'Fail2ban не обнаружен среди активных служб',detail:'Его можно установить из каталога защиты.'});
 const diskTotal=Number(disk[0])||0,diskUsed=Number(disk[1])||0;
 if(diskTotal&&diskUsed/diskTotal>0.85)findings.push({level:'warning',title:'Мало места на корневом диске',detail:'Использовано более 85%. Проверьте логи, образы и резервные копии.'});
 const failed=services.filter(s=>s.state==='failed');if(failed.length)findings.push({level:'danger',title:'Службы завершились с ошибкой',detail:failed.map(s=>s.name).join(', ')});
 if(sections.ports?.code!==0)findings.push({level:'warning',title:'Список портов недоступен',detail:'Команда ss не выполнилась. Не считайте пустой список подтверждением свободных портов.'});
 return {at:new Date().toISOString(),hostname:sys[0]||'—',os:os.match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1]||'Linux',osId:os.match(/^ID="?([^"\n]+)/m)?.[1]||'',arch:sys[1]||'',kernel:sys[2]||'',privileged,cpuCount:Number(sys[4])||0,load:Number(sys[5]?.split(' ')[0])||0,uptime:sys[6]||'',timezone:sys[7]||'',memoryTotal:val('MemTotal'),memoryUsed:Math.max(0,val('MemTotal')-val('MemAvailable')),diskTotal,diskUsed,ports,services,containers,projects:[...paths.values()],findings,sections,sshPort};
}
