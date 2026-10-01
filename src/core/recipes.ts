import {randomUUID} from 'node:crypto';
import type {Recipe,RecipeField,Profile,ActionRequest,Plan,Snapshot} from '../shared/types';
import {quote,port,slug,unit,containerId,absolutePath,domain,imageName,scriptHeader,debianGuard,dockerGuard,freePort,newPath,writeFile} from './validation';
import {awgInstall,awgClient,awgRevoke,xrayInstall,xrayClient,wdttInstall} from './vpn';
import {recipes} from '../shared/catalog';
export {recipes};
export interface InternalPlan extends Plan {command:string;action:ActionRequest}
function logOptions(){return {driver:'json-file',options:{'max-size':'10m','max-file':'3'}};}
export function parseEnv(text:string):Record<string,string>{const result:Record<string,string>=Object.create(null);for(const l of text.split(/\r?\n/)){if(!l.trim()||l.trimStart().startsWith('#'))continue;const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(!m)throw new Error('Переменные: NAME=value, по одной в строке');result[m[1]]=m[2].replace(/\$/g,()=> '$$');}return result;}
function composeProject(name:string,compose:unknown,extra='',guard=''){const path='/opt/vps-tuner/'+slug(name);return dockerGuard+guard+newPath(path)+`install -d -m 700 ${quote(path)}\n`+extra+writeFile(path+'/compose.yaml',JSON.stringify(compose,null,2))+`cd ${quote(path)}\ndocker compose config --quiet\ndocker compose up -d --wait --wait-timeout 120\ndocker compose ps\n`;}
function database(id:string,p:Record<string,string>){
 const name=slug(p.name||id),n=port(p.port||({postgres:'5432',mariadb:'3306',redis:'6379'}[id]!)),path='/opt/vps-tuner/'+name;
 const compose:any={name:'vpst-'+name,services:{database:{restart:'unless-stopped',ports:[`127.0.0.1:${n}:${{postgres:5432,mariadb:3306,redis:6379}[id]}`],secrets:['db_password'],logging:logOptions()}},volumes:{data:{}},secrets:{db_password:{file:'./password.txt'}}};
 const s=compose.services.database;
 if(id==='postgres'){Object.assign(s,{image:'postgres:17-bookworm',environment:{POSTGRES_DB:'app',POSTGRES_USER:'app',POSTGRES_PASSWORD_FILE:'/run/secrets/db_password'},volumes:['data:/var/lib/postgresql/data'],healthcheck:{test:['CMD-SHELL','pg_isready -U app -d app'],interval:'5s',timeout:'5s',retries:12}});}
 if(id==='mariadb'){Object.assign(s,{image:'mariadb:11.4',environment:{MARIADB_DATABASE:'app',MARIADB_USER:'app',MARIADB_PASSWORD_FILE:'/run/secrets/db_password',MARIADB_ROOT_PASSWORD_FILE:'/run/secrets/db_password'},volumes:['data:/var/lib/mysql'],healthcheck:{test:['CMD','healthcheck.sh','--connect','--innodb_initialized'],interval:'5s',timeout:'5s',retries:20}});}
 if(id==='redis'){Object.assign(s,{image:'redis:7.4-bookworm',volumes:['data:/data'],command:['sh','-c','exec /usr/local/bin/docker-entrypoint.sh redis-server --appendonly yes --requirepass "$$(cat /run/secrets/db_password)"'],healthcheck:{test:['CMD-SHELL','REDISCLI_AUTH="$$(cat /run/secrets/db_password)" redis-cli ping | grep -q PONG'],interval:'5s',timeout:'5s',retries:12}});}
 return composeProject(name,compose,`command -v openssl >/dev/null\nopenssl rand -hex 24 > ${quote(path+'/password.txt')}\nchmod 600 ${quote(path+'/password.txt')}\n`,freePort(n))+`echo 'Данные доступа: пользователь app, база app (для SQL). Пароль: ${path}/password.txt. Используйте SSH-туннель на порт ${n}.'\n`;
}
export function recipeScript(id:string,p:Record<string,string>,profile:Profile,sshPort:number):string{
 switch(id){
 case 'base':return debianGuard+'apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git python3 jq htop unzip openssl\n';
 case 'upgrade':return debianGuard+'apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::="--force-confold" upgrade -y\nif [ -f /var/run/reboot-required ]; then echo "Требуется перезагрузка; выполните её в согласованное время."; fi\n';
 case 'timezone':{const tz=p.timezone||'';if(!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz))throw new Error('Некорректный часовой пояс');return `timedatectl set-timezone ${quote(tz)}\ntimedatectl\n`;}
 case 'docker':return debianGuard+`if command -v docker >/dev/null; then echo 'Docker уже установлен. Используйте существующий.'; exit 1; fi
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo 'Нужен Debian или Ubuntu'; exit 1;; esac
`+newPath('/etc/apt/sources.list.d/docker.sources')+`apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl --fail --location --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
`;
 case 'admin':{const user=slug(p.name||'');const key=(p.key||'').trim();if(!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(key))throw new Error('Нужен публичный SSH-ключ, одной строкой');return debianGuard+`if id ${quote(user)} >/dev/null 2>&1; then echo 'Пользователь уже существует'; exit 1; fi\ncommand -v sudo >/dev/null\n`+newPath('/etc/sudoers.d/vpst-'+user)+`useradd --create-home --shell /bin/bash ${quote(user)}\ninstall -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh\n`+writeFile(`/home/${user}/.ssh/authorized_keys`,key+'\n')+`chown ${user}:${user} /home/${user}/.ssh/authorized_keys\n`+writeFile(`/etc/sudoers.d/vpst-${user}`,`${user} ALL=(ALL:ALL) NOPASSWD: ALL\n`,'440')+`visudo -cf /etc/sudoers.d/vpst-${user}\necho 'Проверьте вход новым профилем по ключу перед изменением SSH.'\n`;}
 case 'fail2ban':return debianGuard+newPath('/etc/fail2ban/jail.d/vps-tuner.local')+`apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban python3-systemd\n`+writeFile('/etc/fail2ban/jail.d/vps-tuner.local',`[sshd]\nenabled = true\nbackend = systemd\nport = ${port(sshPort)}\nmaxretry = 6\nfindtime = 10m\nbantime = 1h\n`,'644')+`fail2ban-client -t\nsystemctl enable --now fail2ban\nsystemctl restart fail2ban\n`;
 case 'fail2ban-status':return 'fail2ban-client status sshd\n';
 case 'ufw-install':return debianGuard+'apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y ufw\nufw status verbose\n';
 case 'ufw-allow':{const proto=p.protocol||'tcp';if(!['tcp','udp'].includes(proto))throw new Error('Выберите tcp или udp');return `ufw allow ${port(p.port)}/${proto}\nufw status verbose\n`;}
 case 'ufw-enable':{const ssh=port(sshPort);const ports=(p.ports||'').split(',').map(x=>x.trim()).filter(Boolean);for(const x of ports){if(!/^\d+\/(tcp|udp)$/.test(x))throw new Error('Порты: 80/tcp,443/tcp,51820/udp');port(x.split('/')[0]);}return `command -v ufw >/dev/null
command -v systemd-run >/dev/null
if ufw status | grep -q 'Status: active'; then echo 'UFW уже активен: используйте отдельные правила'; exit 1; fi
if systemctl is-active --quiet vpst-firewall-rollback.timer; then echo 'Уже ожидается подтверждение firewall'; exit 1; fi
install -d -m 700 /var/lib/vps-tuner
cp -a /etc/ufw /var/lib/vps-tuner/ufw-before-$(date +%Y%m%d-%H%M%S)
ufw allow ${ssh}/tcp comment 'VPS Tuner SSH'
${ports.map(x=>'ufw allow '+x).join('\n')}
systemd-run --unit=vpst-firewall-rollback --on-active=120s --timer-property=AccuracySec=1s /usr/sbin/ufw disable
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
printf '%s' ${quote(randomUUID())} > /var/lib/vps-tuner/firewall-pending
echo 'Отключитесь, подключитесь заново и подтвердите firewall в течение 120 секунд. Без подтверждения UFW автоматически отключится.'
ufw status verbose
`;}
 case 'ufw-confirm':return `test -f /var/lib/vps-tuner/firewall-pending\nsystemctl is-active --quiet vpst-firewall-rollback.timer\nufw status | grep -q 'Status: active'\nsystemctl stop vpst-firewall-rollback.timer\nrm /var/lib/vps-tuner/firewall-pending\necho 'Firewall подтверждён. Автооткат отменён.'\n`;
 case 'postgres':case 'mariadb':case 'redis':return database(id,p);
 case 'db-backup':{const n=slug(p.name||'');if(!['postgres','mariadb'].includes(p.engine))throw new Error('Выберите СУБД');const inner=p.engine==='postgres'?'PGPASSWORD="$(cat /run/secrets/db_password)" pg_dump -U app --format=plain app':'mariadb-dump -uapp --password="$(cat /run/secrets/db_password)" --single-transaction app';return dockerGuard+`cd /opt/vps-tuner/${n}\ntest -f compose.yaml\ninstall -d -m 700 /var/backups/vps-tuner\nfile=/var/backups/vps-tuner/${n}-$(date +%Y%m%d-%H%M%S).sql.gz\ndocker compose exec -T database sh -c ${quote(inner)} | gzip > "$file.partial"\nmv "$file.partial" "$file"\necho "Дамп сохранён: $file"\n`;}
 case 'static':{const n=slug(p.name||''),pnum=port(p.port||'8080'),path='/opt/vps-tuner/'+n;const html=p.html||'';if(!html.trim())throw new Error('Добавьте HTML');return composeProject(n,{name:'vpst-'+n,services:{web:{image:'nginx:1.28-alpine',restart:'unless-stopped',ports:[`${pnum}:80`],volumes:['./html:/usr/share/nginx/html:ro'],logging:logOptions()}}},`install -d -m 755 ${path}/html\n`+writeFile(path+'/html/index.html',html,'644'),freePort(pnum));}
 case 'proxy':{const n=slug(p.name||''),d=domain(p.domain||''),upstream=port(p.upstream||'8080');return composeProject(n,{name:'vpst-'+n,services:{web:{image:'caddy:2.10-alpine',restart:'unless-stopped',network_mode:'host',volumes:['./Caddyfile:/etc/caddy/Caddyfile:ro','data:/data','config:/config'],logging:logOptions()}},volumes:{data:{},config:{}}},writeFile('/opt/vps-tuner/'+n+'/Caddyfile',`{\n admin off\n}\n${d} {\n reverse_proxy 127.0.0.1:${upstream}\n}\n`,'644'),freePort(80)+freePort(443)+freePort(443,'udp'));}
 case 'app':case 'git-app':{const n=slug(p.name||'');const s:any={restart:'unless-stopped',environment:parseEnv(p.env||''),logging:logOptions()};let extra='',guard='';if(p.port){const pp=port(p.port),cp=port(p.containerPort);s.ports=[`127.0.0.1:${pp}:${cp}`];guard=freePort(pp);}if(id==='app'){s.image=imageName(p.image||'');}else{const url=new URL(p.repo||'');if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/[a-zA-Z0-9/_.-]+$/.test(url.pathname))throw new Error('Нужен HTTPS Git URL без пароля и параметров');if(!/^[a-fA-F0-9]{40}$/.test(p.commit||''))throw new Error('Нужен полный SHA коммита');const path='/opt/vps-tuner/'+n+'/source';extra=`command -v git >/dev/null\ngit init ${quote(path)}\ngit -C ${quote(path)} remote add origin ${quote(url.toString())}\nGIT_TERMINAL_PROMPT=0 git -C ${quote(path)} fetch --depth 1 origin ${quote(p.commit)}\ngit -C ${quote(path)} checkout --detach FETCH_HEAD\ntest "$(git -C ${quote(path)} rev-parse HEAD)" = ${quote(p.commit.toLowerCase())}\ntest -f ${quote(path+'/Dockerfile')}\n`;s.build='./source';}return composeProject(n,{name:'vpst-'+n,services:{app:s}},extra,guard);}
 case 'backup':{const path=absolutePath(p.path||'');if(!/^\/(opt|srv|var\/www|home)\//.test(path))throw new Error('Допускаются проекты в /opt, /srv, /var/www, /home');return `test -d ${quote(path)}\ninstall -d -m 700 /var/backups/vps-tuner\nfile=/var/backups/vps-tuner/files-$(date +%Y%m%d-%H%M%S).tar.gz\ntar --one-file-system -czf "$file.partial" -C ${quote(path)} .\nmv "$file.partial" "$file"\necho "Архив: $file"\n`;}
 case 'awg':return awgInstall(p);
 case 'awg-client':return awgClient(p,profile);
 case 'awg-revoke':return awgRevoke(p);
 case 'xray':return xrayInstall(p,profile);
 case 'xray-client':return xrayClient(p);
 case 'xray-revoke':return xrayClient(p,true);
 case 'wdtt':return wdttInstall(p,profile);
 default:throw new Error('Неизвестный сценарий');
 }
}
export function buildPlan(action:ActionRequest,profile:Profile,session:string,snapshot:Snapshot|null,sshPort:number):InternalPlan{
 let title='',description='',script='',root=true,risk:Plan['risk']='change',warnings:string[]=[];
 if(action.type==='recipe'){
  const recipe=recipes.find(r=>r.id===action.id);if(!recipe)throw new Error('Сценарий не найден');title=recipe.name;description=recipe.description;
  if(!snapshot)throw new Error('Сначала выполните аудит сервера');
  if(['base','upgrade','docker','admin','fail2ban','ufw-install','xray','wdtt'].includes(action.id)&&!['debian','ubuntu'].includes(snapshot.osId))throw new Error('Эта автоустановка поддерживает Debian/Ubuntu. Для другой ОС доступны аудит и управление существующими службами.');
  script=recipeScript(action.id,action.params||{},profile,sshPort);
  if(['ufw-enable','admin','upgrade','wdtt'].includes(action.id))risk='critical';
  if(action.id==='ufw-enable')warnings.push('Перечислите порты всех работающих проектов, включая VPN. После включения переподключитесь по SSH и подтвердите firewall за 120 секунд. Иначе UFW отключится. Docker публикует порты своими правилами и может обходить UFW.');
  if(action.id==='admin')warnings.push('Новый пользователь получит права root через sudo без пароля. Сначала проверьте вход по его ключу.');
  if(action.id==='upgrade')warnings.push('Обновление может перезапустить работающие службы. Запланируйте окно обслуживания.');
  if(['awg','wdtt'].includes(action.id))warnings.push('VPN меняет маршрутизацию/NAT. Проверьте пересечение подсетей и firewall провайдера. Проходимость блокировок зависит от сети и клиента.');
  if(action.id==='awg')warnings.push('Первая сборка выполняется на VPS и может занять 5–15 минут. Нужны Docker, TUN, свободная подсеть 10.77.0.0/24 и около 2 ГБ свободного места.');
  if(action.id==='xray')warnings.push('Проверьте, что TLS-сайт поддерживает TLS 1.3 и доступен с VPS. TCP-порт нужно разрешить в firewall.');
  if(action.id==='proxy')warnings.push('A/AAAA-записи домена должны указывать на VPS, порты 80 и 443 должны быть доступны извне.');
  if(action.id==='git-app')warnings.push('Dockerfile из выбранного репозитория выполняется при сборке на VPS. Используйте проверенный код.');
  if(action.id==='backup')warnings.push('Архив содержит файлы, в том числе секреты. Живые данные БД и Docker volumes этим сценарием не копируются.');
  if(action.id==='fail2ban-status')risk='read';
 }else if(action.type==='service'||action.type==='container'){
  const verb=action.verb||'';if(!['start','stop','restart','enable','disable'].includes(verb))throw new Error('Недопустимое действие');
  if(action.type==='service'){const u=unit(action.id);if(/^(ssh|sshd)(@.*)?\.service$/.test(u))throw new Error('Изменение SSH-службы через быстрые кнопки запрещено: это может оборвать доступ');script=`systemctl ${verb} -- ${quote(u)}\nsystemctl show --property=ActiveState,SubState,UnitFileState -- ${quote(u)}\n`;}
  else{if(['enable','disable'].includes(verb))throw new Error('У Docker используются start/stop/restart');script=`docker ${verb} ${quote(containerId(action.id))}\n`;}
  title=`${action.id}: ${verb}`;warnings.push('Операция повлияет на выбранную службу и её подключения.');
 }else if(action.type==='logs'){
  title='Журнал: '+action.id;risk='read';
  script=action.verb==='container'?`docker logs --tail 200 --timestamps ${quote(containerId(action.id))} 2>&1\n`:`journalctl -u ${quote(unit(action.id))} -n 200 --no-pager --output=short-iso\n`;
 }else if(action.type==='compose'){
  const path=absolutePath(action.id);const verb=action.verb||'';const commands:Record<string,string>={up:'up -d --wait --wait-timeout 120',stop:'stop',restart:'restart',pull:'pull',logs:'logs --tail 200 --no-color',status:'ps -a'};
  if(!commands[verb])throw new Error('Неизвестное Compose-действие');
  if(!snapshot?.projects.some(p=>p.path===path&&p.kind==='Compose'))throw new Error('Проект отсутствует в последнем аудите');
  script=dockerGuard+`cd ${quote(path)}\ndocker compose ${commands[verb]}\n`;title=`Compose: ${verb}`;description=path;risk=['logs','status'].includes(verb)?'read':'change';
  if(verb==='pull')warnings.push('Будут загружены образы текущих тегов. Для применения выполните «Запустить».');
 }else if(action.type==='read-config'){
  const path=absolutePath(action.id);
  if(!/^\/opt\/vps-tuner\/(awg\/clients\/[a-z][a-z0-9-]{1,39}\.conf|xray\/clients\/[a-z][a-z0-9-]{1,39}\.txt|[a-z][a-z0-9-]{1,39}\/password\.txt)$/.test(path))throw new Error('Можно читать только клиентские конфиги и пароли проектов VPS Tuner');
  title='Показать данные доступа';description=path;risk='read';warnings.push('В выводе будет секрет. Сохраните его в безопасном месте и очистите вывод после использования.');script=`test -f ${quote(path)}\ncat -- ${quote(path)}\n`;
 }else if(action.type==='command'){
  script=action.params?.script||'';if(!script.trim())throw new Error('Введите команды');if(script.length>64000)throw new Error('Скрипт слишком большой');title='Свой Bash-сценарий';description='Выполнение на подключённом VPS';risk='critical';root=action.params?.root==='true';warnings.push('Это произвольные команды на VPS. Проверьте весь сценарий. Интерактивный ввод не поддерживается.');
 }else throw new Error('Неизвестная операция');
 if(action.type==='recipe'&&action.id==='ufw-enable')script+=writeFile('/var/lib/vps-tuner/firewall-session',session);
 if(action.type==='recipe'&&action.id==='ufw-confirm')script="test \"$(cat /var/lib/vps-tuner/firewall-session)\" != "+quote(session)+" || { echo 'Сначала переподключитесь по SSH'; exit 1; }\n"+script;
 const command=scriptHeader+script;
 // Preview exactly the command. Sensitive user-provided environment values are visible only here, never persisted.
 return {id:randomUUID(),title,description,script:command,command,warnings,root,risk,expiresAt:Date.now()+300000,session,action};
}
