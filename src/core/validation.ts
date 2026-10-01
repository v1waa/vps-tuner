import {z} from 'zod';
export const profileSchema=z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(80),host:z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:_-]+$/),port:z.number().int().min(1).max(65535),username:z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/),auth:z.enum(['password','key']),keyPath:z.string().max(4096),sudo:z.boolean()});
export const credentialsSchema=z.object({password:z.string().max(4096).optional(),passphrase:z.string().max(4096).optional()});
export const actionSchema=z.object({type:z.enum(['recipe','service','container','logs','compose','command','read-config']),id:z.string().max(512),verb:z.string().max(80).optional(),params:z.record(z.string().max(80),z.string().max(64000)).optional()});
export function quote(value:string):string {if(value.includes('\0'))throw new Error('Нулевой байт в параметре');return "'"+value.replace(/'/g,"'\\''")+"'";}
export function port(value:string|number):number{const n=Number(value);if(!/^\d+$/.test(String(value))||!Number.isInteger(n)||n<1||n>65535)throw new Error('Порт должен быть от 1 до 65535');return n;}
export function slug(value:string):string{if(!/^[a-z][a-z0-9-]{1,39}$/.test(value))throw new Error('Имя: 2–40 латинских букв, цифр или дефисов; первая — буква');return value;}
export function unit(value:string):string{if(!/^[a-zA-Z0-9_@.:-]{1,180}\.service$/.test(value))throw new Error('Некорректное имя systemd-службы');return value;}
export function containerId(value:string):string{if(!/^[a-f0-9]{12,64}$/.test(value))throw new Error('Некорректный ID контейнера');return value;}
export function absolutePath(value:string):string{if(!/^\/(?:[a-zA-Z0-9_.@ -]+\/?)+$/.test(value)||value.split('/').includes('..')||value.includes('\n'))throw new Error('Нужен абсолютный путь без ..');return value;}
export function domain(value:string):string{if(!/^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value))throw new Error('Укажите домен, например app.example.com');return value.toLowerCase();}
export function imageName(value:string):string{if(!/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]{1,220}$/.test(value)||(!value.includes(':')&&!value.includes('@')))throw new Error('Укажите Docker-образ с тегом, например nginx:1.28-alpine');return value;}
export const scriptHeader='set -Eeuo pipefail\nexport LC_ALL=C\nexport PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\numask 077\n';
export const debianGuard="test -f /etc/debian_version || { echo 'Автоустановка поддерживает Debian/Ubuntu'; exit 1; }\ncommand -v apt-get >/dev/null\n";
export const dockerGuard="command -v docker >/dev/null || { echo 'Сначала установите Docker'; exit 1; }\ndocker info >/dev/null\ndocker compose version >/dev/null\n";
export function freePort(n:number,proto='tcp'):string{return `command -v ss >/dev/null\nif [ -n "$(ss -H -ln${proto==='udp'?'u':'t'} 'sport = :${port(n)}')" ]; then echo 'Порт ${n}/${proto} уже занят'; exit 1; fi\n`;}
export function newPath(path:string):string{return `if [ -e ${quote(path)} ] || [ -L ${quote(path)} ]; then echo 'Путь уже существует: установка остановлена'; exit 1; fi\n`;}
export function writeFile(path:string,content:string,mode='600'):string{return `printf %s ${quote(Buffer.from(content).toString('base64'))} | base64 -d > ${quote(path)}\nchmod ${mode} ${quote(path)}\n`;}
