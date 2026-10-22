#!/usr/bin/env python3
"""Install or remove the NoticeOS Bash initialization block in owned profiles."""
import argparse
import os
from pathlib import Path
import re
import shlex

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--remove', action='store_true')
args = parser.parse_args()
source = Path(__file__).resolve().parents[1] / 'activate.sh'
block = ('# BEGIN NOTICEOS REPOSITORY SHELL\n'
         f'if [ -r {shlex.quote(str(source))} ]; then\n'
         f'  . {shlex.quote(str(source))}\n'
         'fi\n'
         '# END NOTICEOS REPOSITORY SHELL\n')
pattern = re.compile(r'^# BEGIN NOTICEOS REPOSITORY SHELL\n.*?^# END NOTICEOS REPOSITORY SHELL\n', re.M | re.S)
home = Path.home()
names = ['.profile', '.bashrc']
names += [name for name in ['.bash_profile', '.bash_login'] if (home / name).exists()]
for name in names:
    path = home / name
    if path.is_symlink() or (path.exists() and path.stat().st_uid != os.getuid()):
        raise SystemExit('Expected an owned shell profile without a symlink: ' + str(path))
    text = path.read_text() if path.exists() else ''
    clean = pattern.sub('', text)
    if args.remove:
        result = clean
    elif name == '.bashrc':
        # Bash commonly returns early from noninteractive .bashrc files.
        result = block + clean
    else:
        result = clean + ('\n' if clean and not clean.endswith('\n') else '') + block
    if result != text:
        path.write_text(result)
