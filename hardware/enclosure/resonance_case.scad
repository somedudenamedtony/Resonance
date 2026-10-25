// Resonance bridge enclosure: ESP32-S3 DevKitC-1 style board + single-18650 battery shield.
// Units: mm. Print base and lid with no supports (base upright, lid upside down).
//
// Three variants:
//   "stack"  ESP32 on a tray above the battery. Smallest footprint, all ports on one end.
//   "slim"   Side by side, flat. Rides on the back of the NanoVNA with velcro.
//   "stick"  End to end. Charge port on one end, NanoVNA cable on the other.
//
// Render one part:  openscad -D 'variant="slim"' -D 'part="base"' -o base.stl resonance_case.scad
// part: "assembly" | "base" | "lid" | "tray" (stack only) | "shield" | "cell" | "esp"

variant = "stack";
part = "assembly";

// ---------------------------------------------------------------- measure your boards
// These are best estimates. Check the few marked ★ with calipers before printing.

fit = 0.3;            // clearance around each board
headers = false;      // true if the ESP32 has pin headers soldered on (pointing down)

// Battery shield (FORIOT-style 1×18650). Local x runs from the short end nearest the USB-C
// charge port; local y = sh_w is the long edge the USB-C opens out of.
sh_l = 100;           // measured
sh_w = 29.4;          // measured
sh_pcb = 1.6;
sh_under = 6.0;       // measured: metal can under the PCB
sh_over = 20.45 - 1.6; // measured: PCB bottom to top of cell = 20.45
sh_hole_dx = 94.75;   // measured: hole spacing along the board
sh_hole_dy = 24.5;    // measured: hole spacing across
sh_hole_x0 = (sh_l - sh_hole_dx) / 2;
sh_hole_y0 = (sh_w - sh_hole_dy) / 2;
sh_holes = [for (x = [sh_hole_x0, sh_hole_x0 + sh_hole_dx], y = [sh_hole_y0, sh_hole_y0 + sh_hole_dy]) [x, y]];
sh_hole_d = 3.0;      // ★ assumed M3 holes
// 5 battery-level LEDs on the underside: 35 mm from the USB-A end, then every 3.5 mm toward it
sh_leds_x = [for (d = [35 : -3.5 : 20.9]) sh_l - d];
sh_chg_x = 23.5;      // measured: USB-C center from the near short end (bottom side, long edge)
sh_btn_x = 88;        // measured: side-push ON/OFF button on the USB-C long edge
sh_btn_out = 1.75;    // measured: how far it sticks out past the PCB edge
sh_btn_z = sh_pcb + 1.5; // ★ button center above the PCB bottom
// (the slide switch on the other long edge picks auto-shutdown vs always-on: set it before closing)

// ESP32-S3 DevKitC-1 style board (two USB-C ports on one short end)
es_l = 63.5;          // measured, incl. antenna overhang
es_pcb_l = 57.5;      // PCB alone (antenna sticks out 6 mm, 18.15 wide)
es_ant_w = 18.15;
es_w = 28.34;         // measured
es_pcb = 1.6;
es_over = 3.6;        // tallest part on top (module / USB-C)
es_under = headers ? 9.0 : variant == "stack" ? 0 : 1.5;  // stack: the board lies flat in a pocket on the tray
es_overhang = 0.8;    // USB-C receptacles stick out past the PCB edge
es_ports_y = [8.2, 20.2]; // measured: 8 and 20 mm from the edge
es_port_z = 3.2;      // port center above PCB bottom
// 3 LEDs 19.75 mm from the port end, 6–11 mm from the edge (measured)
// y is measured from the GND/TX edge (the right edge with ports toward you, top side up)
es_leds = [for (d = [6, 8.5, 11]) [19.75, d]];
es_rgb = [20.3, es_w - 8.9];  // the big RGB LED, near the 3V3 edge (from photo)
es_light_groups = [es_leds, [es_rgb]];

// Case
wall = 2.0;
floor_t = 2.0;
lid_t = 2.0;
lip_h = 4.0;
lip_t = 1.4;
snap_r = 0.6;
corner_r = 3.0;
plug_w = 13;          // USB-C plug overmold clearance
plug_h = 8;
label = "RESONANCE";
label_x_frac = 0.5;    // overridden for stick so the label clears the ON/OFF tab
callsign = "W7LIT";

