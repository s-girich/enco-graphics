const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function createApp() {
  const elements = new Map();
  const moduleButtons = ["circle", "star", "snowflake", "text", "svg"].map(module => ({
    dataset: { module },
    classList: { toggle() {} },
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; }
  }));
  let downloadedBlob = null;
  let downloadedName = null;

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        checked: false,
        type: id === "solidAreas" ? "checkbox" : "text",
        files: [],
        style: {},
        classList: { toggle() {} },
        listeners: {},
        addEventListener(name, listener) { this.listeners[name] = listener; }
      });
    }
    return elements.get(id);
  }

  function fakeContext() {
    return {
      clearRect() {}, fillRect() {}, fillText() {},
      getImageData(x, y, width = 80, height = 80) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let row = Math.floor(height * 0.25); row < Math.ceil(height * 0.75); row++) {
          for (let col = Math.floor(width * 0.3); col < Math.ceil(width * 0.7); col++) {
            data[(row * width + col) * 4 + 3] = 255;
          }
        }
        return { data };
      }
    };
  }

  element("preview").getContext = fakeContext;

  const document = {
    getElementById: element,
    createElement(tag) {
      if (tag === "canvas") return { getContext: fakeContext };
      if (tag === "a") return {
        click() { downloadedName = this.download; },
        remove() {}
      };
      throw new Error("Unexpected element: " + tag);
    },
    querySelectorAll(selector) {
      if (selector === "[data-module]") return moduleButtons;
      return selector.startsWith("input:not(") ? [element("format")] : [];
    },
    querySelector() { return { hidden: false }; },
    body: { appendChild() {} }
  };

  const context = {
    document,
    window: { addEventListener() {}, alert(message) { throw new Error(message); } },
    URL: {
      createObjectURL(blob) { downloadedBlob = blob; return "blob:test"; },
      revokeObjectURL() {}
    },
    Blob,
    Uint8ClampedArray,
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    setTimeout() {},
    Image: function Image() {}
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  vm.runInNewContext(source, context);

  return {
    element,
    selectModule(module) {
      moduleButtons.find(button => button.dataset.module === module).listeners.click();
    },
    async exportSvg() {
      element("exportSvgButton").listeners.click();
      return { svg: await downloadedBlob.text(), name: downloadedName };
    }
  };
}

test("A4 exports a repeatable SVG with background, outlined text and physical dimensions", async () => {
  const app = createApp();
  app.element("format").value = "print-a4";
  app.element("format").listeners.input();
  const first = await app.exportSvg();
  const second = await app.exportSvg();

  assert.match(first.svg, /width="210mm" height="297mm" viewBox="0 0 1080 1527"/);
  assert.match(first.svg, /<rect width="1080" height="1527" fill="#122a4b"\/>/);
  assert.match(first.svg, /<path id="glyph-0" d="M/);
  assert.match(first.svg, /<use href="#glyph-/);
  assert.doesNotMatch(first.svg, /<text[ >]/);
  assert.equal(first.svg, second.svg);
  assert.match(first.name, /210x297mm/);
  const xml = spawnSync("xmllint", ["--noout", "-"], { input: first.svg, encoding: "utf8" });
  assert.equal(xml.status, 0, xml.stderr);
});

test("built-in modules stay vector geometry", async () => {
  const app = createApp();
  for (const [module, tag] of [["circle", "circle"], ["star", "polygon"], ["snowflake", "path"]]) {
    app.selectModule(module);
    const { svg } = await app.exportSvg();
    assert.match(svg, new RegExp("<" + tag + " "));
    assert.doesNotMatch(svg, /<image /);
  }
});

test("DL and custom sizes update both the artboard ratio and SVG dimensions", async () => {
  const app = createApp();
  assert.equal(app.element("customPrintSize").hidden, true);
  app.element("format").value = "print-dl";
  app.element("format").listeners.input();
  assert.equal(app.element("customPrintSize").hidden, true);
  const dl = await app.exportSvg();
  assert.match(dl.svg, /width="220mm" height="110mm" viewBox="0 0 2160 1080"/);

  app.element("format").value = "print-custom";
  app.element("format").listeners.input();
  assert.equal(app.element("customPrintSize").hidden, false);
  app.element("printWidthMm").value = "250";
  app.element("printHeightMm").value = "340";
  app.element("printWidthMm").listeners.change();
  const custom = await app.exportSvg();
  assert.equal(app.element("format").value, "print-custom");
  assert.equal(app.element("customPrintSize").hidden, false);
  assert.match(custom.svg, /width="250mm" height="340mm" viewBox="0 0 1080 1469"/);
});
