# Tarn tree and flora audit

The valley has **1,233 native trees**, including 10 on the starting hillside where the imported summer oaks were tested. The 32 × 26 m trial ellipse is centred at (18, 36). The hillside uses Tarn’s broadleaf meshes and materials again. The former upright stone at (25.34, 44.04) is gone. [Visit the hillside](https://beerooyay.github.io/boxel/?oak)

## Trees in the world

Counts use trunk centres. The mapped valley runs from −128 to +128 metres on both axes. The skyline forest extends out to ±200 metres. The renderer culls trees in 16-metre tiles, then batches visible tiles that share a shape and detail level. The number drawn changes with the camera. [Forest placement and meshes](../demo/high-canopy.js) · [Valley construction and rendering](../demo/game.js)

| Placement source | Inside map | Beyond map | Total |
| --- | ---: | ---: | ---: |
| Local groves and walks | 376 | 0 | 376 |
| Upland and skyline stands | 411 | 445 | 856 |
| Islet tree | 1 | 0 | 1 |
| **Total** | **788** | **445** | **1,233** |

The procedural forest grows three branching shapes from two seeds each. Every tree reuses one shape with its own rotation, crown spread, height and pigment. The dark evergreen crowns use the upright broadleaf shape. The blossom crowns use the spreading shape. Each mesh has a near and a distant version.

| Shape | Trees | Near triangles per tree | Distant triangles per tree | Leaf sprays across all instances |
| --- | ---: | ---: | ---: | ---: |
| Spreading A | 224 | 2,593 | 1,036 | 45,472 |
| Upright A | 227 | 2,569 | 1,020 | 45,173 |
| Rounded A | 165 | 2,605 | 1,044 | 33,825 |
| Spreading B | 213 | 2,896 | 1,152 | 48,138 |
| Upright B | 253 | 2,872 | 1,136 | 56,166 |
| Rounded B | 151 | 2,581 | 1,028 | 30,351 |

The crowns break down into **891 green, 153 dark evergreen, 61 blossom pink and 128 honey/apricot**. The solid petal-pink and solid-gold ranges currently occur on other vegetation. The broadleaves use four leaf-spray patterns on branching shoots. A 768 × 768 scanned bark colour and normal pair brings out grooves in the light, while modeled flutes, buttresses and forks shape each silhouette. [Pigment definitions](../demo/flora-palette.js) · [Leaf atlas generator](../tools/bake-leaf-sprays.mjs) · [Bark scan](https://polyhaven.com/a/bark_brown_02)

On all six native meshes, the first ring of each main bough sits inside the trunk. The shoulder takes its surface normal and bark coordinates from the trunk triangle it meets. The distant mesh keeps the collar, and a tile of matching colour and normal grooves covers the wood if the bark photographs fail to load. [Branch construction](../demo/high-canopy.js) · [Surface textures](../demo/surface-texture.js)

## Archived oak trial

The 146.1 MiB source GLB contains **17 distinct forms** across four large, four big, three medium, three small and three saplings. Each has three mesh detail levels, a bark and a leaf part per level, and one billboard. Those account for 119 mesh records. Five additional showcase copies of one large oak contribute ten records. A checker floor and a scale figure bring the file to 131 mesh records, 227 nodes, 25 materials and 72 embedded images. [LOLIPOP’s original pack](https://sketchfab.com/3d-models/oak-trees-pack-17var-lods-seasons-gameready-a5e4e64f9f1d4089bdcc6170a9333393) · [CC Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)

The trial’s **16 extracted files total 2.62 MiB**. They remain available for a future trial. Its three forms shared summer leaf colour/opacity and normal maps at 2,048² and 1,024², with bark at 512 × 1,024. The original medium landmark used LOD0 close up, while the forked medium and broad forms used LOD1. All three had a distant LOD2. The current game requests zero oak files and draws zero imported trees in its main, reflection and shadow passes. [Archived renderer](../demo/oak.js) · [Archived assets](../demo/oak)

## Rooted flora

Each root or stalk is counted once at its generated position. In a colony, individual stalks can have their own roots. The two device columns use the game’s fine-pointer and coarse-pointer density settings. The pieces column shows how many desktop instances the renderer uses to build those forms.

| Flora | Desktop roots or stalks | Coarse-pointer roots or stalks | Desktop pieces | Typical habitat |
| --- | ---: | ---: | ---: | --- |
| Blush rosette | 560 | 364 | 6,178 | Sheltered tree and stone bases |
| Cut-leaf fern | 480 | 312 | 5,748 | Grove shade and shore |
| Glow tube | 3,108 | 2,060 | 6,216 | Colonies at the waterline and around rocks |
| Coilfern | 3,077 | 2,084 | 6,154 | Fern walk, west groves and upland trails |
| Lantern bell | 1,613 | 1,047 | 3,226 | Shore, meadow and headwaters |
| Tidecup | 413 | 286 | 7,021 | Wet margins |
| Arrowleaf | 1,042 | 790 | 6,746 | Rock benches, eastern and southern walks |
| Spiral rosette | 514 | 514 | 10,794 | Path edges, banks and grove margins |
| **Total** | **10,807** | **7,457** | **52,083** | |

Blush and spiral rosettes have separate generators and silhouettes. The first seven families share a strip renderer with **41,289** desktop pieces or **28,154** on coarse pointers. Each tidecup has 12 lobes and five pollen filaments. Its filaments reuse the glow-tube shader, accounting for 2,065 desktop strips. Each spiral rosette has 21 strap leaves in three overlapping fans. The desktop `leaves` counter combines those 10,794 straps with 259,125 tree sprays for a total of **269,919**. A spray can contain many individual leaflets.

**Grass and surface cover.** The full map holds **5,553,733 grass root records** on desktop and **2,613,048** on coarse pointers. A root occupies eight bytes and can carry one to three blades up close. Tile visibility and distance determine how many blades the GPU draws each frame. Shade, moisture, exposure and elevation blend green meadow, sedge and straw heath. Light pink grass grows in the eastern meadow, western fen and a band along the upper river. Along the waterline, reeds grow in pockets with open gravel between them. They share the grass renderer. Ground moss, fungal filaments, rock lichen and fallen litter live in surface materials. Eight drifting spore pods, airborne motes and spore rain are effects. [Meadow generation](../demo/meadow.js) · [Habitats and surface materials](../demo/game.js)

The separate 10 × 10 m grass lab has **15,016 desktop roots** or **8,566 coarse-pointer roots**. The clearing changes local placement, giving the lab backdrop 1,210 trees and 465 spiral rosettes. It skips the seven-family understory draw, shader compilation and instance upload. The CPU still uses those plant positions for the baked lighting.

## Duplicates and wasted work

- **Trunk placement.** All 1,233 positions are distinct. 9 pairs have centres less than 0.5 m apart, including 5 inside the map. At 1 m the count rises to 25 pairs, 14 inside. The closest pair is 9.1 cm apart at (34.33, 65.56) and (34.42, 65.58). The upland scatter tests habitat and slope and permits adjacent trunks. The census prints coordinates for all 25 pairs.
- **Plant placement.** The audit found zero coincident rooted understory placements, including checks between the two rosettes and all seven strip families, and zero understory roots exactly on a trunk centre. Crossed strips, cup filaments and clumped grass siblings intentionally share a base.
- **Art inventory.** All 21 tree and leaf asset files in the repository, including the archived oak trial, have distinct file hashes. The small compressed leaf atlas and its raw fallback decode to the same six mip levels, also present in the larger atlas. Each browser selects one file. The game’s atlas supplies four canopy sprays and four ground-leaf shapes. [Atlas selection](../demo/leaf-spray.js)
- **Source-only art.** Of 55 PNGs in the artist’s main texture folder, 54 have unique SHA-256 hashes. The winter cluster’s `Subsurface` and `SubsurfaceAmount` PNGs are byte-identical. The billboard folder has 323 PNGs and 323 distinct hashes. Both folders stay outside the runtime download.
- **Ground-light bake.** Counting the tallest part at each root gives 3,656 desktop stamps across 15,491 eligible strips, or 2,507 across 10,697 on coarse pointers. The grass lab skips uploading 41,760 desktop or 28,135 coarse-pointer understory strips.

## Reproduce the census

Serve the repository and run the command below with Playwright and Chromium installed. The probe reads the generated placements during construction, then checks them against the renderer. It emits one JSON record for each game/lab and pointer combination, including every close trunk pair. The probe runs only in the auditing browser. [Census script](../bench/flora.cjs)

```sh
node bench/flora.cjs http://127.0.0.1:8000/demo/
```
