"""Extract the ambient and playable animations from the pinned Quaternius GLBs in a source directory."""
import json
from pathlib import Path
import struct
import sys

WILDLIFE = 'Alpaca Bull Cow Deer Donkey Horse Horse_White Husky ShibaInu Stag Wolf'.split()
PLAYER_CLIPS = {'Idle', 'Walk', 'Gallop', 'Gallop_Jump'}


def repack(path):
    data = path.read_bytes()
    json_size = struct.unpack_from('<I', data, 12)[0]
    model = json.loads(data[20:20 + json_size])
    binary = memoryview(data)[28 + json_size:]
    clips = PLAYER_CLIPS if path.stem.lower() == 'fox' else PLAYER_CLIPS | {'Eating'}
    model['animations'] = [a for a in model['animations'] if a['name'].split('|')[-1] in clips]
    assert {a['name'].split('|')[-1] for a in model['animations']} == clips
    assert len(model['animations']) == len(clips) and len(model['buffers']) == 1

    # Keep the authored skin and every mesh node, including the stag's rigid antlers.
    refs = []
    joint_indices = set()
    for mesh in model['meshes']:
        for primitive in mesh['primitives']:
            attributes = primitive['attributes']
            # Tarn uses the material's flat colour for every vertex, including the deer.
            attributes.pop('COLOR_0', None)
            if 'JOINTS_0' in attributes:
                joint_indices.add(attributes['JOINTS_0'])
            refs.extend((attributes, key) for key in attributes)
            refs.append((primitive, 'indices'))
    refs.extend((skin, 'inverseBindMatrices') for skin in model['skins'])
    for clip in model['animations']:
        refs.extend((sample, key) for sample in clip['samplers'] for key in ('input', 'output'))

    # Each attribute in the pinned conversion has a dedicated tightly packed
    # view. Every joint fits in the unsigned byte consumed by the renderer.
    compact = {}
    for index in joint_indices:
        accessor = model['accessors'][index]
        if accessor['componentType'] == 5121:
            continue
        assert accessor['type'] == 'VEC4' and accessor['componentType'] == 5123
        view_id = accessor['bufferView']
        assert sum(a['bufferView'] == view_id for a in model['accessors']) == 1
        view = model['bufferViews'][view_id]
        assert not accessor.get('byteOffset') and not view.get('byteStride')
        assert view['byteLength'] == 8 * accessor['count']
        start = view.get('byteOffset', 0)
        raw = binary[start:start + view['byteLength']]
        compact[view_id] = bytes(joint for (joint,) in struct.iter_unpack('<H', raw))
        accessor['componentType'] = 5121

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
    for old_id, view in zip(used_views, model['bufferViews']):
        packed.extend(bytes(-len(packed) % 4))
        start = view.get('byteOffset', 0)
        content = compact.get(old_id, binary[start:start + view['byteLength']])
        view['byteOffset'] = len(packed)
        view['byteLength'] = len(content)
        packed.extend(content)
    model['buffers'][0]['byteLength'] = len(packed)
    packed.extend(bytes(-len(packed) % 4))
    chunk = json.dumps(model, separators=(',', ':')).encode()
    chunk += b' ' * (-len(chunk) % 4)
    header = struct.pack('<4sIII4s', b'glTF', 2, 28 + len(chunk) + len(packed), len(chunk), b'JSON')
    return header + chunk + struct.pack('<I4s', len(packed), b'BIN\0') + packed


if __name__ == '__main__':
    source = Path(sys.argv[1])
    target = Path(__file__).resolve().parents[1] / 'demo' / 'animals'
    inputs = {source / (name + '.glb'): target / (name + '.glb') for name in WILDLIFE}
    # Existing wildlife-only source directories can still refresh the eleven ambient rigs.
    if (source / 'Fox.glb').is_file():
        inputs[source / 'Fox.glb'] = target.parent / 'fox.glb'
    packed = {output: repack(path) for path, output in inputs.items()}
    target.mkdir(exist_ok=True)
    for output, data in packed.items():
        output.write_bytes(data)
