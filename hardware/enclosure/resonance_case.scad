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
sh_holes = [[3, 3], [sh_l - 3, 3], [3, sh_w - 3], [sh_l - 3, sh_w - 3]];  // ★ hole centers
sh_hole_d = 3.0;      // ★
sh_chg_x = 23.5;      // measured: USB-C center from the near short end (bottom side, long edge)
sh_btn = [88, sh_w - 3.5]; // x measured; ★ distance from the long edge
sh_btn_h = 1.75;      // measured: button top above PCB top

// ESP32-S3 DevKitC-1 style board (two USB-C ports on one short end)
es_l = 63.5;          // measured, incl. antenna overhang
es_pcb_l = 57.5;      // PCB alone (antenna sticks out 6 mm, 18.15 wide)
es_ant_w = 18.15;
es_w = 28.4;          // measured
es_pcb = 1.6;
es_over = 3.6;        // tallest part on top (module / USB-C)
es_under = headers ? 9.0 : 1.5;
es_overhang = 0.8;    // USB-C receptacles stick out past the PCB edge
es_ports_y = [8.2, 20.2]; // measured: 8 and 20 mm from the edge
es_port_z = 3.2;      // port center above PCB bottom
es_led = [];          // ★ RGB status LED [x, y]; empty = no light pipe

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
callsign = "W7LIT";

$fn = 48;

// ---------------------------------------------------------------- layout per variant

z_shield = sh_under + 0.5;                       // shield PCB bottom above the floor
cell_top = z_shield + sh_pcb + sh_over;
tray_t = 1.6;
tray_z = cell_top + 1.0;                         // stack: tray bottom
tray_l = sh_btn[0] - 12;                         // stack: stop short of the ON/OFF button
z_esp = variant == "stack" ? tray_z + tray_t + es_under : z_shield;
esp_top = z_esp + es_pcb + es_over;

IW = variant == "slim" ? es_w + 2 * fit + 3 + sh_w + fit : sh_w + 2 * fit;
IL = variant == "stick" ? sh_l + 2 * fit + 4 + es_l + es_overhang : sh_l + 2 * fit;
esp_port_top = z_esp + es_port_z + plug_h / 2;
IH = max(max(cell_top, esp_top) + 1.0, esp_port_top + 2.0);  // keep USB openings as closed windows

OL = IL + 2 * wall;
OW = IW + 2 * wall;
OH = floor_t + IH;                                 // base height; the lid sits on top

// Board placements (origin = PCB bottom-left corner of each board, in cavity coordinates)
// slim puts the ESP32 at the front so the shield's charge-port edge faces the back wall
module at_shield() { translate([fit, variant == "slim" ? es_w + 2 * fit + 3 : fit, z_shield]) children(); }

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
    color("#e8e8e8") translate([sh_btn[0] - 3, sh_btn[1] - 3, sh_pcb]) cube([6, 6, sh_btn_h]);
}

module cell_mock() {
    color("#2f9e6a") translate([9, sh_w / 2, sh_pcb + sh_over - 9.25]) rotate([0, 90, 0]) cylinder(d = 18.5, h = 65);
}

module esp_mock() {
    color("#202326") cube([es_pcb_l, es_w, es_pcb]);
    color("#b8bec6") translate([es_l - 25.5, (es_w - es_ant_w) / 2, es_pcb]) cube([25.5, es_ant_w, 3.2]);  // module
    for (y = es_ports_y) color("#c9ced4") translate([-es_overhang, y - 4.5, es_pcb]) cube([7.4, 9, 3.2]);
    if (len(es_led) == 2) color("#ff4fa3") translate([es_led[0] - 1, es_led[1] - 1, es_pcb]) cube([2, 2, 0.8]);
}

// ---------------------------------------------------------------- shapes

module rrect(l, w, h, r = corner_r) {
    hull() for (x = [r, l - r], y = [r, w - r]) translate([x, y, 0]) cylinder(r = r, h = h);
}

// Port openings, in cavity coordinates, extended through the walls.
module port_cuts(grow = 0) {
    // Battery shield USB-C charge port: bottom side, opens out of the long edge
    at_shield() translate([sh_chg_x, sh_w - 2, -1.6])
        rotate([-90, 0, 0]) linear_extrude(wall + fit + 4)
            offset(r = 2 + grow) square([plug_w - 4, plug_h - 4], center = true);
    // ESP32 USB-C ports (OTG to the NanoVNA, UART for flashing): one window for both
    at_esp() hull() for (y = es_ports_y)
        translate([-es_overhang - wall - 2, y, es_port_z])
            rotate([0, 90, 0]) linear_extrude(wall + 4)
                offset(r = 2 + grow) square([plug_h - 4, plug_w - 4], center = true);
}

// Groove (base) / bump (lid) positions for the snap fit
snap_xs = [IL * 0.25, IL * 0.75];
snap_z = OH - lip_h / 2;

