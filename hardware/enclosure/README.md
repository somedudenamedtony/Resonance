# Bridge enclosure

Parametric OpenSCAD case for the ESP32-S3 DevKitC-1 style board + a single-18650 battery shield.
STLs for all three variants are in `stl/` (base, lid, stack tray; the shield/cell/esp files are
preview mock-ups, don't print them).

| Variant | Outside (mm) | Ports | Good for |
|---|---|---|---|
| stack | 104 × 35 × 43 | all on one end | smallest footprint, bench |
| slim  | 104 × 64 × 31 | all on one end | velcro to the back of the NanoVNA |
| stick | 177 × 35 × 31 | charge one end, NanoVNA the other | strap to a mast or tripod leg |

Before printing, measure the values marked ★ in `resonance_case.scad` (board sizes, port and
button positions) and re-export:

    openscad -D 'variant="slim"' -D 'part="base"' -o slim-base.stl resonance_case.scad

Print PLA or PETG, 0.2 mm layers, 3 walls, no supports. Base upright, lid upside down.
Snap-fit lid (`fit` = 0.3 mm clearance); the ON/OFF button is a flexure in the lid, and the
status LED shows through a light pipe (print the lid in a translucent filament for a glow).
