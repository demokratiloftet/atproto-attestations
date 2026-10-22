"""Receiver checks use disposable files and mocked Docker; no VPS is contacted."""
import gzip
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).resolve().parents[1] / 'deploy/pilot/deploy.py')
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
REVISION = 'a' * 40


def image_archive(tags=None, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        manifest = json.dumps([{'RepoTags': tags or ['affiliation-pilot:' + REVISION]}]).encode()
        entry = tarfile.TarInfo('manifest.json')
        entry.size = len(manifest)
        archive.addfile(entry, io.BytesIO(manifest))
        if extra:
            archive.addfile(tarfile.TarInfo(extra), io.BytesIO())
    return output.getvalue()


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / '.runtime').mkdir()
        for name, value in [('ROOT', self.root), ('COMPOSE', self.root / 'compose.json'),
                            ('OVERRIDE', self.root / '.runtime/release-compose.json')]:
            context = patch.object(receiver, name, value)
            context.start()
            self.addCleanup(context.stop)

    def test_rejects_invalid_revision_digest_and_archive_before_docker(self):
        with patch.object(receiver, 'run') as command, patch.object(receiver.subprocess, 'run') as load:
            with self.assertRaises(ValueError):
                receiver.deploy(';id', 'b' * 64, io.BytesIO())
            with self.assertRaises(ValueError):
                receiver.deploy(REVISION, 'wrong', io.BytesIO())
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                receiver.deploy(REVISION, 'b' * 64, io.BytesIO(b'wrong'))
            for content in [image_archive(['another-service:latest']), image_archive(extra='../escape')]:
                with self.assertRaises(ValueError):
                    receiver.load_archive(io.BytesIO(content), REVISION)
            command.assert_not_called()
            load.assert_not_called()

    def test_rejects_oversized_compressed_and_expanded_images(self):
        with patch.object(receiver, 'MAX_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'size limit'):
                receiver.deploy(REVISION, 'b' * 64, io.BytesIO(b'xx'))
        with patch.object(receiver, 'MAX_EXPANDED_BYTES', 1), patch.object(receiver.subprocess, 'run') as load:
            with self.assertRaisesRegex(ValueError, 'size limit'):
                receiver.load_archive(io.BytesIO(gzip.compress(b'xx')), REVISION)
            load.assert_not_called()

    def test_loads_only_validated_image_archive(self):
        with patch.object(receiver.subprocess, 'run') as load:
            receiver.load_archive(io.BytesIO(image_archive()), REVISION)
            self.assertEqual(load.call_args.args[0], ['docker', 'load'])
            self.assertTrue(load.call_args.kwargs['check'])

    def run_deployment(self, health):
        content = image_archive()
        candidate = [{'Id': 'sha256:new', 'Config': {'Labels': {'org.opencontainers.image.revision': REVISION}}}]
        with patch.object(receiver, 'load_archive'), patch.object(receiver, 'require_patched_node'), patch.object(receiver, 'run', side_effect=[json.dumps(candidate), 'sha256:previous']), \
                patch.object(receiver, 'compose') as compose, patch.object(receiver, 'health', side_effect=health):
            try:
                receiver.deploy(REVISION, hashlib.sha256(content).hexdigest(), io.BytesIO(content))
            finally:
                for call in compose.call_args_list:
                    self.assertEqual(call.args, ('up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '90', 'app'))
        return compose

    def test_unpatched_runtime_cannot_replace_current_image(self):
        content = image_archive()
        candidate = [{'Id': 'sha256:old-node', 'Config': {'Labels': {'org.opencontainers.image.revision': REVISION}}}]
        receiver.write_override('sha256:current')
        original = receiver.OVERRIDE.read_bytes()
        with patch.object(receiver, 'load_archive'), patch.object(receiver, 'run', return_value=json.dumps(candidate)), \
                patch.object(receiver, 'require_patched_node', side_effect=RuntimeError('unpatched Node')), \
                patch.object(receiver, 'compose') as compose:
            with self.assertRaisesRegex(RuntimeError, 'unpatched Node'):
                receiver.deploy(REVISION, hashlib.sha256(content).hexdigest(), io.BytesIO(content))
        compose.assert_not_called()
        self.assertEqual(receiver.OVERRIDE.read_bytes(), original)

    def test_success_keeps_previous_image_and_writes_release(self):
        compose = self.run_deployment([None])
        self.assertEqual(compose.call_count, 1)
        self.assertEqual(json.loads(receiver.OVERRIDE.read_text())['services']['app']['image'], 'sha256:new')
        release = json.loads((self.root / 'release.json').read_text())
        self.assertEqual(release['revision'], REVISION)
        self.assertEqual(release['previousImage'], 'sha256:previous')

    def test_unhealthy_release_rolls_back_only_app_and_preserves_configuration(self):
        receiver.write_override('sha256:previous')
        original = receiver.OVERRIDE.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'proof failure'):
            self.run_deployment([RuntimeError('proof failure'), None])
        self.assertEqual(receiver.OVERRIDE.read_bytes(), original)
        self.assertFalse((self.root / 'release.json').exists())


if __name__ == '__main__':
    unittest.main()
