#!/usr/bin/env python3
# Executable acceptance oracle for FEAT-002 S29 (edition 2) and S52 (edition 3): copies the shipped package into a
# temp dir, applies one defect per case, runs the reference check and compares the verdict with
# the expected error code. Usage: license-fixtures.py <package-dir> <policy.json> <spdx-ids.json>
import os, sys, shutil, subprocess, tempfile, re
HERE=os.path.dirname(os.path.abspath(__file__))
pkg, policy, spdx = sys.argv[1:4]
SPEC='vibevm/vibespecs/flows/standards/minimal-intervention.xml'
def run(root):
    r=subprocess.run([sys.executable, os.path.join(HERE,'license-reference.py'), root, policy, spdx], capture_output=True, text=True)
    codes=re.findall(r'^error CK-E-([A-Z-]+): ([^:]+):', r.stdout, re.M)
    return r.returncode, codes
def OWN_ANN(path):
    return f'\n[[annotations]]\npath = "{path}"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2026 Oleg Chirukhin"\nSPDX-License-Identifier = "UPL-1.0"\n'
def WRONG_LICENCE_ANN(path):
    return f'\n[[annotations]]\npath = "{path}"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2026 Oleg Chirukhin"\nSPDX-License-Identifier = "MIT"\n'
def FOREIGN_ANN(path, own=False):
    comment='' if own else 'SPDX-FileComment = "third-party; https://example.invalid tag v1"\n'
    return f'\n[[annotations]]\npath = "{path}"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2020 Somebody Else"\nSPDX-License-Identifier = "MIT"\n' + comment
def edit(root, rel, fn):
    p=os.path.join(root, rel); s=open(p,encoding='utf-8').read(); open(p,'w',encoding='utf-8').write(fn(s))
