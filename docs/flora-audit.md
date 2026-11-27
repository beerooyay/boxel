# Tarn tree and flora audit

The valley has **1,229 trees**. All 12 trunk sites inside the starting hillside trial use LOLIPOP summer oaks. The original fine-leaved landmark is one medium oak, joined by four forked medium oaks and seven broad oaks. The other 1,217 trees use Tarn’s procedural broadleaves. The trial covers a 32 × 26 m ellipse centred at (18, 36). Trees beyond its edge remain visible from the meadow. The upright stone at (25.34, 44.04) was removed in the earlier hillside pass. [Visit the hillside](https://beerooyay.github.io/boxel/?oak)

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
| Spreading A | 215 | 2,593 | 980 | 43,645 |
| Upright A | 232 | 2,569 | 964 | 46,168 |
| Rounded A | 168 | 2,605 | 988 | 34,440 |
| Spreading B | 210 | 2,896 | 1,088 | 47,460 |
| Upright B | 232 | 2,872 | 1,072 | 51,504 |
| Rounded B | 160 | 2,581 | 972 | 32,160 |

The 1,217 procedural crowns break down into **889 green, 140 dark evergreen, 64 blossom pink and 124 honey/apricot**. Two additional crown palette ranges, solid petal pink and solid gold, receive zero procedural trees. Those colours also serve other vegetation. The imported oak has its own summer leaf material. [Pigment definitions](../demo/flora-palette.js)

**Why the oak reads differently.** The artist built irregular branch contours and textured clusters of small oak leaves with open sky between them. The nearby broadleaves repeat four denser leaf-spray patterns on branching shoots. Their trunks have modeled flutes, buttresses and forks, plus a shared 768 × 768 scanned bark colour and normal pair. The normals give the grooves a lighting response. The modeled wood supplies the silhouette. [Oak renderer](../demo/oak.js) · [Leaf atlas generator](../tools/bake-leaf-sprays.mjs) · [Bark scan](https://polyhaven.com/a/bark_brown_02)

## The oak download

The 146.1 MiB source GLB contains **17 distinct forms** across four large, four big, three medium, three small and three saplings. Each has three mesh detail levels, a bark and a leaf part per level, and one billboard. Those account for 119 mesh records. Five additional showcase copies of one large oak contribute ten records. A checker floor and a scale figure bring the file to 131 mesh records, 227 nodes, 25 materials and 72 embedded images. [LOLIPOP’s original pack](https://sketchfab.com/3d-models/oak-trees-pack-17var-lods-seasons-gameready-a5e4e64f9f1d4089bdcc6170a9333393) · [CC Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)

The game loads **16 oak files totalling 2.62 MiB**. Three forms share the summer colour/opacity and normal maps, 2,048² and 1,024² for leaves and 512 × 1,024 for bark. The original medium landmark keeps its LOD0 near mesh. The forked medium and broad forms use LOD1 nearby. All three switch to LOD2 beyond 42 m and cast cutout shadows with that mesh. The other 14 forms, alternate seasons and billboards remain source assets. [Runtime assets](../demo/oak)

Each oak’s root flare follows the triangulated slope across its lowest 0.95 m. The trunk base stays anchored while the upper crown bends with the wind. The grove contributes crown shelter, trunk occlusion and clearance for sailwing flight. The shelter and flight calculations use approximate crown volumes. [Canopy shelter](../demo/atmosphere.js) · [Ground lighting](../demo/valley-light.js) · [Sailwing routes](../demo/fauna.js)

## Rooted flora

Each root or stalk is counted once at its generated position. In a colony, individual stalks can have their own roots. The two device columns use the game’s fine-pointer and coarse-pointer density settings. The pieces column shows how many desktop instances the renderer uses to build those forms.

| Flora | Desktop roots or stalks | Coarse-pointer roots or stalks | Desktop pieces | Typical habitat |
| --- | ---: | ---: | ---: | --- |
| Blush rosette | 560 | 364 | 6,156 | Sheltered tree and stone bases |
| Cut-leaf fern | 480 | 312 | 5,743 | Grove shade and shore |
| Glow tube | 3,101 | 2,024 | 6,202 | Colonies at the waterline and around rocks |
| Coilfern | 3,038 | 2,066 | 6,076 | Fern walk, west groves and upland trails |
| Lantern bell | 1,653 | 1,087 | 3,306 | Shore, meadow and headwaters |
| Tidecup | 395 | 278 | 6,715 | Wet margins |
| Arrowleaf | 1,074 | 790 | 6,968 | Rock benches, eastern and southern walks |
| Spiral rosette | 500 | 500 | 10,500 | Path edges, banks and grove margins |
| **Total** | **10,801** | **7,421** | **51,666** | |

Blush and spiral rosettes have separate generators and silhouettes. The first seven families share a strip renderer with **41,166** desktop pieces or **27,941** on coarse pointers. Each tidecup has 12 lobes and five pollen filaments. Its filaments reuse the glow-tube shader, accounting for 1,975 desktop strips. The spiral rosettes have 21 strap leaves in three overlapping fans each. The engine’s desktop `leaves` readout of **265,877** combines their 10,500 straps with 255,377 procedural tree sprays. Individual leaflets and the imported oak’s foliage have no entry in that counter.

**Grass and surface cover.** The full map holds **5,571,606 grass root records** on desktop and **2,621,446** on coarse pointers. A root occupies eight bytes and can carry one to three blades up close. Tile visibility and distance determine how many blades the GPU draws each frame. Shade, moisture, exposure and elevation blend green meadow, sedge and straw heath. Light pink grass grows in the eastern meadow, western fen and a band along the upper river. Reeds share the grass renderer. Ground moss, fungal filaments, rock lichen and fallen litter live in surface materials. Eight drifting spore pods, airborne motes and spore rain are effects. [Meadow generation](../demo/meadow.js) · [Habitats and surface materials](../demo/game.js)

The separate 10 × 10 m grass lab has **15,016 desktop roots** or **8,566 coarse-pointer roots**. The clearing changes local placement, giving the lab backdrop 1,207 trees and 473 spiral rosettes. It skips the seven-family understory draw, shader compilation and instance upload. The CPU still uses those plant positions for the baked lighting.

## Duplicates and wasted work

- **Trunk placement.** All 1,229 positions are distinct. Nine pairs have centres less than 0.5 m apart, five of them inside the map. At 1 m the count rises to 24 pairs, 13 inside. The closest pair is 10.4 cm apart at (−92.63, −25.24) and (−92.73, −25.22). The upland scatter tests habitat and slope and permits adjacent trunks. These stands are still present. The census prints coordinates for all 24 pairs.
- **Plant placement.** The audit found zero coincident rooted understory placements, including checks between the two rosettes and all seven strip families, and zero understory roots exactly on a trunk centre. Crossed strips, cup filaments and clumped grass siblings intentionally share a base.
- **Shipped art.** All 21 dedicated tree and leaf asset files have distinct file hashes. The small compressed leaf atlas and its raw fallback decode to the same six mip levels, also present in the larger atlas. Each browser selects one file. The game’s atlas supplies four canopy sprays and four ground-leaf shapes. [Atlas selection](../demo/leaf-spray.js)
- **Source-only art.** Of 55 PNGs in the artist’s main texture folder, 54 have unique SHA-256 hashes. The winter cluster’s `Subsurface` and `SubsurfaceAmount` PNGs are byte-identical. The billboard folder has 323 PNGs and 323 distinct hashes. Both folders stay outside the runtime download.
- **Startup work removed.** The ground-light bake now stamps the tallest part at each root once. Desktop plant stamps fell from 15,814 to 3,781, and coarse-pointer stamps from 10,613 to 2,507. Skipping hidden understory uploads in the lab saves 41,511 desktop or 28,133 coarse-pointer strip instances at startup.

## Reproduce the census

Serve the repository and run the command below with Playwright and Chromium installed. The probe reads the generated placements during construction, then checks them against the renderer. It emits one JSON record for each game/lab and pointer combination, including every close trunk pair. The probe runs only in the auditing browser. [Census script](../bench/flora.cjs)

```sh
node bench/flora.cjs http://127.0.0.1:8000/demo/
```
