(function () {
  "use strict";

  var defaults = {
    width: 1080,
    height: 1350,
    format: "1080x1350",
    backgroundColor: "#122a4b",
    glowColor: "#ffffff",
    corner: "tl",
    axisOffset: 0,
    beamWidth: 100,
    beamCount: 5,
    falloff: 109,
    waviness: 96,
    waveScale: 86,
    waveIrregularity: 100,
    texture: 78,
    volumeDrift: 72,
    gridSize: 8,
    density: 82,
    densityContrast: 125,
    solidAreas: false,
    solidThreshold: 64,
    baseSize: 62,
    sizeVariation: 49,
    module: "star",
    symbols: ".·=0+",
    rotation: 0,
    seed: 314159
  };

  var state = Object.assign({}, defaults);
  var canvas = document.getElementById("preview");
  var ctx = canvas.getContext("2d", { alpha: false });
  var badge = document.getElementById("renderBadge");
  var renderFrame = 0;
  var svgImage = null;
  var svgObjectUrl = null;
  var symbolWeights = [];

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function mix(a, b, t) { return a + (b - a) * t; }
  function smoothstep(edge0, edge1, x) {
    var t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function hash2(x, y, seed, salt) {
    var h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(seed + salt, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function valueNoise(x, y, seed, salt) {
    var x0 = Math.floor(x);
    var y0 = Math.floor(y);
    var tx = x - x0;
    var ty = y - y0;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    var a = hash2(x0, y0, seed, salt);
    var b = hash2(x0 + 1, y0, seed, salt);
    var c = hash2(x0, y0 + 1, seed, salt);
    var d = hash2(x0 + 1, y0 + 1, seed, salt);
    return mix(mix(a, b, tx), mix(c, d, tx), ty);
  }

  function fbm(x, y, seed) {
    var value = 0;
    var amplitude = 0.58;
    var normalization = 0;
    for (var octave = 0; octave < 4; octave++) {
      value += valueNoise(x, y, seed, 83 + octave * 17) * amplitude;
      normalization += amplitude;
      x = x * 1.93 + 4.7;
      y = y * 1.93 - 3.1;
      amplitude *= 0.48;
    }
    return value / normalization;
  }

  function hexToRgb(hex) {
    var value = hex.replace("#", "");
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }

  function tint(rgb, lightness, alpha) {
    var warm = { r: 255, g: 142, b: 53 };
    var cool = { r: 217, g: 255, b: 224 };
    var edgeColor = lightness < 0.48 ? warm : cool;
    var blend = Math.abs(lightness - 0.5) * 0.34;
    return "rgba(" +
      Math.round(mix(rgb.r, edgeColor.r, blend)) + "," +
      Math.round(mix(rgb.g, edgeColor.g, blend)) + "," +
      Math.round(mix(rgb.b, edgeColor.b, blend)) + "," + alpha.toFixed(3) + ")";
  }

  function localCoordinates(x, y) {
    var sx = state.corner.indexOf("r") !== -1 ? state.width - x : x;
    var sy = state.corner.indexOf("b") !== -1 ? state.height - y : y;
    var u = (sx + sy) * Math.SQRT1_2;
    var v = (sy - sx) * Math.SQRT1_2;
    var diagonal = Math.hypot(state.width, state.height);
    return { u: u, v: v, diagonal: diagonal };
  }

  function brightnessAt(x, y) {
    var p = localCoordinates(x, y);
    // Виртуальный источник находится немного за границей холста. Благодаря
    // этому свет входит в кадр уже объёмным, но все потоки всё ещё имеют одну
    // геометрическую точку происхождения.
    var originDepth = p.diagonal * 0.105;
    var rayU = p.u + originDepth;
    var uN = rayU / p.diagonal;
    var vN = p.v / p.diagonal;
    var distanceN = Math.hypot(rayU, p.v) / p.diagonal;
    var axisShift = state.axisOffset / 100 * 0.42;
    var theta = Math.atan2(p.v, rayU) - axisShift;
    var halfAngle = mix(0.075, 0.72, state.beamWidth / 100);
    var conePosition = theta / halfAngle;
    var coneShell = Math.exp(-0.5 * Math.pow(conePosition / 0.92, 4));
    var longitudinal = Math.exp(-Math.max(0, distanceN - 0.08) * (195 / state.falloff));
    var sourceBloom = Math.exp(-Math.pow(distanceN / 0.19, 2)) * 0.15;

    // Несколько самостоятельных потоков лежат внутри общей оболочки конуса.
    // Между ними остаются тёмные каналы; центры и ширины меняются независимо.
    var phase = state.seed * 0.00037;
    var irregularity = state.waveIrregularity / 100;
    var count = Math.round(state.beamCount);
    var spacing = 1.58 / Math.max(1, count - 1);
    var widthScale = mix(0.58, 1.18, state.waveScale / 100);
    var driftStrength = state.volumeDrift / 100;
    var bendIn = smoothstep(0.1, 0.48, distanceN);
    var streams = 0;
    for (var streamIndex = 0; streamIndex < count; streamIndex++) {
      var baseCenter = count === 1 ? 0 : -0.79 + streamIndex * spacing;
      var centerJitter = (hash2(streamIndex, 0, state.seed, 127) - 0.5) * spacing * 0.34 * irregularity;
      var sharedDrift = Math.sin(distanceN * 2.15 + phase * 0.9) * spacing * 0.38 * driftStrength * bendIn;
      var privateDrift = (
        Math.sin(distanceN * (3.1 + streamIndex * 0.37) + phase * (streamIndex + 1.4)) * spacing * 0.27 +
        Math.sin(distanceN * 7.2 - phase + streamIndex * 1.7) * spacing * 0.09
      ) * driftStrength * bendIn;
      var streamCenter = baseCenter + centerJitter + sharedDrift + privateDrift;

      var widthRandom = mix(0.7, 1.32, hash2(streamIndex, 1, state.seed, 149));
      var widthPulse = 1 + irregularity * 0.32 * Math.sin(distanceN * (2.4 + streamIndex * 0.43) + phase + streamIndex * 2.1);
      var streamWidth = spacing * 0.31 * widthScale * widthRandom * widthPulse;
      var streamDelta = (conePosition - streamCenter) / Math.max(0.045, streamWidth);
      var streamBody = Math.exp(-0.5 * streamDelta * streamDelta);
      var streamStrength = mix(0.68, 1, hash2(streamIndex, 2, state.seed, 173));
      // max сохраняет границы потоков; сложение снова слило бы их в один луч.
      streams = Math.max(streams, streamBody * streamStrength);
    }

    // Два масштаба шума создают крупные уплотнения и более мелкую фактуру.
    // Они движутся в координатах всего конуса, а не приклеены к его оси.
    var cloudA = fbm(uN * 2.7 + vN * 1.15, vN * 4.2 - uN * 0.58, state.seed);
    var cloudB = fbm(uN * 6.4 - vN * 1.2, vN * 6.1 + uN * 0.44 + 11.2, state.seed + 911);
    var cloud = clamp(cloudA * 0.72 + cloudB * 0.28, 0, 1);
    var textureAmount = state.texture / 100;
    var cloudShape = smoothstep(0.19, 0.86, cloud);
    var cloudModulation = mix(1, 0.24 + cloudShape * 1.17, textureAmount);
    var waveMix = state.waviness / 100;

    var diffuseVolume = 0.14 + coneShell * 0.12;
    var separatedStreams = diffuseVolume + streams * 0.94;
    var internalVolume = mix(0.82, separatedStreams, waveMix);
    var light = coneShell * longitudinal * internalVolume * cloudModulation + sourceBloom * (0.35 + cloud * 0.24);
    var edgeFade = smoothstep(-0.01, 0.12, uN);
    return clamp(light * edgeFade, 0, 1);
  }

  function measureSymbols() {
    var chars = Array.from(state.symbols || "·");
    var sample = document.createElement("canvas");
    sample.width = sample.height = 80;
    var sampleCtx = sample.getContext("2d");
    symbolWeights = chars.map(function (char) {
      sampleCtx.clearRect(0, 0, 80, 80);
      sampleCtx.fillStyle = "white";
      sampleCtx.font = "700 58px Arial, sans-serif";
      sampleCtx.textAlign = "center";
      sampleCtx.textBaseline = "middle";
      sampleCtx.fillText(char, 40, 41);
      var pixels = sampleCtx.getImageData(0, 0, 80, 80).data;
      var mass = 0;
      for (var i = 3; i < pixels.length; i += 4) mass += pixels[i];
      return { char: char, mass: mass };
    }).sort(function (a, b) { return a.mass - b.mass; });
  }

  function drawModule(x, y, size, light, row, col, glowRgb) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(state.rotation * Math.PI / 180);
    // Все модули непрозрачны. Светотень создают только плотность, визуальная
    // масса и размер, поэтому перекрытия не меняют цвет частиц.
    var moduleColor = tint(glowRgb, light, 1);
    ctx.fillStyle = moduleColor;

    if (state.module === "text") {
      if (!symbolWeights.length) measureSymbols();
      var index = Math.round(light * (symbolWeights.length - 1));
      var nearby = hash2(col, row, state.seed, 41) > 0.72 ? (hash2(col, row, state.seed, 43) > 0.5 ? 1 : -1) : 0;
      index = clamp(index + nearby, 0, symbolWeights.length - 1);
      ctx.font = "700 " + size.toFixed(2) + "px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(symbolWeights[index].char, 0, size * 0.045);
    } else if (state.module === "star") {
      ctx.beginPath();
      for (var point = 0; point < 10; point++) {
        var radius = point % 2 === 0 ? size / 2 : size * 0.21;
        var starAngle = -Math.PI / 2 + point * Math.PI / 5;
        var starX = Math.cos(starAngle) * radius;
        var starY = Math.sin(starAngle) * radius;
        if (point === 0) ctx.moveTo(starX, starY);
        else ctx.lineTo(starX, starY);
      }
      ctx.closePath();
      ctx.fill();
    } else if (state.module === "snowflake") {
      var snowRadius = size * 0.47;
      ctx.strokeStyle = moduleColor;
      ctx.lineWidth = Math.max(0.8, size * 0.075);
      ctx.lineCap = "round";
      ctx.beginPath();
      for (var arm = 0; arm < 6; arm++) {
        var armAngle = arm * Math.PI / 3;
        var ax = Math.cos(armAngle);
        var ay = Math.sin(armAngle);
        ctx.moveTo(0, 0);
        ctx.lineTo(ax * snowRadius, ay * snowRadius);
        var branchBase = snowRadius * 0.58;
        var branchLength = snowRadius * 0.3;
        var bx = ax * branchBase;
        var by = ay * branchBase;
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(armAngle - 0.62) * branchLength, by + Math.sin(armAngle - 0.62) * branchLength);
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(armAngle + 0.62) * branchLength, by + Math.sin(armAngle + 0.62) * branchLength);
      }
      ctx.stroke();
    } else if (state.module === "svg" && svgImage) {
      ctx.globalAlpha = 1;
      ctx.drawImage(svgImage, -size / 2, -size / 2, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function render() {
    cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(function () {
      canvas.width = state.width;
      canvas.height = state.height;
      ctx.fillStyle = state.backgroundColor;
      ctx.fillRect(0, 0, state.width, state.height);

      var step = state.gridSize;
      var cols = Math.ceil(state.width / step) + 2;
      var rows = Math.ceil(state.height / step) + 2;
      var glowRgb = hexToRgb(state.glowColor);
      var densityPower = mix(2.4, 0.34, state.densityContrast / 240);
      var densityFactor = state.density / 100;
      var variation = state.sizeVariation / 100;
      var baseRatio = state.baseSize / 100;
      // Максимальный сдвиг зафиксирован: до 40% шага в каждую сторону.
      var jitterAmount = step * 0.4;
      var drawn = 0;

      for (var row = -1; row < rows; row++) {
        for (var col = -1; col < cols; col++) {
          var x = (col + 0.5) * step;
          var y = (row + 0.5) * step;
          var jitterX = (hash2(col, row, state.seed, 5) - 0.5) * 2 * jitterAmount;
          var jitterY = (hash2(col, row, state.seed, 9) - 0.5) * 2 * jitterAmount;
          x += jitterX;
          y += jitterY;

          var light = brightnessAt(x, y);
          var concentration = state.solidAreas
            ? smoothstep(state.solidThreshold / 100 - 0.1, state.solidThreshold / 100 + 0.075, light)
            : 0;
          // Даже самые яркие участки сохраняют микропустоты и не превращаются
          // в сплошную заливку, пока режим концентрации выключен.
          var probability = Math.min(Math.pow(light, densityPower) * densityFactor * 0.94, 0.88);
          // В режиме концентрации заливка возникает только из тех же модулей:
          // они становятся чаще и крупнее, пока не начинают перекрываться.
          probability = mix(probability, 0.995, concentration);
          if (hash2(col, row, state.seed, 17) > probability) continue;

          var constantSize = step * baseRatio;
          var tonalSize = step * baseRatio * mix(0.28, 1.38, Math.pow(light, 0.72));
          var size = mix(constantSize, tonalSize, variation);
          // Ползунок разброса определяет способ концентрации. При нуле размер
          // остаётся постоянным и яркое ядро собирается только количеством.
          // При росте параметра частицы также увеличиваются и перекрываются.
          var coalescedSize = step * mix(baseRatio, 1.72, concentration * variation);
          size = Math.max(size, coalescedSize);
          drawModule(x, y, Math.max(0.7, size), light, row, col, glowRgb);
          drawn++;
        }
      }
      badge.textContent = drawn.toLocaleString("ru-RU") + " элементов";
    });
  }

  function readControls() {
    ["axisOffset", "beamWidth", "beamCount", "falloff", "waviness", "waveScale", "waveIrregularity", "texture", "volumeDrift", "gridSize", "density", "densityContrast", "solidThreshold", "baseSize", "sizeVariation", "rotation", "seed"].forEach(function (id) {
      state[id] = Number(document.getElementById(id).value);
    });
    ["format", "backgroundColor", "glowColor", "symbols"].forEach(function (id) {
      state[id] = document.getElementById(id).value;
    });
    state.solidAreas = document.getElementById("solidAreas").checked;
    var dimensions = state.format.split("x").map(Number);
    state.width = dimensions[0];
    state.height = dimensions[1];
    measureSymbols();
  }

  function syncControls() {
    Object.keys(defaults).forEach(function (key) {
      var input = document.getElementById(key);
      if (input && input.type === "checkbox") input.checked = Boolean(state[key]);
      else if (input) input.value = state[key];
    });
    document.querySelectorAll("[data-output]").forEach(function (output) {
      output.value = state[output.dataset.output];
    });
    document.querySelectorAll("[data-corner]").forEach(function (button) {
      button.classList.toggle("is-active", button.dataset.corner === state.corner);
    });
    document.querySelectorAll("[data-module]").forEach(function (button) {
      button.classList.toggle("is-active", button.dataset.module === state.module);
    });
    document.querySelectorAll("[data-for-module]").forEach(function (node) {
      node.hidden = node.dataset.forModule !== state.module;
    });
    document.querySelector("[data-solid-option]").hidden = !state.solidAreas;
    measureSymbols();
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  document.querySelectorAll("input:not([type=file]), select").forEach(function (input) {
    input.addEventListener("input", function () {
      readControls();
      syncControls();
      render();
    });
  });

  document.querySelectorAll("[data-corner]").forEach(function (button) {
    button.addEventListener("click", function () {
      state.corner = button.dataset.corner;
      syncControls();
      render();
    });
  });

  document.querySelectorAll("[data-module]").forEach(function (button) {
    button.addEventListener("click", function () {
      state.module = button.dataset.module;
      syncControls();
      render();
    });
  });

  document.getElementById("randomizeButton").addEventListener("click", function () {
    state.seed = Math.floor(Math.random() * 999999998) + 1;
    syncControls();
    render();
  });

  document.getElementById("resetButton").addEventListener("click", function () {
    state = Object.assign({}, defaults);
    syncControls();
    render();
  });

  document.getElementById("exportButton").addEventListener("click", function () {
    render();
    requestAnimationFrame(function () {
      canvas.toBlob(function (blob) {
        if (blob) downloadBlob(blob, "enko-halftone-" + state.seed + ".png");
      }, "image/png");
    });
  });

  document.getElementById("savePresetButton").addEventListener("click", function () {
    var serializable = Object.assign({}, state, { svgName: svgImage ? document.getElementById("svgFile").files[0].name : null });
    downloadBlob(new Blob([JSON.stringify(serializable, null, 2)], { type: "application/json" }), "enko-halftone-" + state.seed + ".json");
  });

  document.getElementById("loadPresetInput").addEventListener("change", function (event) {
    var file = event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = JSON.parse(reader.result);
        state = Object.assign({}, defaults, incoming);
        delete state.jitter;
        state.width = Number(state.width) || defaults.width;
        state.height = Number(state.height) || defaults.height;
        syncControls();
        render();
      } catch (error) {
        window.alert("Не удалось прочитать пресет: некорректный JSON.");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("svgFile").addEventListener("change", function (event) {
    var file = event.target.files[0];
    var status = document.getElementById("svgStatus");
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var raw = String(reader.result);
      if (!/<svg[\s>]/i.test(raw) || /<script|<foreignObject|\son\w+\s*=/i.test(raw)) {
        status.textContent = "SVG отклонён: найден неподдерживаемый активный контент.";
        svgImage = null;
        render();
        return;
      }
      if (svgObjectUrl) URL.revokeObjectURL(svgObjectUrl);
      svgObjectUrl = URL.createObjectURL(new Blob([raw], { type: "image/svg+xml" }));
      var image = new Image();
      image.onload = function () {
        svgImage = image;
        status.textContent = "Загружено: " + file.name;
        render();
      };
      image.onerror = function () {
        svgImage = null;
        status.textContent = "Браузер не смог прочитать этот SVG.";
        URL.revokeObjectURL(svgObjectUrl);
        svgObjectUrl = null;
        render();
      };
      image.src = svgObjectUrl;
    };
    reader.readAsText(file);
  });

  syncControls();
  render();
}());