$fn = 48;

// ---------------------------------------------------------------- layout per variant

z_shield = sh_under + 0.5;                       // shield PCB bottom above the floor
cell_top = z_shield + sh_pcb + sh_over;
tray_t = 1.6;
tray_z = cell_top + 1.0;                         // stack: tray bottom
z_esp = variant == "stack" ? tray_z + tray_t + es_under : z_shield;
esp_top = z_esp + es_pcb + es_over;

// SW1 slide switch on the long edge opposite the button sticks out past the PCB
sw_out = 2.2;         // ★ clearance for its lever
sw_x = 90;            // ★ lever center from the USB-C end (from photo; the window is 16 mm wide)
sw_side = variant == "slim" ? 0 : sw_out;  // slim: the lever points into the gap between boards
IW = (variant == "slim" ? es_w + 2 * fit + 3 + sh_w + fit : sh_w + 2 * fit) + sh_btn_out + sw_side;
IL = variant == "stick" ? sh_l + 2 * fit + 4 + es_l + es_overhang : sh_l + 2 * fit;
esp_port_top = z_esp + es_port_z + plug_h / 2;
IH = max(max(cell_top, esp_top) + 1.0, esp_port_top + 2.0);  // keep USB openings as closed windows

tray_l = IL - 2 * fit;                           // stack: full length so it can't slide
OL = IL + 2 * wall;
OW = IW + 2 * wall;
OH = floor_t + IH;                                 // base height; the lid sits on top

// Board placements (origin = PCB bottom-left corner of each board, in cavity coordinates)
// slim puts the ESP32 at the front so the shield's charge-port edge faces the back wall
module at_shield() { translate([fit, (variant == "slim" ? es_w + 2 * fit + 3 : fit) + sw_side, z_shield]) children(); }

module at_esp() {
    if (variant == "stack")
        translate([es_overhang, (IW - es_w) / 2, z_esp]) children();
    else if (variant == "slim")
        translate([es_overhang, fit, z_esp]) children();
    else // stick: ports face the far end
        translate([IL - es_overhang, es_w + (IW - es_w) / 2, z_esp]) rotate([0, 0, 180]) children();
}

// ---------------------------------------------------------------- mock parts (preview only)

module shield_mock() {
    color("#1d1f22") cube([sh_l, sh_w, sh_pcb]);
    color("#2b2d30") translate([4, (sh_w - 21) / 2, sh_pcb]) cube([80, 21, 4]);
    color("#c9ced4") translate([sh_l - 14, sh_w / 2 - 7, sh_pcb]) cube([14, 14, 7]);      // USB-A
    color("#c9ced4") translate([sh_chg_x - 4.5, sh_w - 7.4, -3.2]) cube([9, 7.4, 3.2]);    // USB-C (bottom)
    color("#9aa0a6") translate([60, 6, -sh_under]) cube([7, 7, sh_under]);                 // metal can
    color("#e8e8e8") translate([sw_x - 3, -2, sh_pcb]) cube([6, 4, 3]);                    // SW1 slide switch
    color("#e8e8e8") translate([sh_btn_x - 2, sh_w - 2, sh_pcb]) cube([4, 2 + sh_btn_out, 3]);
}

module cell_mock() {
    color("#2f9e6a") translate([9, sh_w / 2, sh_pcb + sh_over - 9.25]) rotate([0, 90, 0]) cylinder(d = 18.5, h = 65);
}

module esp_mock() {
    color("#202326") cube([es_pcb_l, es_w, es_pcb]);
    color("#b8bec6") translate([es_l - 25.5, (es_w - es_ant_w) / 2, es_pcb]) cube([25.5, es_ant_w, 3.2]);  // module
    for (y = es_ports_y) color("#c9ced4") translate([-es_overhang, y - 4.5, es_pcb]) cube([7.4, 9, 3.2]);
    for (l = es_leds) color("#ff4fa3") translate([l[0] - 0.8, l[1] - 0.6, es_pcb]) cube([1.6, 1.2, 0.6]);
    color("#f2f2f2") translate([es_rgb[0] - 2.5, es_rgb[1] - 2.5, es_pcb]) cube([5, 5, 1.6]);
}

