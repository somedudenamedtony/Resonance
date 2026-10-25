// Renders public/icon.svg to the PNG sizes the manifest and iOS need.
// Needs Playwright with Chromium. Run `node app/scripts/icons.cjs` after changing the SVG; the PNGs are committed.
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const pub = path.join(__dirname, "../public/");

(async () => {
const svg = await readFile(pub + "icon.svg", "utf8");

// Full-bleed square: iOS and Android add their own rounded mask. The maskable icon keeps the
// mark inside the 80% safe zone.
const targets = [
  { file: "apple-touch-icon.png", size: 180, scale: 1 },
  { file: "icon-192.png", size: 192, scale: 1 },
  { file: "icon-512.png", size: 512, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, scale: 0.8 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<style>html,body{margin:0;background:#00545c}svg{display:block;width:100%;height:100%}
     .mark{transform:scale(${t.scale});transform-origin:50% 50%}</style>${svg}`,
  );
  if (t.scale !== 1) {
    await page.evaluate(() => {
      const s = document.querySelector("svg");
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "mark");
      for (const el of [...s.querySelectorAll(":scope > path, :scope > circle")]) g.appendChild(el);
      s.appendChild(g);
    });
  }
  await page.screenshot({ path: pub + t.file, omitBackground: false });
  console.log(t.file);
}
await browser.close();
})();
