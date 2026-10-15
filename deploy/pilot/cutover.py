#!/usr/bin/env python3
"""Add the reviewed pilot route, preserving all other compose services and routes."""
import hashlib,json,subprocess,shutil,os
from pathlib import Path
os.umask(0o077)
root=Path('/root/affiliation-pilot');edge=Path('/etc/loftet-deploy/public-hackathon/edge.json')
backup=Path('/root/loftet-rollbacks/affiliation-pilot-20261015');backup.mkdir(exist_ok=True)
wrapper='/root/loftet-social/deploy/compose.sh'
old=json.loads(edge.read_text())
source=next(v.split(':')[0] for v in old['services']['public-gateway']['volumes'] if v.endswith(':/loftet:ro'))
if source==str(root/'gateway'):
    print('Pilot gateway override already selected')
else:
    if hashlib.sha256((Path(source)/'gateway.js').read_bytes()).hexdigest()!='36d4d649f8adf1aa1a90b529bca6c888b26c01da229892d8642f96684b8bac38':raise RuntimeError('Gateway changed since inspection; refusing to overwrite')
    shutil.copy2(edge,backup/'edge.json')
    ids=subprocess.check_output(['docker','ps','-q'],text=True).split()
    inspected=json.loads(subprocess.check_output(['docker','inspect',*ids]))
    baseline={i['Name'].lstrip('/'):{'id':i['Id'],'image':i['Image'],'started':i['State']['StartedAt']} for i in inspected}
    (backup/'containers.json').write_text(json.dumps(baseline,indent=2))
    before=json.loads(subprocess.check_output([wrapper,'config','--format','json']))
    old['services']['public-gateway']['volumes']=[str(root/'gateway')+':/loftet:ro' if v.endswith(':/loftet:ro') else v for v in old['services']['public-gateway']['volumes']]
    edge.write_text(json.dumps(old,indent=2)+'\n')
    try:
        after=json.loads(subprocess.check_output([wrapper,'config','--format','json']))
        assert set(before['services'])==set(after['services'])
        assert all(before['services'][n]==after['services'][n] for n in before['services'] if n!='public-gateway')
    except:
        shutil.copy2(backup/'edge.json',edge);raise
    (backup/'rollback.sh').write_text('#!/bin/sh\nset -eu\ncp '+str(backup/'edge.json')+' '+str(edge)+'\n'+wrapper+' up -d --no-deps --no-build --force-recreate --wait public-gateway\n')
    (backup/'rollback.sh').chmod(0o700)
try:
    subprocess.run([wrapper,'up','-d','--no-deps','--no-build','--force-recreate','--wait','public-gateway'],check=True)
    subprocess.run(['curl','--fail','--silent','--show-error','--resolve','tilknytning.hackaton.demokratiloftet.no:443:127.0.0.1','https://tilknytning.hackaton.demokratiloftet.no/health'],check=True)
except:
    if (backup/'edge.json').exists():
        shutil.copy2(backup/'edge.json',edge)
        subprocess.run([wrapper,'up','-d','--no-deps','--no-build','--force-recreate','--wait','public-gateway'],check=True)
    raise
print('\nPilot HTTPS route healthy. Rollback retained at '+str(backup))