// ---------------------------------------------------------------- shapes

module rrect(l, w, h, r = corner_r) {
    hull() for (x = [r, l - r], y = [r, w - r]) translate([x, y, 0]) cylinder(r = r, h = h);
}

// Port openings, in cavity coordinates, extended through the walls.
module port_cuts(grow = 0) {
    // Battery shield USB-C charge port: bottom side, opens out of the long edge
    at_shield() translate([sh_chg_x, sh_w - 2, -1.6])
        rotate([-90, 0, 0]) linear_extrude(wall + fit + sh_btn_out + 4)
            offset(r = 2 + grow) square([plug_w - 4, plug_h - 4], center = true);
    // ESP32 USB-C ports (OTG to the NanoVNA, UART for flashing): one window for both
    at_esp() hull() for (y = es_ports_y)
        translate([-es_overhang - wall - 2, y, es_port_z])
            rotate([0, 90, 0]) linear_extrude(wall + 4)
                offset(r = 2 + grow) square([plug_h - 4, plug_w - 4], center = true);
}

// Groove (base) / bump (lid) positions for the snap fit
snap_xs = [IL * 0.25, IL * 0.75];
label_x = variant == "stick" ? OL * 0.3 : variant == "stack" ? OL / 2 + 9 : OL / 2;  // clear the LED windows
snap_z = OH - lip_h / 2;

module base() {
    difference() {
        rrect(OL, OW, OH);
        translate([wall, wall, floor_t]) rrect(IL, IW, IH + 1, corner_r - 1);
        translate([wall, wall, floor_t]) port_cuts();
        // snap grooves in the long walls
        for (x = snap_xs, y = [wall, wall + IW])
            translate([wall + x - 5, y, snap_z]) rotate([0, 90, 0]) cylinder(r = snap_r + 0.15, h = 10);
        // battery gauge: slits in the charge-side wall beside the underside LEDs
        translate([wall, wall, floor_t]) at_shield() for (x = sh_leds_x)
            translate([x - 0.8, sh_w - 1, -sh_under + 1]) cube([1.6, wall + fit + sh_btn_out + 3, 4]);
        // SW1 window: room for the lever and a way to flip it with a pen
        if (sw_side > 0) translate([wall + fit + sw_x - 8, -1, floor_t + z_shield + sh_pcb - 0.5]) cube([16, wall + 1 + 0.01, 5]);
        // ON/OFF: a flex tab in the side wall, hinged toward the USB-A end
        translate([0, wall + IW - 1, floor_t + z_shield + sh_btn_z]) wall_button_slot();
        // thumb notch to pry the lid
        translate([OL / 2, -1, OH]) rotate([-90, 0, 0]) cylinder(r = 5, h = 3);
    }
    wall_button_nub();
    translate([wall, wall, floor_t]) {
        // shield standoffs with locating pins
        at_shield() for (h = sh_holes) translate([h[0], h[1], -z_shield - 0.4]) {
            cylinder(d = 6, h = z_shield + 0.4);
            cylinder(d = sh_hole_d - 0.4, h = z_shield + 0.4 + sh_pcb + 1.2);
        }
        // ESP32 rails (slim/stick: from the floor; stack: on the tray)
        if (variant != "stack") esp_rails(z_esp);
        // stack: ledges that hold the tray, chamfered so they print without support
        if (variant == "stack")
            for (x = [8, tray_l - 14], y = [0, IW]) translate([x, y, 0]) ledge(y == 0 ? 1 : -1);
    }
}

