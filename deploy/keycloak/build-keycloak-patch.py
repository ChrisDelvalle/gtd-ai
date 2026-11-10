#!/usr/bin/env python3
"""Build the pinned offline/resource fix without changing services.

The pinned distribution supplies all dependencies. Compile only the affected
source, and prove every other JAR entry is byte-identical before building an
image. Keep this compatibility build until a replacement passes OAuth renewal tests.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import zipfile

BASE = 'quay.io/keycloak/keycloak:26.8.1@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244'
JDK = 'eclipse-temurin:21-jdk@sha256:f9bf7e9fe2f9bc4657537c1a7e20c768f0c3bafca41598263be4714783dd62eb'
SOURCE = 'https://raw.githubusercontent.com/keycloak/keycloak/26.8.1/services/src/main/java/org/keycloak/protocol/oidc/TokenManager.java'
SOURCE_SHA = '4f55098516cad8a56d189baa3173b382ef8410936a6aedd0f114dceecfb61aab'
PATCH_SHA = '9eb37bdc2c693201630acf2813262ce4457f7a1229f4d8a3058e51376d70a4cc'
UPSTREAM = 'f8e6deabe95bc08109912cea3129ab1da6846ad2'
IMAGE = 'gtd-keycloak:26.8.1-offline-resource-1'
JAR = 'org.keycloak.keycloak-services-26.8.1.jar'
PREFIX = 'org/keycloak/protocol/oidc/TokenManager'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop('timeout', 300), **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='New directory for nonsecret build provenance')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    patch = Path(__file__).with_name('keycloak-offline-resource.patch').read_bytes()
    if digest(patch) != PATCH_SHA:
        raise SystemExit('Patch differs from the reviewed four-line change')
    with urllib.request.urlopen(SOURCE, timeout=30) as response:
        source = response.read(256 * 1024)
    if digest(source) != SOURCE_SHA:
        raise SystemExit('Upstream source differs from the reviewed release')
    run('docker', 'pull', JDK)
    with tempfile.TemporaryDirectory(prefix='gtd-keycloak-patch-') as scratch:
        root = Path(scratch)
        source_path = root / 'services/src/main/java/org/keycloak/protocol/oidc/TokenManager.java'
        source_path.parent.mkdir(parents=True)
        source_path.write_bytes(source)
        run('patch', '--batch', '--fuzz=0', '-p1', cwd=root, input=patch)
        patched_sha = digest(source_path.read_bytes())
        (root / 'libs').mkdir()
        container = run('docker', 'create', '--network', 'none', BASE,
                        capture_output=True, text=True).stdout.strip()
        try:
            run('docker', 'cp', container + ':/opt/keycloak/lib/lib/.', str(root / 'libs'))
        finally:
            run('docker', 'rm', container, stdout=subprocess.DEVNULL)
        # Bound compilation and deny network access; no checkpoint credentials
        # or identity volumes are available to the compiler container.
        (root / 'classes').mkdir()
        original_jar = root / 'libs/main' / JAR
        rebuilt_jar = root / JAR
        rebuilt_jar.write_bytes(original_jar.read_bytes())
        compile_args = ['javac', '--release', '21', '-g', '-parameters', '-proc:none',
                        '-cp', '/build/libs/main/*:/build/libs/boot/*', '-d', '/build/classes',
                        '/build/services/src/main/java/org/keycloak/protocol/oidc/TokenManager.java']
        common = ['docker', 'run', '--rm', '--network', 'none', '--read-only',
                  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                  '--user', f'{os.getuid()}:{os.getgid()}', '--cpus', '2',
                  '--memory', '2g', '--pids-limit', '256', '--tmpfs', '/tmp:size=64m',
                  '-v', f'{root}:/build', JDK]
        run(*common, *compile_args)
        entries = sorted(str(p.relative_to(root / 'classes')) for p in (root / 'classes').rglob('*.class'))
        with zipfile.ZipFile(original_jar) as archive:
            expected = sorted(n for n in archive.namelist()
                              if n == PREFIX + '.class' or n.startswith(PREFIX + '$'))
        if entries != expected:
            raise SystemExit('Compiled class set differs from the original TokenManager class family')
        run(*common, 'jar', '--update', '--file', '/build/' + JAR, '-C', '/build/classes', '.')
        with zipfile.ZipFile(original_jar) as before, zipfile.ZipFile(rebuilt_jar) as after:
            if set(before.namelist()) != set(after.namelist()):
                raise SystemExit('Rebuild changed the JAR entry set')
            changed = sorted(n for n in before.namelist() if before.read(n) != after.read(n))
            if not changed or not set(changed).issubset(entries):
                raise SystemExit('Rebuild changed unrelated JAR contents')
        build = root / 'image'
        build.mkdir()
        (build / JAR).write_bytes(rebuilt_jar.read_bytes())
        (build / 'Dockerfile').write_text(
            f'FROM {BASE}\n'
            f'LABEL org.gtd.patch="offline-resource-renewal" org.gtd.upstream-fix="{UPSTREAM}" '
            f'org.gtd.patch-sha256="{PATCH_SHA}"\n'
            f'COPY --chown=1000:0 {JAR} /opt/keycloak/lib/lib/main/{JAR}\n')
        run('docker', 'build', '--network', 'none', '--tag', IMAGE,
            '--iidfile', str(root / 'image-id'), str(build))
        metadata = {'purpose': 'gtd-self-hosted-identity', 'image': IMAGE,
                    'image_id': (root / 'image-id').read_text().strip(), 'base': BASE,
                    'compiler': JDK, 'upstream_fix': UPSTREAM, 'source_url': SOURCE,
                    'source_sha256': SOURCE_SHA, 'patch_sha256': PATCH_SHA,
                    'patched_source_sha256': patched_sha, 'compile_arguments': compile_args,
                    'original_jar_sha256': digest(original_jar.read_bytes()),
                    'rebuilt_jar_sha256': digest(rebuilt_jar.read_bytes()),
                    'compiled_classes': entries, 'changed_entries': changed,
                    'unrelated_jar_entries_unchanged': True}
        (output / 'build.json').write_text(json.dumps(metadata, indent=2) + '\n')
        (output / 'Dockerfile').write_text((build / 'Dockerfile').read_text())
        print(json.dumps({'image': IMAGE, 'image_id': metadata['image_id'],
                          'changed_entries': changed, 'provenance': str(output / 'build.json')}))


if __name__ == '__main__':
    main()
