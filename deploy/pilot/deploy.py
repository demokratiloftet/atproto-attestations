#!/usr/bin/env python3
"""Root-owned image receiver. It can replace only the affiliation app, never its config or volumes."""
import fcntl
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path('/root/affiliation-pilot')
COMPOSE = ROOT / 'compose.json'
OVERRIDE = ROOT / '.runtime/release-compose.json'
MAX_BYTES = 512 * 1024 * 1024
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def compose(*args):
    command = ['docker', 'compose', '-f', str(COMPOSE)]
    if OVERRIDE.exists():
        command += ['-f', str(OVERRIDE)]
    return run(*command, *args)


def write_override(image):
    temporary = OVERRIDE.with_suffix('.tmp')
    temporary.write_text(json.dumps({'services': {'app': {'image': image}}}) + '\n')
    temporary.chmod(0o600)
    temporary.replace(OVERRIDE)


def health():
    run('curl', '--fail', '--silent', '--show-error', '--retry', '5', '--retry-delay', '2',
        '--retry-all-errors', '--max-time', '10',
        'https://tilknytning.hackaton.demokratiloftet.no/health')
    state = json.loads(run('curl', '--fail', '--silent', '--show-error', '--max-time', '30',
        'https://tilknytning.hackaton.demokratiloftet.no/api/state'))
    assert state.get('demo') is True and state.get('organisations'), 'Invalid demo state'
    current = [c for c in state.get('publicCredentials', [])
               if c.get('verification', {}).get('reason') != 'expired']
    assert all(c.get('verification', {}).get('valid') for c in current), 'Public proof failed after deployment'


def load_archive(archive, revision):
    """Accept exactly one tagged image; never unpack an archive onto the host."""
    with tempfile.TemporaryFile() as expanded:
        with gzip.GzipFile(fileobj=archive) as compressed:
            length = 0
            while chunk := compressed.read(1024 * 1024):
                length += len(chunk)
                if length > MAX_EXPANDED_BYTES:
                    raise ValueError('Expanded image exceeds size limit')
                expanded.write(chunk)
        expanded.seek(0)
        with tarfile.open(fileobj=expanded, mode='r:') as image:
            paths = set()
            for entry in image:
                parts = Path(entry.name).parts
                if (entry.name.startswith('/') or '..' in parts or
                        not (entry.isfile() or entry.isdir()) or entry.name in paths):
                    raise ValueError('Invalid image archive entry')
                paths.add(entry.name)
                if len(paths) > 20000:
                    raise ValueError('Too many image archive entries')
            manifest_entry = image.getmember('manifest.json')
            if manifest_entry.size > 1024 * 1024:
                raise ValueError('Image manifest exceeds size limit')
            manifest = json.load(image.extractfile(manifest_entry))
            if (not isinstance(manifest, list) or len(manifest) != 1 or
                    manifest[0].get('RepoTags') != ['affiliation-pilot:' + revision]):
                raise ValueError('Archive must contain only the requested affiliation image')
        expanded.seek(0)
        subprocess.run(['docker', 'load'], stdin=expanded, stdout=subprocess.DEVNULL,
                       stderr=subprocess.PIPE, check=True, timeout=120)


def require_patched_node(image):
    # Inspect the candidate before changing image.json or touching running services.
    run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', image,
        '-e', "const v=process.versions.node.split('.').map(Number);"
        "const min={22:[23,4],24:[22,1],26:[12,1]}[v[0]];"
        "if(!min || v[1]<min[0] || (v[1]===min[0] && v[2]<min[1]))"
        "{console.error('Node runtime lacks the October 2026 security baseline');process.exit(1)}")



def deploy(revision, digest, source):
    if not re.fullmatch(r'[0-9a-f]{40}', revision) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('Expected Git revision and archive SHA-256')
    os.umask(0o077)
    with (ROOT / '.runtime/deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryFile() as archive:
            calculated = hashlib.sha256()
            length = 0
            while chunk := source.read(1024 * 1024):
                length += len(chunk)
                if length > MAX_BYTES:
                    raise ValueError('Image archive exceeds size limit')
                calculated.update(chunk)
                archive.write(chunk)
            if calculated.hexdigest() != digest:
                raise ValueError('Image archive digest mismatch')
            archive.seek(0)
            load_archive(archive, revision)
            tag = 'affiliation-pilot:' + revision
            candidate = json.loads(run('docker', 'image', 'inspect', tag))[0]
            assert candidate['Config']['Labels'].get('org.opencontainers.image.revision') == revision, 'Image revision mismatch'
            require_patched_node(candidate['Id'])
            previous = run('docker', 'inspect', '--format', '{{.Image}}', 'affiliation-pilot-app-1')
            old_override = OVERRIDE.read_bytes() if OVERRIDE.exists() else None
            write_override(candidate['Id'])
            try:
                compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '90', 'app')
                health()
            except Exception:
                write_override(previous)
                compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '90', 'app')
                health()
                if old_override is not None:
                    OVERRIDE.write_bytes(old_override)
                print('Deployment failed. Previous image restored; data retained.', file=sys.stderr)
                raise
            metadata = {'revision': revision, 'image': candidate['Id'], 'archiveSha256': digest,
                        'previousImage': previous, 'status': 'healthy'}
            (ROOT / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
            print(f'Deployed {revision}; HTTPS and public proofs healthy. Previous image retained for rollback.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: deploy.py REVISION SHA256 < IMAGE.tar.gz')
    deploy(sys.argv[1], sys.argv[2], sys.stdin.buffer)
