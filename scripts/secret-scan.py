#!/usr/bin/env python3
"""Scan all reachable history with a checksum-pinned upstream Gitleaks binary."""
import hashlib
import io
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

version='8.30.1'
platforms={('Linux','x86_64'):('linux_x64','551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'),
 ('Darwin','arm64'):('darwin_arm64','b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5')}
name,digest=platforms[(platform.system(),platform.machine())]
url=f'https://github.com/gitleaks/gitleaks/releases/download/v{version}/gitleaks_{version}_{name}.tar.gz'
with urllib.request.urlopen(url,timeout=60) as response:data=response.read(32*1024*1024)
if hashlib.sha256(data).hexdigest()!=digest:raise SystemExit('Scanner checksum mismatch')
with tempfile.TemporaryDirectory(prefix='gtd-scanner-') as directory:
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
  member=archive.getmember('gitleaks')
  if not member.isfile() or member.size>64*1024*1024:raise SystemExit('Invalid scanner binary')
  binary=Path(directory)/'gitleaks';binary.write_bytes(archive.extractfile(member).read());binary.chmod(0o700)
 subprocess.run([str(binary),'git','--redact','--no-banner','--log-opts=--all'],check=True,cwd=Path(__file__).resolve().parents[1])