cases = {
 'clean package': (None, 0, []),
 'a spec without header': (lambda r: edit(r, SPEC, lambda s: re.sub(r'<!--.*?-->\n','',s,count=1,flags=re.S)), 1, [('LICENSE-HEADER', SPEC)]),
 'b header below line 20': (lambda r: edit(r, SPEC, lambda s: s.replace('<!--', '<!-- ' + ('\nfiller line'*20) + '\n', 1)), 1, [('LICENSE-HEADER', SPEC)]),
 'c GPL identifier on an own file': (lambda r: edit(r, SPEC, lambda s: s.replace('SPDX-License-Identifier: UPL-1.0','SPDX-License-Identifier: GPL-3.0-only',1)), 1, [('LICENSE-HEADER', SPEC)]),
 'd UPL without version': (lambda r: edit(r, SPEC, lambda s: s.replace('SPDX-License-Identifier: UPL-1.0','SPDX-License-Identifier: UPL',1)), 1, [('LICENSE-HEADER', SPEC)]),
 'e PNG without sidecar': (lambda r: os.remove(os.path.join(r,'assets/codkit.png.license')), 1, [('LICENSE-HEADER','assets/codkit.png')]),
 'f JSON without sidecar': (lambda r: open(os.path.join(r,'data.json'),'w').write('{"a":1}\n'), 1, [('LICENSE-HEADER','data.json')]),
 'g holder typo, undeclared': (lambda r: edit(r, SPEC, lambda s: s.replace('Oleg Chirukhin','Oleg Chiruhin',1)), 1, [('LICENSE-THIRD-PARTY', SPEC)]),
 'h orphan sidecar': (lambda r: open(os.path.join(r,'ghost.txt.license'),'w').write('Copyright (c) 2026 Oleg Chirukhin\nSPDX-License-Identifier: UPL-1.0\n'), 1, [('LICENSE-HEADER','ghost.txt.license')]),
 'i LICENSE with a changed word': (lambda r: edit(r,'LICENSE', lambda s: s.replace('without restriction','with restriction',1)), 1, [('LICENSE-PACKAGE','LICENSE')]),
 'j manifest licence MIT': (lambda r: edit(r,'vibe.toml', lambda s: s.replace('license = "UPL-1.0"','license = "MIT"',1)), 1, [('LICENSE-PACKAGE','vibe.toml')]),
 'k extra licence text': (lambda r: shutil.copy(os.path.join(r,'LICENSES/MIT.txt'), os.path.join(r,'LICENSES/BSD-2-Clause.txt')), 1, [('LICENSE-PACKAGE','LICENSES/BSD-2-Clause.txt')]),
 'l symlink inside': (lambda r: os.symlink('README.md', os.path.join(r,'link.md')), 1, [('LICENSE-PACKAGE','link.md')]),
 'm own copyright without a year': (lambda r: edit(r, SPEC, lambda s: s.replace('Copyright (c) 2026 Oleg Chirukhin','Copyright (c) Oleg Chirukhin',1)), 1, [('LICENSE-HEADER', SPEC)]),
 'n third-party without annotation': (lambda r: edit(r,'REUSE.toml', lambda s: s.split('[[annotations]]')[0]), 1, [('LICENSE-THIRD-PARTY','assets/third-party/feather/package.svg'), ('LICENSE-PACKAGE','THIRD-PARTY-NOTICES.md'), ('LICENSE-PACKAGE','LICENSES/MIT.txt')]),
 'o third-party licence outside allowlist': (lambda r: (edit(r,'REUSE.toml', lambda s: s.replace('"MIT"','"GPL-3.0-only"')), edit(r,'assets/third-party/feather/package.svg.license', lambda s: s.replace('MIT','GPL-3.0-only'))), 1, [('LICENSE-THIRD-PARTY','assets/third-party/feather/package.svg')]),
 'p carrier and annotation disagree': (lambda r: edit(r,'assets/third-party/feather/package.svg.license', lambda s: s.replace('SPDX-License-Identifier: MIT','SPDX-License-Identifier: ISC')), 1, [('LICENSE-THIRD-PARTY','assets/third-party/feather/package.svg')]),
 'q stale notices': (lambda r: edit(r,'THIRD-PARTY-NOTICES.md', lambda s: s.replace('v4.29.1','v4.29.0')), 1, [('LICENSE-THIRD-PARTY','THIRD-PARTY-NOTICES.md')]),
 'r missing MIT text': (lambda r: os.remove(os.path.join(r,'LICENSES/MIT.txt')), 1, [('LICENSE-PACKAGE','LICENSES/MIT.txt')]),
 's copyright-looking table row after the SPDX line is content': (lambda r: edit(r,'README.md', lambda s: s + '\n| Path | Copyright | License |\n'), 0, []),
 # edition 3 (LIC-CARRIER-ANNOTATION, LIC-REGISTRY-NESTED, LIC-ANNOTATION-OWN)
 't image carried by an own annotation alone': (lambda r: (open(os.path.join(r,'assets/x.png'),'wb').write(b'\x89PNG\x00\x01'), edit(r,'REUSE.toml', lambda s: s + OWN_ANN('assets/x.png'))), 0, []),
 'u source file under an annotation still needs a header': (lambda r: (os.makedirs(os.path.join(r,'src'),exist_ok=True), open(os.path.join(r,'src/a.ts'),'w').write('export const a = 1;\n'), edit(r,'REUSE.toml', lambda s: s + OWN_ANN('src/**'))), 1, [('LICENSE-HEADER','src/a.ts')]),
 'v nested registry covers its directory': (lambda r: (os.makedirs(os.path.join(r,'sub'),exist_ok=True), open(os.path.join(r,'sub/data.csv'),'w').write('a,b\n1,2\n'), open(os.path.join(r,'sub/REUSE.toml'),'w').write('version = 1\n' + OWN_ANN('data.csv'))), 0, []),
 'w the deepest registry wins': (lambda r: (os.makedirs(os.path.join(r,'sub'),exist_ok=True), open(os.path.join(r,'sub/data.csv'),'w').write('a,b\n'), edit(r,'REUSE.toml', lambda s: s + WRONG_LICENCE_ANN('sub/**')), open(os.path.join(r,'sub/REUSE.toml'),'w').write('version = 1\n' + OWN_ANN('data.csv'))), 0, []),
 'x own annotation naming a foreign holder': (lambda r: (open(os.path.join(r,'assets/x.png'),'wb').write(b'\x89PNG\x00\x01'), edit(r,'REUSE.toml', lambda s: s + FOREIGN_ANN('assets/x.png', own=True))), 1, [('LICENSE-HEADER','assets/x.png')]),
}
ok=True
for name,(mut,exit_expected,codes_expected) in cases.items():
    root=tempfile.mkdtemp(prefix='lic-'); shutil.rmtree(root); shutil.copytree(pkg, root)
    if mut: mut(root)
    code, codes = run(root)
    got=sorted(set(codes)); want=sorted(set(codes_expected))
    # the expected findings are the primary ones; consequential findings (an unused licence
    # text, notices gone stale) may accompany them and are reported, not counted as failure
    verdict = 'OK ' if (code==exit_expected and set(want) <= set(got)) else 'FAIL'
    if verdict=='FAIL': ok=False
    print(f'{verdict} {name:55s} exit {code} (want {exit_expected}) codes {got}')
    shutil.rmtree(root, ignore_errors=True)
sys.exit(0 if ok else 1)
