import {hashSync} from 'bcryptjs';
import {quote,port,slug,domain,writeFile,newPath,freePort,debianGuard,dockerGuard} from './validation';
import type {Profile} from '../shared/types';
export const awgGoCommit='b5928efb6ca19f0153958460c3d141f04abc5c2e';
export const awgToolsCommit='ee0f0a9aa34ff0a0da4b3433b9512781cfe02843';
export const awgDockerfile=`FROM golang:1.25-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends git make gcc libc6-dev
WORKDIR /src
RUN git init go && cd go && git remote add origin https://github.com/amnezia-vpn/amneziawg-go.git && git fetch --depth 1 origin ${awgGoCommit} && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "${awgGoCommit}"
RUN cd go && CGO_ENABLED=0 go build -trimpath -o /out/amneziawg-go .
RUN git init tools && cd tools && git remote add origin https://github.com/amnezia-vpn/amneziawg-tools.git && git fetch --depth 1 origin ${awgToolsCommit} && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "${awgToolsCommit}" && make -C src
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash iproute2 iptables procps ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/amneziawg-go /usr/local/bin/amneziawg-go
COPY --from=builder /src/tools/src/wg /usr/local/bin/awg
COPY --from=builder /src/tools/src/wg-quick/linux.bash /usr/local/bin/awg-quick
RUN chmod 755 /usr/local/bin/awg-quick
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["bash", "/entrypoint.sh"]
`;
const awgEntry=String.raw`set -Eeuo pipefail
umask 077
conf=/etc/amnezia/amneziawg
if [ ! -s "$conf/awg0.conf" ]; then
  awg genkey > "$conf/server.key"
  awg pubkey < "$conf/server.key" > "$conf/server.pub"
  cat > "$conf/params" <<PARAMS
Jc = 4
Jmin = 40
Jmax = 70
S1 = 64
S2 = 96
H1 = $((100000000 + $(od -An -N4 -tu4 /dev/urandom) % 100000000))
H2 = $((300000000 + $(od -An -N4 -tu4 /dev/urandom) % 100000000))
H3 = $((500000000 + $(od -An -N4 -tu4 /dev/urandom) % 100000000))
H4 = $((700000000 + $(od -An -N4 -tu4 /dev/urandom) % 100000000))
PARAMS
  cat > "$conf/awg0.conf" <<CONF
[Interface]
Address = 10.77.0.1/24
ListenPort = $AWG_PORT
PrivateKey = $(cat "$conf/server.key")
MTU = 1280
$(cat "$conf/params")
PostUp = iptables -t nat -A POSTROUTING -s 10.77.0.0/24 -o eth0 -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s 10.77.0.0/24 -o eth0 -j MASQUERADE
CONF
fi
awg-quick up "$conf/awg0.conf"
trap 'awg-quick down "$conf/awg0.conf"; exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
`;
export function awgInstall(p:Record<string,string>){
 const n=port(p.port||'51820'),path='/opt/vps-tuner/awg';
 const compose={name:'vpst-awg',services:{vpn:{build:'.',container_name:'vpst-awg',restart:'unless-stopped',cap_add:['NET_ADMIN'],devices:['/dev/net/tun:/dev/net/tun'],sysctls:{'net.ipv4.ip_forward':'1'},ports:[`${n}:${n}/udp`],environment:{AWG_PORT:String(n)},volumes:['./config:/etc/amnezia/amneziawg'],healthcheck:{test:['CMD','awg','show','awg0'],interval:'15s',timeout:'5s',retries:5},logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}}}}};
 return dockerGuard+`test -c /dev/net/tun || { echo 'На VPS недоступен TUN'; exit 1; }\n`+freePort(n,'udp')+newPath(path)+`install -d -m 700 ${path}/config ${path}/clients\n`+writeFile(path+'/Dockerfile',awgDockerfile)+writeFile(path+'/entrypoint.sh',awgEntry)+writeFile(path+'/compose.yaml',JSON.stringify(compose,null,2))+`cd ${path}\ndocker compose -f compose.yaml config --quiet\ndocker compose -f compose.yaml up -d --build --wait --wait-timeout 90\necho 'AmneziaWG установлен. Добавьте отдельного клиента для каждого устройства.'\n`;
}
export function awgClient(p:Record<string,string>,profile:Profile){
 const name=slug(p.name||''),addr=Number(p.address||'2');if(!Number.isInteger(addr)||addr<2||addr>254)throw new Error('Номер адреса клиента: 2–254');
 const host=profile.host.includes(':')?`[${profile.host}]`:profile.host;
 return dockerGuard+`cd /opt/vps-tuner/awg\ntest -s config/awg0.conf\n`+newPath(`/opt/vps-tuner/awg/clients/${name}.conf`)+`if grep -qF 'AllowedIPs = 10.77.0.${addr}/32' config/awg0.conf; then echo 'Адрес клиента занят'; exit 1; fi
key=$(docker exec vpst-awg awg genkey)
pub=$(printf '%s' "$key" | docker exec -i vpst-awg awg pubkey)
server=$(cat config/server.pub)
listen=$(awk '/^ListenPort/{print $3}' config/awg0.conf)
cat > clients/${name}.conf <<CONF
[Interface]
PrivateKey = $key
Address = 10.77.0.${addr}/32
DNS = 1.1.1.1
MTU = 1280
$(cat config/params)

[Peer]
PublicKey = $server
Endpoint = ${host}:$listen
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
CONF
cp config/awg0.conf config/awg0.conf.bak
printf '\n# client ${name}\n[Peer]\nPublicKey = %s\nAllowedIPs = 10.77.0.${addr}/32\n' "$pub" >> config/awg0.conf
if ! docker exec vpst-awg awg set awg0 peer "$pub" allowed-ips 10.77.0.${addr}/32; then
  mv config/awg0.conf.bak config/awg0.conf
  rm -f clients/${name}.conf
  exit 1
fi
rm config/awg0.conf.bak
echo 'Клиент создан: /opt/vps-tuner/awg/clients/${name}.conf'
`;
}
export function awgRevoke(p:Record<string,string>){const name=slug(p.name||'');return dockerGuard+`cd /opt/vps-tuner/awg\ntest -f clients/${name}.conf\n`+`python3 - ${quote(name)} <<'PY'
import pathlib,re,subprocess,sys
name=sys.argv[1];path=pathlib.Path('config/awg0.conf');text=path.read_text()
pattern=r'\n# client '+re.escape(name)+r'\n\[Peer\]\nPublicKey = ([A-Za-z0-9+/=]+)\nAllowedIPs = [^\n]+\n'
m=re.search(pattern,text)
if not m: raise SystemExit('Клиент отсутствует в серверном конфиге')
subprocess.run(['docker','exec','vpst-awg','awg','set','awg0','peer',m[1],'remove'],check=True)
path.write_text(text[:m.start()]+text[m.end():]);path.chmod(0o600)
pathlib.Path('clients/'+name+'.conf').unlink()
print('Доступ клиента отозван')
PY
`;}
export function xrayInstall(p:Record<string,string>,profile:Profile){
 const n=port(p.port||'443'),sni=domain(p.sni||'www.microsoft.com'),path='/opt/vps-tuner/xray';
 const server={log:{loglevel:'warning'},inbounds:[{tag:'vless',listen:'0.0.0.0',port:n,protocol:'vless',settings:{clients:[],decryption:'none'},streamSettings:{network:'tcp',security:'reality',realitySettings:{show:false,target:`${sni}:443`,xver:0,serverNames:[sni],privateKey:'',shortIds:[]}}}],outbounds:[{protocol:'freedom',tag:'direct'},{protocol:'blackhole',tag:'block'}],routing:{rules:[{type:'field',ip:['geoip:private'],outboundTag:'block'}]}};
 const unit=`[Unit]\nDescription=VPS Tuner Xray REALITY\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser=vpst-xray\nGroup=vpst-xray\nExecStart=/usr/local/lib/vps-tuner/xray/xray run -config /etc/vps-tuner/xray/config.json\nEnvironment=XRAY_LOCATION_ASSET=/usr/local/lib/vps-tuner/xray\nRestart=on-failure\nRestartSec=5\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n`;
 return debianGuard+freePort(n)+newPath(path)+newPath('/etc/vps-tuner/xray')+newPath('/etc/systemd/system/vpst-xray.service')+`apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates unzip python3\ncase "$(uname -m)" in
x86_64) asset=Xray-linux-64.zip; sha=23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae ;;
aarch64) asset=Xray-linux-arm64-v8a.zip; sha=4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c ;;
*) echo 'Поддерживаются x86_64 и arm64'; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --max-time 180 "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/$asset" -o "$tmp/xray.zip"
printf '%s  %s\n' "$sha" "$tmp/xray.zip" | sha256sum -c -
install -d /usr/local/lib/vps-tuner/xray
unzip -q "$tmp/xray.zip" -d /usr/local/lib/vps-tuner/xray
chmod 755 /usr/local/lib/vps-tuner/xray/xray
id vpst-xray >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin vpst-xray
install -d -m 750 -o root -g vpst-xray /etc/vps-tuner/xray
install -d -m 700 ${path}/clients
`+writeFile('/etc/vps-tuner/xray/config.json',JSON.stringify(server,null,2))+writeFile(path+'/meta.json',JSON.stringify({host:profile.host,port:n,sni}))+`python3 - <<'PY'
import json,subprocess,secrets,pathlib,re,uuid,urllib.parse
path=pathlib.Path('/etc/vps-tuner/xray/config.json');config=json.loads(path.read_text())
keys=subprocess.check_output(['/usr/local/lib/vps-tuner/xray/xray','x25519'],text=True)
lines={k.strip().lower().replace(' ',''):v.strip() for k,v in (l.split(':',1) for l in keys.splitlines() if ':' in l)}
private=lines.get('privatekey');public=next((v for k,v in lines.items() if k.startswith('password') or k.startswith('publickey')),None)
if not private or not public: raise SystemExit('Не удалось разобрать ключи Xray')
r=config['inbounds'][0]['streamSettings']['realitySettings'];r['privateKey']=private;r['shortIds']=[secrets.token_hex(8)]
uid=str(uuid.uuid4());config['inbounds'][0]['settings']['clients']=[{'id':uid,'email':'first','flow':'xtls-rprx-vision'}]
path.write_text(json.dumps(config,indent=2))
m=json.loads(pathlib.Path('${path}/meta.json').read_text());m['publicKey']=public;m['shortId']=r['shortIds'][0]
pathlib.Path('${path}/meta.json').write_text(json.dumps(m))
q=urllib.parse.urlencode({'encryption':'none','security':'reality','sni':m['sni'],'fp':'chrome','pbk':public,'sid':m['shortId'],'type':'tcp','flow':'xtls-rprx-vision'})
host='['+m['host']+']' if ':' in m['host'] else m['host']
pathlib.Path('${path}/clients/first.txt').write_text('vless://'+uid+'@'+host+':'+str(m['port'])+'?'+q+'#first\n')
PY
chown root:vpst-xray /etc/vps-tuner/xray/config.json
chmod 640 /etc/vps-tuner/xray/config.json
XRAY_LOCATION_ASSET=/usr/local/lib/vps-tuner/xray /usr/local/lib/vps-tuner/xray/xray run -test -config /etc/vps-tuner/xray/config.json
`+writeFile('/etc/systemd/system/vpst-xray.service',unit,'644')+`systemctl daemon-reload\nsystemctl enable --now vpst-xray\nsleep 2\nsystemctl is-active --quiet vpst-xray\necho 'Xray запущен. Клиент: /opt/vps-tuner/xray/clients/first.txt. Разрешите TCP ${n} в firewall.'\n`;
}
export function xrayClient(p:Record<string,string>,revoke=false){const name=slug(p.name||'');return `command -v python3 >/dev/null\npython3 - ${quote(name)} ${revoke?'remove':'add'} <<'PY'
import json,pathlib,subprocess,uuid,urllib.parse,sys,os
name,action=sys.argv[1:];path=pathlib.Path('/etc/vps-tuner/xray/config.json');old=path.read_text();cfg=json.loads(old)
clients=cfg['inbounds'][0]['settings']['clients'];found=any(c.get('email')==name for c in clients)
if action=='add' and found: raise SystemExit('Имя клиента занято')
if action=='remove' and not found: raise SystemExit('Клиент не найден')
m=json.loads(pathlib.Path('/opt/vps-tuner/xray/meta.json').read_text());dest=pathlib.Path('/opt/vps-tuner/xray/clients/'+name+'.txt')
uid=str(uuid.uuid4())
if action=='add': clients.append({'id':uid,'email':name,'flow':'xtls-rprx-vision'})
else: cfg['inbounds'][0]['settings']['clients']=[c for c in clients if c.get('email')!=name]
try:
 path.write_text(json.dumps(cfg,indent=2))
 subprocess.run(['/usr/local/lib/vps-tuner/xray/xray','run','-test','-config',str(path)],check=True,env={**os.environ,'XRAY_LOCATION_ASSET':'/usr/local/lib/vps-tuner/xray'})
 subprocess.run(['systemctl','restart','vpst-xray'],check=True)
except Exception:
 path.write_text(old);subprocess.run(['systemctl','restart','vpst-xray']);raise
if action=='add':
 q=urllib.parse.urlencode({'encryption':'none','security':'reality','sni':m['sni'],'fp':'chrome','pbk':m['publicKey'],'sid':m['shortId'],'type':'tcp','flow':'xtls-rprx-vision'})
 host='['+m['host']+']' if ':' in m['host'] else m['host']
 dest.write_text('vless://'+uid+'@'+host+':'+str(m['port'])+'?'+q+'#'+name+'\n');dest.chmod(0o600)
 print('Клиент создан: '+str(dest))
else:
 dest.unlink(missing_ok=True);print('Доступ клиента отозван')
PY
`;}
export function wdttInstall(p:Record<string,string>,profile:Profile){
 const pw=p.password||'';if(pw.length<12||pw.length>72)throw new Error('Пароль панели: от 12 до 72 символов');
 const panel={username:'admin',password_hash:hashSync(pw,12),port:2860,web_base_path:'/wdtt/',webListen:'127.0.0.1',subEnable:false,subListen:'127.0.0.1',subPort:2096};
 return debianGuard+[56000,56001,56003,46000].map(p=>freePort(p,'udp')).join('')+freePort(2860)+freePort(2861)+newPath('/etc/wdtt')+newPath('/usr/local/bin/wdtt-app')+newPath('/etc/systemd/system/wdtt.service')+`test -c /dev/net/tun || { echo 'На VPS недоступен TUN'; exit 1; }
if ip -4 route show | grep -Eq '10\\.(66\\.66|70)\\.'; then echo 'Подсеть WDTT пересекается с существующими маршрутами'; exit 1; fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates iproute2 iptables openssl
case "$(uname -m)" in
x86_64) arch=amd64; sha=1fdba07dabd7b9e6afe13d5a598a4d35f4643d5925ec83cbf7a483a7d68ffd87 ;;
aarch64) arch=arm64; sha=567f6e35d9ebeebdf5a0b36334d6fd48c97c6d5dd65fc0a1ffb9628bc2f0f632 ;;
*) echo 'Поддерживаются x86_64 и arm64'; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --max-time 180 "https://github.com/ildarmaga/wdtt/releases/download/v1.5.74/wdtt-linux-$arch" -o "$tmp/wdtt"
printf '%s  %s\n' "$sha" "$tmp/wdtt" | sha256sum -c -
install -m 755 "$tmp/wdtt" /usr/local/bin/wdtt-app
install -d -m 700 /etc/wdtt
`+writeFile('/etc/wdtt/panel.json',JSON.stringify(panel,null,2))+writeFile('/etc/wdtt/inbound.json',JSON.stringify({tag:'wdtt-in',remark:'VPS Tuner',enable:true,listen_host:'0.0.0.0',server_host:profile.host,dtls_port:56000,wg_port:56001,client_port:9000,dns:'1.1.1.1',mtu:1280,max_users:50,handshake_timeout_sec:30,admin_addr:'127.0.0.1:2861'}))+`printf 'MAIN_PASSWORD=%s\n' "$(openssl rand -hex 24)" > /etc/wdtt/install-main-password.env
`+writeFile('/etc/systemd/system/wdtt.service',`[Unit]\nDescription=WDTT server and local panel (VPS Tuner)\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUMask=0077\nExecStartPre=/bin/sh -c 'iptables -C INPUT -p udp --dport 56000 -m comment --comment VPST_WDTT -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 56000 -m comment --comment VPST_WDTT -j ACCEPT'\nExecStart=/usr/local/bin/wdtt-app -config-dir /etc/wdtt\nRestart=on-failure\nRestartSec=5\nLimitNOFILE=65535\n[Install]\nWantedBy=multi-user.target\n`,'644')+`systemctl daemon-reload
systemctl enable --now wdtt
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:2861/health >/dev/null; then
    echo 'WDTT готов. Откройте туннель на 2860 и путь /wdtt/. Логин admin; пароль задан в форме. Создайте пользователей в панели.'
    exit 0
  fi
  sleep 1
done
echo 'WDTT не прошёл проверку готовности. Посмотрите журнал службы.'
exit 1
`;
}
