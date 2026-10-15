#!/usr/bin/env python3
"""Add only the pilot A record after HTTPS has passed its --resolve check."""
import json,subprocess
from urllib.parse import urlencode
from urllib.request import Request,urlopen
host='tilknytning.hackaton'
env=dict(v.split('=',1) for v in json.loads(subprocess.check_output(['docker','inspect','server-infrastructure-traefik-1']))[0]['Config']['Env'] if '=' in v)
query=urlencode({'teamId':env['VERCEL_TEAM_ID']})
def api(path,data=None):
    req=Request('https://api.vercel.com'+path+'?'+query,data=json.dumps(data).encode() if data else None,headers={'Authorization':'Bearer '+env['VERCEL_API_TOKEN'],'Content-Type':'application/json'})
    with urlopen(req,timeout=30) as r:return json.load(r)
records=api('/v5/domains/demokratiloftet.no/records')['records']
matches=[r for r in records if r['name']==host and r['type'] in ['A','AAAA','CNAME']]
if any(r['type']!='A' or r['value']!='187.124.129.149' for r in matches):raise ValueError('Conflicting pilot DNS; refusing overwrite')
if not matches:api('/v2/domains/demokratiloftet.no/records',{'name':host,'type':'A','value':'187.124.129.149','ttl':60})
print(host+'.demokratiloftet.no points to the VPS')
