#!/usr/bin/env python3
# Reference implementation of PROP-014 §3 (LIC-CHECK-ALGORITHM), edition 3 (nested REUSE.toml, annotation carriers, own annotations): own files under
# the policy licence, third-party files through the REUSE.toml registry and the allowlist,
# LICENSES/ texts, LICENSE shape, THIRD-PARTY-NOTICES.md staleness. Python 3.11+ (tomllib).
# Usage: license-selfcheck.py <package-dir> <license-policy.json> <spdx-license-ids.json> [--notices]
#   --notices  print the generated THIRD-PARTY-NOTICES.md body instead of checking.
# Not part of codkit: the TypeScript implementation must agree with this script on every fixture.
import os, re, sys, json, fnmatch, tomllib

COPY = re.compile(r'(SPDX-FileCopyrightText:\s*)?(Copyright\s*(\(c\)|©)?|©)\s*(?P<years>\d{4}(\s*[-,]\s*\d{4})*)?\s+(?P<holder>.+?)\s*$')
SPDX = re.compile(r'SPDX-License-Identifier:\s*(?P<expr>[A-Za-z0-9.+\-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+\-]+)*)')
MODS = re.compile(r'Modifications\s+Copyright')
WINDOW = 20; PROBE = 8192
NOTICE_HEADER = ('<!--\nCopyright (c) 2026 Oleg Chirukhin\n'
 'Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/\n'
 'Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/\n'
 'SPDX-License-Identifier: UPL-1.0\n-->\n# Third-party notices\n\nThis package includes the following third-party components. Each keeps its\n'
 'own copyright notice and license; the license texts are in `LICENSES/`.\n\n| Path | Copyright | License | Source |\n|---|---|---|---|\n')

def norm(s):
    for a,b in (('“','"'),('”','"'),('„','"'),('‘',"'"),('’',"'")): s=s.replace(a,b)
    return re.sub(r'\s+',' ',s).strip()
def clean_holder(h): return re.sub(r'(-->|\*/|-\*\))\s*$','',h).strip()
# LIC-COMMENT-STYLES: an extension (or bare name) that can carry a comment header. A file whose
# extension is not here may be carried by a REUSE.toml annotation (LIC-CARRIER-ANNOTATION).
COMMENT_EXT={'toml','yaml','yml','py','sh','bash','zsh','properties','ini','conf','rb','pl','r','ps1',
 'java','kt','kts','go','js','mjs','cjs','ts','tsx','jsx','c','h','cpp','hpp','cs','rs','swift','dart','scala','groovy','gradle','proto',
 'css','scss','less','md','html','htm','xml','xsl','xsd','svg','xhtml','vue','sql','lua','hs','clj','cljs','edn','lisp','el','tex','sty','bat','cmd'}
COMMENT_NAMES={'Dockerfile','Makefile','gitignore','gitattributes','editorconfig'}
def has_comment_style(rel):
    b=os.path.basename(rel)
    if b in COMMENT_NAMES or b.lstrip('.') in COMMENT_NAMES: return True
    dot=b.rfind('.')
    return dot>0 and b[dot+1:] in COMMENT_EXT
def copyright_line_of(text): return text if re.search(r'copyright|©', text, re.I) else f'Copyright (c) {text}'
def is_third_party(a): return (a['comment'] or '').startswith('third-party;')
def annotation_carrier(a): return [f"SPDX-FileCopyrightText: {copyright_line_of(a['copyright'] or '')}", f"SPDX-License-Identifier: {a['license'] or ''}"]
def unscanned(rel):
    b=os.path.basename(rel)
    return b=='LICENSE' or b.startswith('COPYING') or rel.startswith('LICENSES/') or b.endswith('.license') or b=='REUSE.toml'
def glob_match(pattern, rel):
    # REUSE path patterns: glob with ** ; fnmatch treats * as matching '/', which is what REUSE does too.
    return fnmatch.fnmatchcase(rel, pattern) or rel == pattern
