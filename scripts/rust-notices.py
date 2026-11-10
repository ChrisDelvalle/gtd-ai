#!/usr/bin/env python3
"""Collect notices for the locked dependency graph on the build target."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('output',type=Path)
parser.add_argument('--target')
args=parser.parse_args()
target=args.target or next(line.split(': ',1)[1] for line in subprocess.check_output(['rustc','-vV'],text=True).splitlines() if line.startswith('host: '))
metadata=json.loads(subprocess.check_output(['cargo','metadata','--locked','--all-features','--format-version','1','--filter-platform',target],cwd=root))
nodes={n['id']:n for n in metadata['resolve']['nodes']};seen=set();pending=[metadata['resolve']['root']]
while pending:
 ident=pending.pop()
 if ident in seen:continue
 seen.add(ident)
 pending.extend(d['pkg'] for d in nodes[ident]['deps'] if any(k['kind']!='dev' for k in d['dep_kinds']))
extra=json.loads((root/'third_party/license-sources.json').read_text())
extras={(p['package'],p['version']):p for p in extra}
sections=['Third-party Rust dependencies — generated from Cargo.lock for '+target]
missing=[]
for package in sorted(metadata['packages'],key=lambda p:(p['name'],p['version'])):
 if package['id'] not in seen or not package['source']:continue
 directory=Path(package['manifest_path']).parent
 files=[p for p in directory.iterdir() if p.is_file() and p.name.lower().startswith(('license','copying','notice'))]
 key=(package['name'],package['version'])
 if key in extras:
  item=extras[key];p=root/item['file']
  if hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:raise SystemExit('Upstream notice digest differs: '+package['name'])
  files.append(p)
 if not files:missing.append(' '.join(key));continue
 sections.append('\n'+'='*72+'\n'+package['name']+' '+package['version']+'\n'+(package.get('repository') or '')+'\nSPDX: '+(package.get('license') or 'unknown'))
 sections.extend(p.read_text(errors='strict') for p in sorted(set(files)))
if missing:raise SystemExit('Missing third-party notices: '+', '.join(missing))
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text('\n\n'.join(sections)+'\n')
print('Wrote notices for '+str(len(seen)-1)+' dependencies')