module base() {
    difference() {
        rrect(OL, OW, OH);
        translate([wall, wall, floor_t]) rrect(IL, IW, IH + 1, corner_r - 1);
        translate([wall, wall, floor_t]) port_cuts();
        // snap grooves in the long walls
        for (x = snap_xs, y = [wall, wall + IW])
            translate([wall + x - 5, y, snap_z]) rotate([0, 90, 0]) cylinder(r = snap_r + 0.15, h = 10);
        // thumb notch to pry the lid
        translate([OL / 2, -1, OH]) rotate([-90, 0, 0]) cylinder(r = 5, h = 3);
    }
    translate([wall, wall, floor_t]) {
        // shield standoffs with locating pins
        at_shield() for (h = sh_holes) translate([h[0], h[1], -z_shield]) {
            cylinder(d = 6, h = z_shield);
            cylinder(d = sh_hole_d - 0.4, h = z_shield + sh_pcb + 1.2);
        }
        // ESP32 rails (slim/stick: from the floor; stack: on the tray)
        if (variant != "stack") esp_rails(z_esp);
        // stack: ledges that hold the tray, chamfered so they print without support
        if (variant == "stack")
            for (x = [8, tray_l - 14], y = [0, IW]) translate([x, y, 0]) ledge(y == 0 ? 1 : -1);
    }
}

module esp_rails(height) {
    at_esp() translate([0, 0, -height]) {
        translate([6, -0.5, 0]) cube([es_pcb_l - 8, 2.5, height]);
        translate([6, es_w - 2, 0]) cube([es_pcb_l - 8, 2.5, height]);
        // end stop behind the antenna end keeps the ports pressed to the wall
        translate([es_l + 0.2, (es_w - es_ant_w) / 2, 0]) cube([1.6, es_ant_w, height + es_pcb + 1]);
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
            translate([0, 0, tray_z + tray_t]) esp_rails(es_under);
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
        translate([OL / 2, OW / 2 + (variant == "stack" ? 3 : 4), lid_t - 0.6])
            linear_extrude(1) text(label, size = variant == "stack" ? 5.5 : 7, font = "DejaVu Sans:style=Bold",
                                   halign = "center", valign = "center", spacing = 1.15);
        translate([OL / 2, OW / 2 - (variant == "stack" ? 6 : 8), lid_t - 0.6])
            linear_extrude(1) text(callsign, size = 3.5, font = "DejaVu Sans Mono", halign = "center", valign = "center");
        // resonance dip glyph
        translate([OL / 2, OW / 2 - (variant == "stack" ? 12 : 15), lid_t - 0.6]) linear_extrude(1) dip_glyph();
        // status LED window
        if (len(es_led) == 2)
            translate([wall, wall, floor_t - OH]) at_esp() translate([es_led[0], es_led[1], -50]) cylinder(d = 3.2, h = 100);
        // ON/OFF flexure: U-shaped slot around a tongue
        translate([wall, wall, 0]) at_shield() translate([sh_btn[0], sh_btn[1], -z_shield]) flex_slot();
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

module flex_slot() {
    tl = 12; tw = 7; s = 1.0;  // tongue length, width, slot width
    translate([0, 0, 0]) difference() {
        translate([-tw / 2 - s, -tl + tw / 2, -1]) cube([tw + 2 * s, tl + s, lid_t + 2]);
        translate([-tw / 2, -tl + tw / 2 - 0.01, -2]) cube([tw, tl, lid_t + 4]);
    }
}

module lid_posts() {
    // positions are in lid coordinates (z = 0 at the lid underside, negative is down)
    under = -(floor_t + IH);  // cavity floor in lid coordinates is at -(IH); offset by floor
    translate([wall, wall, -IH]) {
        // ON/OFF plunger hanging from the tongue
        at_shield() translate([sh_btn[0], sh_btn[1], 0]) {
            h = IH - (z_shield + sh_pcb + sh_btn_h + 0.4);
            translate([0, 0, z_shield + sh_pcb + sh_btn_h + 0.4]) cylinder(d = 4, h = h);
        }
        // hold-downs
        if (variant != "stack") {
            at_shield() translate([sh_l / 2 - 8, sh_w / 2, sh_pcb + sh_over + 0.4])
                cylinder(d = 5, h = IH - (z_shield + sh_pcb + sh_over + 0.4));
        }
        at_esp() for (x = [es_l * 0.35], y = [1.2, es_w - 1.2])
            translate([x, y, es_pcb + 0.2]) cylinder(d = 2.4, h = IH - (z_esp + es_pcb + 0.2));
        // light pipe over the status LED
        if (len(es_led) == 2) at_esp() translate([es_led[0], es_led[1], es_pcb + 1.2]) difference() {
            cylinder(d = 6, h = IH - (z_esp + es_pcb + 1.2));
            translate([0, 0, -1]) cylinder(d = 3.2, h = 100);
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