def ids_of(expr):
    return [t for t in re.split(r'\s+(?:AND|OR|WITH)\s+', expr)]

def main():
    args=[a for a in sys.argv[1:] if not a.startswith('--')]; notices_mode='--notices' in sys.argv
    root, policy_path, spdx_path = args
    policy=json.load(open(policy_path)); spdx_ids=set(json.load(open(spdx_path))['ids'])
    holders=set(policy['holders']); own=policy['ownLicense']; allowed=set(policy['allowedThirdParty']); exceptions=set(policy.get('allowedExceptions',[]))
    problems=[]
    def prob(code, path, msg): problems.append((code, path, msg))
    files=[]
    for d,dirs,fs in os.walk(root):
        dirs[:]=sorted(x for x in dirs if x!='.git')
        for f in sorted(fs):
            p=os.path.join(d,f); rel=os.path.relpath(p,root).replace(os.sep,'/')
            if os.path.islink(p): prob('LICENSE-PACKAGE', rel, 'symlink inside the package'); continue
            files.append(rel)
    fileset=set(files)
    # REUSE.toml registries, every one in the tree (LIC-REGISTRY-NESTED): paths are relative to
    # the registry's own directory, and the deepest registry speaks first.
    annotations=[]
    for reg in [f for f in files if os.path.basename(f)=='REUSE.toml']:
        base=reg[:reg.rfind('/')+1] if '/' in reg else ''
        try:
            reuse=tomllib.load(open(os.path.join(root,reg),'rb'))
            if reuse.get('version')!=1: prob('LICENSE-PACKAGE',reg,'version must be 1')
            for a in reuse.get('annotations',[]):
                paths=a['path'] if isinstance(a['path'],list) else [a['path']]
                annotations.append({'paths':paths,'precedence':a.get('precedence','closest'),'copyright':a.get('SPDX-FileCopyrightText'),'license':a.get('SPDX-License-Identifier'),'comment':a.get('SPDX-FileComment',''),'registry':reg,'base':base})
        except Exception as e: prob('LICENSE-PACKAGE',reg,f'cannot parse: {e}')
    def annotations_for(rel):
        hits=[a for a in annotations if rel.startswith(a['base']) and any(glob_match(p, rel[len(a['base']):]) for p in a['paths'])]
        return sorted(hits, key=lambda a: -len(a['base'].split('/')))
    licences_in_use=set(); checked=[]
    for rel in files:
        if unscanned(rel): continue
        full=os.path.join(root,rel); data=open(full,'rb').read()
        sidecar=rel+'.license'; anns=annotations_for(rel)
        override=[a for a in anns if a['precedence']=='override']
        closest=[a for a in anns if a['precedence'] in ('closest','aggregate')]
        # carrier selection (REUSE order): sidecar -> override annotation -> header -> closest/aggregate annotation;
        # LIC-CARRIER-ANNOTATION: an annotation carries a file that cannot hold a comment, never a source file
        carrier_lines=None; source=None
        if sidecar in fileset:
            carrier_lines=open(os.path.join(root,sidecar),encoding='utf-8').read().split('\n'); source='sidecar'
        elif override:
            carrier_lines=annotation_carrier(override[0]); source='annotation'
        else:
            if b'\x00' in data[:PROBE]:
                if closest: carrier_lines=annotation_carrier(closest[0]); source='annotation'
                else: prob('LICENSE-HEADER', rel, 'binary file without a .license sidecar or a REUSE.toml annotation'); continue
            else:
                try: text=data.decode('utf-8')
                except UnicodeDecodeError:
                    if closest: carrier_lines=annotation_carrier(closest[0]); source='annotation'; text=None
                    else: prob('LICENSE-HEADER', rel, 'not valid UTF-8 and no .license sidecar or REUSE.toml annotation'); continue
                if carrier_lines is None:
                    win=[l for l in text.split('\n') if l.strip()][:WINDOW]
                    if any(SPDX.search(l) for l in win) or any(COPY.search(l) for l in win): carrier_lines=win; source='header'
                    elif has_comment_style(rel):
                        prob('LICENSE-HEADER', rel, 'source file without a header: a REUSE.toml annotation does not replace the header of a file that can carry one' if closest else 'no licence carrier: no header in the first 20 non-empty lines, no sidecar, no REUSE.toml annotation'); continue
                    elif closest: carrier_lines=annotation_carrier(closest[0]); source='annotation'
                    else: prob('LICENSE-HEADER', rel, 'no licence carrier: no header in the first 20 non-empty lines, no sidecar, no REUSE.toml annotation'); continue
        # LIC-HEADER-BLOCK-ENDS-AT-SPDX: the carrier block is everything up to and including the
        # SPDX line; copyright-looking text below it is content (a notices table, prose).
        # LIC-ANNOTATION-OWN: an annotation without the third-party comment is ours and must say so
        own_shaped=[a for a in anns if not is_third_party(a)]
        if own_shaped and (not any(h in (own_shaped[0]['copyright'] or '') for h in holders) or own_shaped[0]['license']!=own):
            checked.append((rel, source)); prob('LICENSE-HEADER', rel, 'own annotation names a foreign holder or licence'); continue
        spdx_index=next((i for i,l in enumerate(carrier_lines) if SPDX.search(l)), None)
        block=carrier_lines if spdx_index is None else carrier_lines[:spdx_index+1]
        copies=[m for m in (COPY.search(l) for l in block) if m]
        spdx=[m for m in (SPDX.search(l) for l in carrier_lines) if m]
        checked.append((rel, source))
        if not copies: prob('LICENSE-HEADER', rel, 'no copyright line'); continue
        if len(spdx)!=1: prob('LICENSE-HEADER', rel, f'{len(spdx)} SPDX-License-Identifier lines, expected exactly one'); continue
        expr=spdx[0].group('expr'); ids=ids_of(expr)
        bad=[i for i in ids if i not in spdx_ids and not (i.startswith('LicenseRef-'))]
        if bad: prob('LICENSE-HEADER', rel, f'not an SPDX identifier: {", ".join(bad)}' + (' (the only valid form is UPL-1.0)' if any(b.upper().startswith('UPL') for b in bad) else '')); continue
        own_holders=[m for m in copies if clean_holder(m.group('holder')) in holders and not MODS.search(m.string)]
        foreign=[m for m in copies if clean_holder(m.group('holder')) not in holders and not MODS.search(m.string)]
        if own_holders and not foreign:
            # LIC-ANNOTATION-OWN: an own annotation names a policy holder and the own licence
            if own_shaped and source!='annotation' and own_shaped[0]['license']!=expr: prob('LICENSE-HEADER', rel, f'carrier says "{expr}" but the REUSE.toml annotation says "{own_shaped[0]["license"]}"')
            if not all(m.group('years') for m in own_holders): prob('LICENSE-HEADER', rel, 'own copyright line without a year')
            if expr!=own: prob('LICENSE-HEADER', rel, f'SPDX-License-Identifier must be exactly {own} for an own file, got "{expr}"')
            else: licences_in_use.add(own)
            continue
        # third-party file: a third-party annotation first, any annotation otherwise
        registry=[a for a in anns if a['copyright'] and a['license'] and is_third_party(a)] or [a for a in anns if a['copyright'] and a['license']]
        if not registry: prob('LICENSE-THIRD-PARTY', rel, 'holder not in policy and no REUSE.toml annotation covers the file (typo in the holder, or an undeclared third-party file)'); continue
        a=registry[0]
        if a['license']!=expr: prob('LICENSE-THIRD-PARTY', rel, f'carrier says "{expr}" but the REUSE.toml annotation says "{a["license"]}"'); continue
        for i in ids:
            if i.startswith('LicenseRef-') or i=='NOASSERTION': prob('LICENSE-THIRD-PARTY', rel, f'{i} is not allowed'); break
            if 'WITH' in expr and i in exceptions: continue
            if i not in allowed and i not in exceptions: prob('LICENSE-THIRD-PARTY', rel, f'licence {i} is outside the allowlist'); break
        else:
            licences_in_use.update(i for i in ids if i not in exceptions)
    # orphan sidecars
    for rel in files:
        if rel.endswith('.license') and rel[:-len('.license')] not in fileset: prob('LICENSE-HEADER', rel, 'orphan sidecar: its file does not exist')
    # package consistency
    if 'vibe.toml' in fileset:
        vt=open(os.path.join(root,'vibe.toml'),encoding='utf-8').read()
        m=re.search(r'^license = "(.*)"$', vt, re.M)
        if not m or m.group(1)!=own: prob('LICENSE-PACKAGE','vibe.toml',f'license field must be "{own}"')
    else: prob('LICENSE-PACKAGE','vibe.toml','missing')
    canon={}
    for rel in files:
        if rel.startswith('LICENSES/'): canon[rel[len('LICENSES/'):-4] if rel.endswith('.txt') else rel]=open(os.path.join(root,rel),encoding='utf-8').read()
    for lic in sorted(licences_in_use):
        if lic not in canon: prob('LICENSE-PACKAGE', f'LICENSES/{lic}.txt', 'missing licence text')
    for lic in sorted(canon):
        if lic not in licences_in_use: prob('LICENSE-PACKAGE', f'LICENSES/{lic}.txt', 'licence text present but no file uses this licence')
    if 'LICENSE' in fileset and own in canon:
        lic=open(os.path.join(root,'LICENSE'),encoding='utf-8').read().split('\n')
        if '' not in lic: prob('LICENSE-PACKAGE','LICENSE','no blank line after the header')
        else:
            blank=lic.index(''); header=lic[:blank]; body='\n'.join(lic[blank+1:])
            if len(header)<2 or not COPY.search(header[0]) or clean_holder(COPY.search(header[0]).group('holder')) not in holders: prob('LICENSE-PACKAGE','LICENSE','line 1 must be a copyright line with a policy holder')
            if norm(body)!=norm('\n'.join(canon[own].split('\n')[2:])): prob('LICENSE-PACKAGE','LICENSE','body differs from LICENSES/'+own+'.txt')
    elif 'LICENSE' not in fileset: prob('LICENSE-PACKAGE','LICENSE','missing')
    # notices
    rows=[a for a in annotations if a['copyright'] and a['license'] and not any(h in a['copyright'] for h in holders)]
    expected=NOTICE_HEADER+''.join(f"| `{'`, `'.join(a['paths'])}` | {a['copyright']} | {a['license']} | {a['comment'].replace('third-party; ','')} |\n" for a in rows) if rows else None
    if notices_mode:
        sys.stdout.write(expected or ''); return 0
    if rows:
        actual=open(os.path.join(root,'THIRD-PARTY-NOTICES.md'),encoding='utf-8').read() if 'THIRD-PARTY-NOTICES.md' in fileset else None
        if actual is None: prob('LICENSE-THIRD-PARTY','THIRD-PARTY-NOTICES.md','missing: third-party files are registered but no notices file exists (run codkit license notices)')
        elif actual!=expected: prob('LICENSE-THIRD-PARTY','THIRD-PARTY-NOTICES.md','stale: differs from what codkit license notices would generate')
    elif 'THIRD-PARTY-NOTICES.md' in fileset: prob('LICENSE-PACKAGE','THIRD-PARTY-NOTICES.md','present but no third-party files are registered')
    for rel,src in checked: print(f'  checked  {rel}  ({src})')
    for code,path,msg in problems: print(f'error CK-E-{code}: {path}: {msg}')
    print(f'{len(checked)} files checked, {len(problems)} problems')
    return 1 if problems else 0
if __name__=='__main__': sys.exit(main())
