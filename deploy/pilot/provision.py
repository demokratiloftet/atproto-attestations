#!/usr/bin/env python3
"""Run on the VPS as operator. Enrol only synthetic accounts on its private PDS.
Secrets are kept in root-only files and never printed. Safe to rerun after a
partial account creation: each password/handle is persisted before the call.
"""
import json, os, secrets, subprocess, sys
from pathlib import Path
ROOT=Path('/root/affiliation-pilot')
HOST='tilknytning.hackaton.demokratiloftet.no'
NODE='node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205'
os.umask(0o077)
ROOT.mkdir(exist_ok=True)
private=ROOT/'.runtime';private.mkdir(exist_ok=True);private.chmod(0o700)
account_file=private/'accounts.json'
accounts=json.loads(account_file.read_text()) if account_file.exists() else []
manifest_path=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]/'examples/affiliation-demo.json'
manifest=json.loads(manifest_path.read_text())
labels=[(a['slug'],a['name']) for a in manifest['accounts']]
if len({slug for slug,_ in labels})!=len(labels):raise ValueError('Duplicate account slug')
import re
if any(not re.fullmatch(r'[a-z][a-z0-9-]{0,18}',slug) for slug,_ in labels):raise ValueError('Invalid account slug')
known={slug for slug,_ in labels}
if not set(manifest['people'])<=known:raise ValueError('Unknown person')
for org in manifest['organisations']:
 if org['account'] not in known or not set(org['approvers'])<=set(manifest['people']):raise ValueError('Invalid organisation references')
script='''
process.on('unhandledRejection',error=>{console.error(error.message);process.exit(1)});
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));}));
async function call(method,body,auth){const r=await fetch('http://127.0.0.1:3000/xrpc/'+method,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:auth}:{})},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(method+': '+d.error+': '+d.message);return d;}
let session;
try{session=await call('com.atproto.server.createSession',{identifier:input.handle,password:input.password});}
catch{
 const invite=await call('com.atproto.server.createInviteCode',{useCount:1},'Basic '+Buffer.from('admin:'+process.env.PDS_ADMIN_PASSWORD).toString('base64'));
 session=await call('com.atproto.server.createAccount',{handle:input.handle,email:input.slug+'@affiliation.example.invalid',password:input.password,inviteCode:invite.code});
}
await call('com.atproto.repo.putRecord',{repo:session.did,collection:'app.bsky.actor.profile',rkey:'self',record:{$type:'app.bsky.actor.profile',displayName:input.name,description:'Syntetisk demokonto for tilknytningspiloten. Ingen reell arbeidstilknytning.'}},'Bearer '+session.accessJwt);
console.log(JSON.stringify({did:session.did}));
'''
# Script is a file, input contains secrets on stdin, output is captured privately.
subprocess.run(['docker','exec','-i','hackathon-pds-1','sh','-c','cat > /tmp/affiliation-enrol.mjs'],input=script.encode(),check=True,capture_output=True)
for slug,name in labels:
    item=next((a for a in accounts if a['slug']==slug),None)
    if not item:
        item={'slug':slug,'name':name,'handle':'af-'+slug+'.pds.hackaton.demokratiloftet.no','password':secrets.token_urlsafe(30)}
        accounts.append(item);account_file.write_text(json.dumps(accounts,indent=2));account_file.chmod(0o600)
    if not item.get('did'):
        item['handle']='af-'+slug+'.pds.hackaton.demokratiloftet.no'
        account_file.write_text(json.dumps(accounts,indent=2))
        result=subprocess.run(['docker','exec','-i','hackathon-pds-1','node','/tmp/affiliation-enrol.mjs'],input=json.dumps(item).encode(),capture_output=True)
        if result.returncode:raise RuntimeError('PDS enrolment failed: '+result.stderr.decode()[-300:])
        item.update(json.loads(result.stdout));account_file.write_text(json.dumps(accounts,indent=2));account_file.chmod(0o600)
