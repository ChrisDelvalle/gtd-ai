"""Pinned upstream release. Archive digests are from the release's SHA256SUMS."""
import bz2
import hashlib
import os
import pathlib
import platform
import subprocess
import urllib.request

VERSION = '0.19.1'
SHA256 = {
    'darwin_arm64': '7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143',
    'linux_amd64': 'f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c',
}


def install(destination):
    destination = pathlib.Path(destination)
    target = platform.system().lower() + '_' + {'aarch64': 'arm64', 'x86_64': 'amd64'}.get(platform.machine(), platform.machine())
    name = f'restic_{VERSION}_{target}.bz2'
    expected = SHA256[target]
    with urllib.request.urlopen(f'https://github.com/restic/restic/releases/download/v{VERSION}/{name}', timeout=60) as response:
        archive = response.read(64 * 1024 * 1024)
    if hashlib.sha256(archive).hexdigest() != expected:
        raise RuntimeError('Restic download checksum mismatch')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = destination.with_suffix('.new')
    with temporary.open('wb') as out:
        out.write(bz2.decompress(archive)); out.flush(); os.fsync(out.fileno())
    temporary.chmod(0o755)
    version = subprocess.check_output([str(temporary), 'version'], text=True)
    if not version.startswith(f'restic {VERSION} '):
        raise RuntimeError('Unexpected Restic version')
    temporary.replace(destination)
    return str(destination)
