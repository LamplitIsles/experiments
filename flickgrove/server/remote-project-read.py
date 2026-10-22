"""Bounded, read-only operations used by Grove; never an HTTP file proxy."""
import base64
import json
import os
import stat
import subprocess
import sys
import selectors
import signal
import time

MAX_BYTES = 20 * 1024 * 1024


def interrupted(signum, frame):
    raise SystemExit(1)


signal.signal(signal.SIGHUP, interrupted)
signal.signal(signal.SIGTERM, interrupted)


def tool(argv, env=None, timeout=8, budget=512 * 1024):
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=env, start_new_session=True)
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + timeout
    try:
        for stream in streams:
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(argv, timeout)
            for key, mask in selector.select(remaining):
                data = os.read(key.fileobj.fileno(), min(65536, budget + 1))
                budget -= len(data)
                if budget < 0:
                    raise ValueError('Project tool output exceeds its read budget')
                if data:
                    streams[key.fileobj].extend(data)
                else:
                    selector.unregister(key.fileobj)
        code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        return subprocess.CompletedProcess(argv, code, bytes(streams[process.stdout]), bytes(streams[process.stderr]))
    finally:
        selector.close()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()
        process.stderr.close()


def within(root, target):
    return target.startswith(root.rstrip('/') + '/')


def canonical(path):
    result = os.path.realpath(path)
    os.stat(result)
    return result


def read(root, target, extensions):
    if os.path.realpath(root) != root:
        raise ValueError('Preview directory changed')
    resolved = canonical(target)
    if not within(root, resolved):
        raise ValueError('File is outside the preview directory')
    if os.path.splitext(resolved)[1].lower() not in extensions:
        raise ValueError('File type is not supported')
    fd = os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Only regular files can be previewed')
        if info.st_size > MAX_BYTES:
            raise ValueError('File exceeds 20 MiB')
        data = bytearray()
        while len(data) <= info.st_size:
            chunk = os.read(fd, min(65536, info.st_size + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > info.st_size or len(data) > MAX_BYTES:
            raise ValueError('File changed while reading; retry')
        if os.path.realpath(root) != root or os.path.realpath(target) != resolved:
            raise ValueError('Preview directory changed')
        return {'canonical': resolved, 'bytes': base64.b64encode(data).decode('ascii')}
    finally:
        os.close(fd)


def run(request):
    operation = request['operation']
    if operation == 'projects':
        try:
            result = tool([request['og'], 'project', 'list', '--json'])
            result.check_returncode()
            return json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError):
            return {'error': 'Project catalogue is unavailable. Check og and its project registration on this device.'}
    if operation == 'branch':
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        env.update(LC_ALL='C', GIT_OPTIONAL_LOCKS='0', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
        def git(*args):
            return tool(['git', '-C', request['path'], *args], timeout=3, budget=65536, env=env)
        result = git('symbolic-ref', '--quiet', 'HEAD')
        if result.returncode == 0:
            return {'branch': result.stdout.decode().strip().removeprefix('refs/heads/')}
        if result.returncode == 1:
            result = git('rev-parse', '--short', 'HEAD')
            result.check_returncode()
            return {'branch': '@' + result.stdout.decode().strip()}
        if result.returncode == 128 and result.stderr.startswith(b'fatal: not a git repository'):
            return {'branch': None}
        raise ValueError('Could not read project branch')
    if operation == 'preview-grant':
        target = canonical(request['target'])
        roots = []
        for path in request['allowed']:
            try:
                roots.append(canonical(path))
            except OSError:
                pass
        # The registry is read on this same device. Failure retains the session
        # directory, matching the existing local preview authorization contract.
        if not any(within(root, target) for root in roots):
            catalogue = run(dict(request, operation='projects'))
            if isinstance(catalogue, dict) and isinstance(catalogue.get('projects'), list):
                for project in catalogue['projects']:
                    if isinstance(project, dict) and project.get('archived', False) is False:
                        path = project.get('path')
                        if isinstance(path, str) and path.startswith('/'):
                            try:
                                roots.append(canonical(path))
                            except OSError:
                                pass
        if not any(within(root, target) for root in roots):
            raise ValueError('File is outside the session and registered project directories')
        root = os.path.dirname(target)
        result = read(root, target, request['extensions'])
        return dict(result, root=root)
    if operation == 'preview-read':
        return read(request['root'], request['target'], request['extensions'])
    raise ValueError('Unsupported project read')


try:
    request = json.loads(base64.b64decode(sys.argv[1], validate=True))
    print(json.dumps(run(request)))
except ValueError as error:
    safe = {
        'Preview directory changed', 'File is outside the preview directory',
        'Only regular files can be previewed', 'File exceeds 20 MiB',
        'File changed while reading; retry', 'File type is not supported',
        'File is outside the session and registered project directories',
        'Could not read project branch', 'Unsupported project read',
    }
    print(json.dumps({'error': str(error) if str(error) in safe else 'Invalid project read'}))
except (OSError, subprocess.SubprocessError):
    print(json.dumps({'error': 'Project file or tool is unavailable; check the device and retry'}))