btn_gx = wall + fit + sh_btn_x;  // button x in base coordinates
tab_relief = 0.8;
module wall_button_slot() {
    // Tab stands up from a hinge below the button, so it prints with no overhang:
    // vertical side slots, and the slot over the free end is a bridge.
    s = 0.8; hw = 3.5; up = 3; down = 9;  // slot width, half tab width, tab above / below the button
    difference() {
        translate([btn_gx - hw - s, 0, -down]) cube([2 * (hw + s), wall + 2, down + up + s]);
        translate([btn_gx - hw, -1, -down - 1]) cube([2 * hw, wall + 4, down + up + 1]);
    }
    // thin the tab to 1.2 mm from the outside so it presses easily (~4x softer than the full wall)
    translate([btn_gx - hw, 1 + wall - tab_relief, -down + 1.5]) cube([2 * hw, tab_relief + 2, down + up - 1.5]);
}

module wall_button_nub() {
    // touches the button tip; a raised dot outside so you can find it by feel
    translate([btn_gx, wall + IW + 0.01, floor_t + z_shield + sh_btn_z]) rotate([90, 0, 0]) cylinder(d = 3, h = 0.31);
    translate([btn_gx, wall + IW + wall - tab_relief - 0.01, floor_t + z_shield + sh_btn_z]) rotate([-90, 0, 0]) cylinder(d1 = 3.5, d2 = 2.6, h = 0.5);
}

// Stack tray: low walls beside the ESP32 so it drops into a pocket and can't slide.
pocket_gap = 0.2;     // clearance each side (28.34 board -> 28.74 gap)
pocket_wall = 1.2;
pocket_h = es_pcb + 0.8;  // walls stand 0.8 mm above the PCB top
module esp_pocket() {
    // Walls run from the tray's long edges in to the board, leaving board + 2 x pocket_gap between them.
    y0 = (IW - es_w) / 2;                    // ESP32 is centered across the tray
    z0 = tray_z + tray_t - 0.4;
    for (span = [[fit, y0 - pocket_gap], [y0 + es_w + pocket_gap, IW - fit]])
        translate([es_overhang + 1, span[0], z0]) cube([es_pcb_l + 1, span[1] - span[0], pocket_h + 0.4]);
    // end stop past the antenna overhang
    at_esp() translate([es_l + pocket_gap, (es_w - es_ant_w) / 2, -0.4]) cube([1.6, es_ant_w, es_pcb + 1.5 + 0.4]);
}

module esp_rails(height) {
    // sunk 0.4 mm into whatever they stand on, so slicers see one solid
    at_esp() translate([0, 0, -height - 0.4]) {
        translate([6, -0.5, 0]) cube([es_pcb_l - 8, 2.5, height + 0.4]);
        translate([6, es_w - 2, 0]) cube([es_pcb_l - 8, 2.5, height + 0.4]);
        // end stop behind the antenna end keeps the ports pressed to the wall
        translate([es_l + 0.2, (es_w - es_ant_w) / 2, 0]) cube([1.6, es_ant_w, height + 0.4 + es_pcb + 1]);
    }
}

module ledge(dir) {
    d = 2.0;
    translate([0, 0, tray_z]) mirror([0, dir < 0 ? 1 : 0, 0])
        hull() {
            translate([0, 0, -0.01]) cube([6, d, 0.01]);
            translate([0, 0, -d]) cube([6, 0.01, d]);
        }
}

// Stack only: removable tray above the battery that carries the ESP32.
module tray() {
    translate([wall, wall, floor_t]) difference() {
        union() {
            translate([fit, fit, tray_z]) cube([tray_l, IW - 2 * fit, tray_t]);
            esp_pocket();
        }
        // wire pass-through for 5V/GND
        translate([tray_l - 8, IW - 8, tray_z - 1]) cube([6, 6, tray_t + 2]);
    }
}

