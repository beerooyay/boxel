# Tarn tree and flora audit

The November 27, 2026 valley has **1,229 trees**. The fine-leaved tree in the pink hillside meadow is the single summer oak from LOLIPOP’s pack. The other 1,228 trees share Tarn’s procedural broadleaf family. A warm crown beside the oak is one of those broadleaves. Its neighbouring upright stone was removed at world coordinates (25.34, 44.04). Before-and-after inventories match every trunk position and the four other standing stones. [Visit the hillside](https://beerooyay.github.io/boxel/?oak)

## Trees in the world

Counts use trunk centres. The mapped valley runs from −128 to +128 metres on both axes. The skyline forest extends out to ±200 metres. The renderer culls trees in 16-metre tiles, then batches visible tiles that share a shape and detail level. The number drawn changes with the camera. [Forest placement and meshes](../demo/high-canopy.js) · [Valley construction and rendering](../demo/game.js)

| Placement source | Inside map | Beyond map | Total |
| --- | ---: | ---: | ---: |
| Local groves and walks, including the hillside oak | 372 | 0 | 372 |
| Upland and skyline stands | 411 | 445 | 856 |
| Islet tree | 1 | 0 | 1 |
| **Total** | **784** | **445** | **1,229** |

The procedural forest grows three branching shapes from two seeds each. Every tree reuses one shape with its own rotation, crown spread, height and pigment. The dark evergreen crowns use the upright broadleaf shape. The blossom crowns use the spreading shape. Each mesh has a near and a distant version.

| Shape | Trees | Near triangles per tree | Distant triangles per tree | Leaf sprays across all instances |
| --- | ---: | ---: | ---: | ---: |
| Spreading A | 215 | 2,215 | 980 | 43,645 |
| Upright A | 235 | 2,203 | 972 | 47,235 |
| Rounded A | 169 | 2,191 | 964 | 33,631 |
| Spreading B | 211 | 2,464 | 1,088 | 47,686 |
| Upright B | 237 | 2,476 | 1,096 | 54,036 |
| Rounded B | 161 | 2,191 | 964 | 32,039 |

The 1,228 procedural crowns break down into **893 green, 146 dark evergreen, 64 blossom pink and 125 honey/apricot**. Two additional crown palette ranges, solid petal pink and solid gold, receive zero procedural trees. Those colours also serve other vegetation. The imported oak has its own summer leaf material. [Pigment definitions](../demo/flora-palette.js)

**Why the oak reads differently.** The artist built irregular branch contours and textured clusters of small oak leaves with open sky between them. The nearby broadleaves repeat four denser leaf-spray patterns on branching shoots. Their trunks have modeled flutes, buttresses and forks, plus a shared 768 × 768 scanned bark colour and normal pair. The normals give the grooves a lighting response. The modeled wood supplies the silhouette. [Oak renderer](../demo/oak.js) · [Leaf atlas generator](../tools/bake-leaf-sprays.mjs) · [Bark scan](https://polyhaven.com/a/bark_brown_02)

## The oak download

The 146.1 MiB source GLB contains **17 distinct forms** across four large, four big, three medium, three small and three saplings. Each has three mesh detail levels, a bark and a leaf part per level, and one billboard. Those account for 119 mesh records. Five additional showcase copies of one large oak contribute ten records. A checker floor and a scale figure bring the file to 131 mesh records, 227 nodes, 25 materials and 72 embedded images. [LOLIPOP’s original pack](https://sketchfab.com/3d-models/oak-trees-pack-17var-lods-seasons-gameready-a5e4e64f9f1d4089bdcc6170a9333393) · [CC Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)

The game loads **six oak files totalling 1.88 MiB**. `Medium_oak_tree__001_LOD0` contains 1,744 bark triangles and 3,378 leaf triangles. The summer leaf colour/opacity map is 2,048², the leaf normal map is 1,024², and both bark maps are 512 × 1,024. Its root flare conforms to the triangulated hillside across its lowest 0.95 m. The trial replaces one procedural site and draws the authored bark and leaves into the main view, reflections and directional shadows. [Runtime assets](../demo/oak)

**Limits of the trial.** The other 16 forms, alternate seasons, coarser meshes, billboards and extra material channels are available as source assets only. The oak crown is static in wind and uses its full mesh at every visible distance. Its occupied site is available for ground plant placement. The separate canopy shelter bake, trunk ambient-occlusion bake and sailwing obstacle list currently take their trees from the procedural stands alone. These gaps matter if the pack expands into whole groves. [Canopy shelter](../demo/atmosphere.js) · [Ground lighting](../demo/valley-light.js) · [Sailwing routes](../demo/fauna.js)

## Rooted flora

Each root or stalk is counted once at its generated position. In a colony, individual stalks can have their own roots. The two device columns use the game’s fine-pointer and coarse-pointer density settings. The pieces column shows how many desktop instances the renderer uses to build those forms.

| Flora | Desktop roots or stalks | Coarse-pointer roots or stalks | Desktop pieces | Typical habitat |
| --- | ---: | ---: | ---: | --- |
| Crimson rosette | 560 | 364 | 6,156 | Sheltered tree and stone bases |
| Cut-leaf fern | 480 | 312 | 5,743 | Grove shade and shore |
| Glow tube | 3,101 | 2,024 | 6,202 | Colonies at the waterline and around rocks |
| Coilfern | 3,038 | 2,066 | 6,076 | Fern walk, west groves and upland trails |
| Lantern bell | 1,653 | 1,087 | 3,306 | Shore, meadow and headwaters |
| Tidecup | 395 | 278 | 6,715 | Wet margins |
| Arrowleaf | 1,074 | 790 | 6,968 | Rock benches, eastern and southern walks |
| Spiral rosette | 500 | 500 | 10,500 | Path edges, banks and grove margins |
| **Total** | **10,801** | **7,421** | **51,666** | |

Crimson and spiral rosettes have separate generators and silhouettes. The first seven families share a strip renderer with **41,166** desktop pieces or **27,941** on coarse pointers. Each tidecup has 12 lobes and five pollen filaments. Its filaments reuse the glow-tube shader, accounting for 1,975 desktop strips. The spiral rosettes have 21 strap leaves each. The engine’s desktop `leaves` readout of **268,772** combines their 10,500 straps with 258,272 procedural tree sprays. Individual leaflets and the imported oak’s foliage have no entry in that counter.

**Grass and surface cover.** The full map holds **5,571,606 grass root records** on desktop and **2,621,446** on coarse pointers. A root occupies eight bytes and can carry one to three blades up close. Tile visibility and distance determine how many blades the GPU draws each frame. Shade, moisture, exposure and elevation blend green meadow, sedge and straw heath. Light pink grass grows in the eastern meadow, western fen and a band along the upper river. Reeds share the grass renderer. Ground moss, fungal filaments, rock lichen and fallen litter live in surface materials. Eight drifting spore pods, airborne motes and spore rain are effects. [Meadow generation](../demo/meadow.js) · [Habitats and surface materials](../demo/game.js)

The separate 10 × 10 m grass lab has **15,016 desktop roots** or **8,566 coarse-pointer roots**. The clearing changes local placement, giving the lab backdrop 1,207 trees and 473 spiral rosettes. It skips the seven-family understory draw, shader compilation and instance upload. The CPU still uses those plant positions for the baked lighting.

## Duplicates and wasted work

- **Trunk placement.** All 1,229 positions are distinct. Nine pairs have centres less than 0.5 m apart, five of them inside the map. At 1 m the count rises to 24 pairs, 13 inside. The closest pair is 10.4 cm apart at (−92.63, −25.24) and (−92.73, −25.22). The upland scatter tests habitat and slope and permits adjacent trunks. These stands are still present. The census prints coordinates for all 24 pairs.
- **Plant placement.** The audit found zero coincident rooted understory placements, including checks between the two rosettes and all seven strip families, and zero understory roots exactly on a trunk centre. Crossed strips, cup filaments and clumped grass siblings intentionally share a base.
- **Shipped art.** All 11 dedicated tree and leaf asset files have distinct file hashes. The small compressed leaf atlas and its raw fallback decode to the same six mip levels, also present in the larger atlas. Each browser selects one file. The game’s atlas supplies four canopy sprays and four ground-leaf shapes. [Atlas selection](../demo/leaf-spray.js)
- **Source-only art.** Of 55 PNGs in the artist’s main texture folder, 54 have unique SHA-256 hashes. The winter cluster’s `Subsurface` and `SubsurfaceAmount` PNGs are byte-identical. The billboard folder has 323 PNGs and 323 distinct hashes. Both folders stay outside the runtime download.
- **Startup work removed.** The ground-light bake now stamps the tallest part at each root once. Desktop plant stamps fell from 16,022 to 3,804, and coarse-pointer stamps from 10,746 to 2,519. The 512² RGB lighting texture matched byte for byte before and after on both device profiles in both game and lab. Skipping hidden understory uploads in the lab saves 41,511 desktop or 28,133 coarse-pointer strip instances at startup.

## Reproduce the census

Serve the repository and run the command below with Playwright and Chromium installed. The probe reads the generated placements during construction, then checks them against the renderer. It emits one JSON record for each game/lab and pointer combination, including every close trunk pair. The probe runs only in the auditing browser. [Census script](../bench/flora.cjs)

```sh
node bench/flora.cjs http://127.0.0.1:8000/demo/
```
