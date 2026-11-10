#!/usr/bin/env python3
"""Build every deployment image from source; no installation credentials used."""
from pathlib import Path
import json
import os
import subprocess
import sys
import time

root=Path(__file__).resolve().parents[1]
output=root/'artifacts'/('keycloak-'+str(time.time_ns()))
output.parent.mkdir(exist_ok=True)
subprocess.run([sys.executable,str(root/'deploy/keycloak/build-keycloak-patch.py'),str(output)],check=True)
provenance=json.loads((output/'build.json').read_text())
actual=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',provenance['image']],text=True).strip()
if actual!=provenance['image_id']:raise SystemExit('Patched identity image changed during build')
revision=subprocess.run(['git','rev-parse','HEAD'],cwd=root,capture_output=True,text=True)
if revision.returncode==0:os.environ.setdefault('GTD_SOURCE_REVISION',revision.stdout.strip())
subprocess.run(['docker','compose','-f',str(root/'compose.yaml'),'build'],cwd=root,check=True)
print('Built service, adapter, operator, identity and gateway images. No services started.')
