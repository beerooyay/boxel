"""Extract the three ambient animations from the pinned Quaternius GLBs in a source directory."""
import json
from pathlib import Path
import struct
import sys

ANIMALS = 'Alpaca Bull Cow Deer Donkey Horse Horse_White Husky ShibaInu Stag Wolf'.split()
CLIPS = {'Idle', 'Walk', 'Eating'}


def repack(path):
    data = path.read_bytes()
    json_size = struct.unpack_from('<I', data, 12)[0]
    model = json.loads(data[20:20 + json_size])
    binary = memoryview(data)[28 + json_size:]
    model['animations'] = [a for a in model['animations'] if a['name'].split('|')[-1] in CLIPS]
    assert len(model['animations']) == len(CLIPS) and len(model['buffers']) == 1

    # Keep the authored skin and every mesh node, including the stag's rigid antlers.
    refs = []
    for mesh in model['meshes']:
        for primitive in mesh['primitives']:
            refs.extend((primitive['attributes'], key) for key in primitive['attributes'])
            refs.append((primitive, 'indices'))
    refs.extend((skin, 'inverseBindMatrices') for skin in model['skins'])
    for clip in model['animations']:
        refs.extend((sample, key) for sample in clip['samplers'] for key in ('input', 'output'))

    used = sorted({obj[key] for obj, key in refs})
    ids = {old: new for new, old in enumerate(used)}
    for obj, key in refs:
        obj[key] = ids[obj[key]]
    model['accessors'] = [model['accessors'][i] for i in used]
    used_views = sorted({a['bufferView'] for a in model['accessors']})
    view_ids = {old: new for new, old in enumerate(used_views)}
    for accessor in model['accessors']:
        accessor['bufferView'] = view_ids[accessor['bufferView']]
    model['bufferViews'] = [model['bufferViews'][i] for i in used_views]
    packed = bytearray()
    for view in model['bufferViews']:
        packed.extend(bytes(-len(packed) % 4))
        start = view.get('byteOffset', 0)
        view['byteOffset'] = len(packed)
        packed.extend(binary[start:start + view['byteLength']])
    model['buffers'][0]['byteLength'] = len(packed)
    packed.extend(bytes(-len(packed) % 4))
    chunk = json.dumps(model, separators=(',', ':')).encode()
    chunk += b' ' * (-len(chunk) % 4)
    header = struct.pack('<4sIII4s', b'glTF', 2, 28 + len(chunk) + len(packed), len(chunk), b'JSON')
    return header + chunk + struct.pack('<I4s', len(packed), b'BIN\0') + packed


if __name__ == '__main__':
    source = Path(sys.argv[1])
    target = Path(__file__).resolve().parents[1] / 'demo' / 'animals'
    target.mkdir(exist_ok=True)
    for animal in ANIMALS:
        filename = animal + '.glb'
        (target / filename).write_bytes(repack(source / filename))