module lid() {
    lip_l = IL - 2 * fit;
    lip_w = IW - 2 * fit;
    translate([0, 0, OH]) difference() {
        union() {
            rrect(OL, OW, lid_t);
            // lip that drops inside the walls
            translate([wall + fit, wall + fit, -lip_h]) difference() {
                rrect(lip_l, lip_w, lip_h + 0.01, corner_r - 1.3);
                translate([lip_t, lip_t, -1]) rrect(lip_l - 2 * lip_t, lip_w - 2 * lip_t, lip_h + 2, corner_r - 2);
            }
            // snap bumps
            for (x = snap_xs, y = [wall + fit, wall + IW - fit])
                translate([wall + x - 4, y, -lip_h / 2]) rotate([0, 90, 0]) cylinder(r = snap_r, h = 8);
            lid_posts();
        }
        // lip must clear the port openings and plugs
        translate([wall, wall, floor_t - OH]) port_cuts(1);
        // engraved label
        translate([label_x, OW / 2 + (variant == "stack" ? 3 : 4), lid_t - 0.6])
            linear_extrude(1) text(label, size = variant == "slim" ? 7 : 5.5, font = "DejaVu Sans:style=Bold",
                                   halign = "center", valign = "center", spacing = 1.15);
        translate([label_x, OW / 2 - (variant == "stack" ? 6 : 8), lid_t - 0.6])
            linear_extrude(1) text(callsign, size = 3.5, font = "DejaVu Sans Mono", halign = "center", valign = "center");
        // resonance dip glyph
        translate([label_x, OW / 2 - (variant == "stack" ? 12 : 15), lid_t - 0.6]) linear_extrude(1) dip_glyph();
        // status LED window
        // status LED windows: one slot over the 3 LEDs, one over the RGB LED
        for (g = es_light_groups) translate([wall, wall, floor_t - OH]) at_esp() hull() for (l = g)
            translate([l[0], l[1], -50]) cylinder(d = len(g) > 1 ? 3.2 : 4.5, h = 100);
        // ON/OFF flexure: U-shaped slot around a tongue
    }
}

// A little SWR-dip curve
module dip_glyph() {
    pts = [for (i = [-20:20]) let(x = i * 0.9, y = 4.5 - 4.2 / (1 + pow(i / 5, 2))) [x, y]];
    for (i = [0:len(pts) - 2]) hull() {
        translate(pts[i]) circle(d = 0.9, $fn = 12);
        translate(pts[i + 1]) circle(d = 0.9, $fn = 12);
    }
}


module lid_posts() {
    // positions are in lid coordinates (z = 0 at the lid underside, negative is down)
    under = -(floor_t + IH);  // cavity floor in lid coordinates is at -(IH); offset by floor
    translate([wall, wall, -IH]) {
        // hold-downs
        if (variant != "stack") {
            at_shield() translate([sh_l / 2 - 8, sh_w / 2, sh_pcb + sh_over + 0.4])
                cylinder(d = 5, h = IH - (z_shield + sh_pcb + sh_over + 0.4) + 0.5);
        }
        at_esp() for (x = [es_l * 0.35], y = [1.2, es_w - 1.2])
            translate([x, y, es_pcb + 0.2]) cylinder(d = 2.4, h = IH - (z_esp + es_pcb + 0.2) + 0.5);
        // light pipe over the status LEDs
        for (g = es_light_groups) let(top = len(g) > 1 ? 1.2 : 2.2)
            at_esp() translate([0, 0, es_pcb + top]) difference() {
                hull() for (l = g) translate([l[0], l[1], 0]) cylinder(d = len(g) > 1 ? 6 : 7.5, h = IH - (z_esp + es_pcb + top) + 0.5);
                hull() for (l = g) translate([l[0], l[1], -1]) cylinder(d = len(g) > 1 ? 3.2 : 4.5, h = 100);
            }
    }
}

// ---------------------------------------------------------------- output

module mocks() {
    translate([wall, wall, floor_t]) {
        at_shield() shield_mock();
        at_shield() cell_mock();
        at_esp() esp_mock();
    }
}

if (part == "base") base();
else if (part == "lid") lid();
else if (part == "tray") { if (variant == "stack") tray(); }
else if (part == "shield") translate([wall, wall, floor_t]) at_shield() shield_mock();
else if (part == "cell") translate([wall, wall, floor_t]) at_shield() cell_mock();
else if (part == "esp") translate([wall, wall, floor_t]) at_esp() esp_mock();
else {
    color("#d9a441") base();
    if (variant == "stack") color("#c58f2f") tray();
    mocks();
    color("#e8e2d6", 0.35) translate([0, 0, 25]) lid();
}

echo(str("VARIANT ", variant, ": outside ", OL, " x ", OW, " x ", OH + lid_t, " mm"));
