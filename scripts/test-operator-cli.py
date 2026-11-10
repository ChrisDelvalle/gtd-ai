#!/usr/bin/env python3
"""Rehearse documented operator commands on new disposable local state only.

Requires built images, Restic, and Linux Docker host networking. No gateway or
application ingress is started. The networkless acceptance suite separately
covers real website, tasks, invitations, search, recurrence, and OAuth behavior.
"""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'deploy'))
import gtd


def main():
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='gtd-operator-cli-') as temp:
        directory=Path(temp).resolve();state=directory/'installation';restored=directory/'restored'
        config=directory/'installation.toml';repository=directory/'backup'
        source=(ROOT/'installation.example.toml').read_text().replace('/srv/gtd',str(state))
        source=source.replace('environment = "production"','environment = "staging"')
        source=source.replace('.example.com','-staging.test').replace('admin_username = "owner"','admin_username = "first-admin"')
        source=source.replace('ingress = "direct"','ingress = "tunnel"')
        config.write_text(source)
        def command(*args,ok=True):
            result=subprocess.run([sys.executable,*args],cwd=ROOT,capture_output=True,timeout=900)
            if (result.returncode==0)!=ok:raise RuntimeError('Disposable operator command returned an unexpected outcome: '+args[0]+' '+args[-1])
            return result
        def cli(action,*extra,ok=True):
            args=['deploy/gtd.py','--config',str(config)]
            if (state/'manifest.json').exists():args+=['--expected-database',json.loads((state/'manifest.json').read_text())['database_identity']]
            return command(*args,*extra,action,ok=ok)
        try:
            cli('validate');cli('prepare')
            manifest=gtd.read_manifest(state);identity=manifest['database_identity']
            cli('prepare',ok=False)
            cli('bootstrap');cli('bootstrap')
            assert gtd.read_manifest(state)['enrolled']
            before=(state/'operator/owner.json').read_bytes()
            config.write_text(source.replace('America/New_York','Europe/Berlin'))
            cli('bootstrap',ok=False);assert (state/'operator/owner.json').read_bytes()==before
            config.write_text(source)
            cli('backup-init','--repository',str(repository))
            cli('backup','--repository',str(repository))
            receipt=gtd.private_read(state/'operator/verified-backup.json')
            cli('stop')
            command('deploy/recover.py','--repository',str(repository),'--password-file',str(state/'operator/backup.secret'),
                '--snapshot',receipt['snapshot'],'--expected-database',identity,'--state-dir',str(restored))
            recovered=gtd.read_manifest(restored,identity)
            assert recovered['enrolled'] and not recovered['recovery_pending'] and not recovered['ingress_published']
            assert recovered['project']!=manifest['project']
            assert not gtd.compose(restored,'ps','--status','running','--format','json').strip()
            command('deploy/recover.py','--repository',str(repository),'--password-file',str(state/'operator/backup.secret'),
                '--snapshot',receipt['snapshot'],'--expected-database',identity,'--state-dir',str(restored),ok=False)
            print('Documented CLI: fresh enrollment, repeat/configuration guards, encrypted backup and isolated recovery passed.')
        finally:
            for root in (restored,state):
                if (root/'compose.json').exists():
                    manifest=gtd.read_manifest(root)
                    if manifest['environment']!='staging' or root.parent!=directory:raise RuntimeError('Refusing non-fixture cleanup')
                    gtd.compose(root,'--profile','application','down','--volumes','--remove-orphans')

if __name__=='__main__':main()
