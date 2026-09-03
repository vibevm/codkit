import re, sys, glob
import xml.etree.ElementTree as ET

STRUCTURAL = {'p','tr','td','table','fence','facts','spec','title','status'}

def fix(path):
    s = open(path, encoding='utf-8').read()
    # 1) collect names that appear as closing tags -> real elements
    closers = set(re.findall(r'</([A-Za-z][A-Za-z0-9._-]*)\s*>', s))
    out = []
    i = 0
    for m in re.finditer(r'<([^<>]*)>', s):
        out.append(s[i:m.start()])
        inner = m.group(1)
        keep = False
        if inner.startswith('/'):
            keep = True                       # closing tag
        elif inner.endswith('/') :
            name = inner[:-1].strip()
            keep = ('=' in inner) or (name in STRUCTURAL)  # self-closing structural or with attrs
        elif '=' in inner:
            keep = True                       # opening tag with attributes
        else:
            name = inner.strip()
            keep = name in STRUCTURAL or name in closers
        if keep:
            out.append(m.group(0))
        else:
            out.append('&lt;' + inner.replace('&','&amp;') + '&gt;')
        i = m.end()
    out.append(s[i:])
    s2 = ''.join(out)
    # 2) escape bare ampersands (not part of an entity)
    s2 = re.sub(r'&(?!lt;|gt;|amp;|quot;|apos;|#)', '&amp;', s2)
    if s2 != s:
        open(path,'w',encoding='utf-8').write(s2)
        return True
    return False

changed=[]
for f in sorted(glob.glob('vibevm/vibespecs/**/*.xml', recursive=True)):
    if '/boot/' in f: continue
    if fix(f): changed.append(f)
bad=0
for f in sorted(glob.glob('vibevm/vibespecs/**/*.xml', recursive=True)):
    if '/boot/' in f: continue
    try: ET.parse(f)
    except Exception as e: bad+=1; print("STILL BAD", f, e)
print("changed:", len(changed), "; parse errors left:", bad)
