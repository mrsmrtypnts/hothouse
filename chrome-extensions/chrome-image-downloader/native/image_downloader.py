#!/usr/bin/env python3
"""Native messaging host for the Image Downloader Chrome extension."""

import json
import os
import struct
import subprocess
import sys
import urllib.error
import urllib.request


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    length = struct.unpack('=I', raw)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(msg):
    data = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def pick_folder():
    result = subprocess.run(
        ['osascript', '-e', 'POSIX path of (choose folder)'],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return None


def prompt_save_as(default_name, default_dir):
    # Activate the frontmost app first so the dialog gets keyboard focus
    # (native messaging hosts are background processes and don't own the UI).
    script = (
        'tell application (path to frontmost application as text) to activate\n'
        f'POSIX path of (choose file name '
        f'with prompt "File already exists — choose a new name or location:" '
        f'default name "{default_name}" '
        f'default location "{default_dir}")'
    )
    result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
    if result.returncode == 0:
        return result.stdout.strip()
    return None  # user cancelled (Esc or Cancel)


def download_url(url, to_dir, allow_dupe=False):
    filename = url.split('?')[0].rstrip('/').split('/')[-1]
    if not filename or '.' not in filename:
        filename = 'image.png'

    # Validate target dir before doing any network work
    if not os.path.isdir(to_dir) or not os.access(to_dir, os.W_OK):
        raise Exception(f'__INVALID_TARGET__Target folder is not accessible: {to_dir} — please re-select it in the extension popup')

    dest = os.path.join(to_dir, filename)

    if os.path.exists(dest):
        if not allow_dupe:
            return None  # signal dupe to caller without opening any dialog
        dest = prompt_save_as(filename, to_dir)
        if dest is None:
            raise Exception('Cancelled')
        os.makedirs(os.path.dirname(dest), exist_ok=True)

    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            try:
                with open(dest, 'wb') as f:
                    f.write(resp.read())
            except PermissionError:
                raise Exception(
                    f'Permission denied writing to {os.path.dirname(dest)} — '
                    f'grant Full Disk Access to Chrome in '
                    f'System Settings > Privacy & Security > Full Disk Access'
                )
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise Exception(
                f'Server refused the download (HTTP {e.code}) — '
                f'the image URL may require a login session'
            )
        raise Exception(f'HTTP {e.code}: {e.reason}')
    except urllib.error.URLError as e:
        raise Exception(f'Network error: {e.reason}')
    return dest


def main():
    while True:
        msg = read_message()
        action = msg.get('action')

        if action == 'pick_folder':
            path = pick_folder()
            if path:
                send_message({'path': path})
            else:
                send_message({'error': 'No folder selected'})

        elif action == 'download_url':
            try:
                dest = download_url(msg['url'], msg['to_dir'], msg.get('allow_dupe', False))
                if dest is None:
                    send_message({'success': False, 'dupe': True})
                else:
                    send_message({'success': True, 'dest_path': dest})
            except Exception as e:
                send_message({'success': False, 'error': str(e)})

        else:
            send_message({'error': f'Unknown action: {action}'})


if __name__ == '__main__':
    main()