subprocess.run(['docker','exec','hackathon-pds-1','rm','/tmp/affiliation-enrol.mjs'],check=True,capture_output=True)
by_slug={a['slug']:a for a in accounts}
people=[{k:by_slug[slug][k] for k in ['did','handle','name']} for slug in manifest['people']]
config={'sandbox':True,'origin':'https://'+HOST,'dataDir':'/data','pds':'http://pilot-bridge:3001','pdsCanonical':'https://pds.hackaton.demokratiloftet.no','plc':'http://pilot-bridge:3002','people':people,'organisations':[]}
for org in manifest['organisations']:
    a=by_slug[org['account']]
    enrolled={'did':a['did'],'name':a['name'],'description':'Syntetisk organisasjon i isolert demo. Ingen reelle tilknytninger.','approvers':[by_slug[slug]['did'] for slug in org['approvers']],'issuerHandle':a['handle'],'issuerPassword':a['password'],'scopes':org['scopes']}
    if org.get('domain'):enrolled['domain']=org['domain']
    config['organisations'].append(enrolled)
examples=[dict(example,subject=by_slug[example['subject']]['handle'],organisation=by_slug[example['organisation']]['handle']) for example in manifest.get('examples',[])]
config_path=private/'pilot.json';config_path.write_text(json.dumps(config,indent=2));config_path.chmod(0o600);os.chown(config_path,1000,1000)
login_path=private/'demo-logins.json';login_path.write_text(json.dumps({'url':'https://'+HOST,'accounts':[{k:by_slug[slug][k] for k in ['name','handle','password']} for slug in manifest['people']], 'seedId':manifest.get('seedId','examples-v1'), 'examples':examples},indent=2));login_path.chmod(0o600)
keyfile=private/'auth-key'
if not keyfile.exists():keyfile.write_text(secrets.token_hex(32))
keyfile.chmod(0o600);os.chown(keyfile,1000,1000)
restricted={'init':True,'restart':'unless-stopped','read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'pids_limit':128,'logging':{'driver':'json-file','options':{'max-size':'5m','max-file':'2'}}}
services={
 'app':dict(restricted,image='affiliation-pilot:demo',user='1000:1000',mem_limit='384m',cpus=1.0,environment={'HOST':'0.0.0.0','PORT':'3013','PILOT_CONFIG_FILE':'/config/pilot.json','AUTH_ENCRYPTION_KEY_FILE':'/config/auth-key'},volumes=['pilot-data:/data','./.runtime/pilot.json:/config/pilot.json:ro','./.runtime/auth-key:/config/auth-key:ro'],networks=['sandbox'],dns=['127.0.0.1'],tmpfs=['/tmp:rw,nosuid,nodev,size=32m,mode=1777']),
 'pilot-bridge':dict(restricted,image=NODE,user='1000:1000',mem_limit='64m',cpus=0.25,command=['node','/bridge.mjs'],volumes=['./bridge.mjs:/bridge.mjs:ro'],networks=['sandbox','services'],dns=['127.0.0.1']),
 'public':dict(restricted,image=NODE,user='1000:1000',mem_limit='64m',cpus=0.25,command=['node','/public.mjs'],volumes=['./public.mjs:/public.mjs:ro'],networks={'sandbox':{},'public':{'ipv4_address':'10.249.99.14'}},dns=['127.0.0.1'])}
compose={'name':'affiliation-pilot','services':services,'volumes':{'pilot-data':{}},'networks':{'sandbox':{'internal':True},'services':{'external':True,'name':'hackathon-services'},'public':{'external':True,'name':'hackathon-public'}}}
(ROOT/'compose.json').write_text(json.dumps(compose,indent=2))
bridge='''import net from 'node:net';
function forward(port,host,targetPort){const s=net.createServer(client=>{const remote=net.connect(targetPort,host);const close=()=>{client.destroy();remote.destroy();};client.on('error',close);remote.on('error',close);client.on('close',close);remote.on('close',close);client.setTimeout(30000,close);remote.setTimeout(30000,close);client.pipe(remote).pipe(client);});s.maxConnections=64;s.listen(port,'0.0.0.0');}
'''
(ROOT/'bridge.mjs').write_text(bridge+"forward(3001,'hackathon-pds',3000);forward(3002,'plc-bridge',3000);\n")
(ROOT/'public.mjs').write_text(bridge+"forward(3000,'app',3013);\n")
for name in ['bridge.mjs','public.mjs']:(ROOT/name).chmod(0o644)
print(f'Prepared {len(labels)} synthetic accounts and {len(config["organisations"])} organisations. Secrets retained in private files.')
