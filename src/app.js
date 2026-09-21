(function () {
  "use strict";

  var defaults = {
    width: 1920,
    height: 1080,
    format: "1920x1080",
    printWidthMm: 210,
    printHeightMm: 118.13,
    backgroundColor: "#122a4b",
    glowColor: "#ffffff",
    corner: "tl",
    axisOffset: 0,
    beamWidth: 71,
    beamCount: 4,
    falloff: 177,
    waviness: 118,
    waveScale: 69,
    waveIrregularity: 0,
    texture: 42,
    volumeDrift: 0,
    volume: 150,
    colorTones: 100,
    gridSize: 8,
    density: 100,
    densityContrast: 155,
    rasterSmoothness: 100,
    solidAreas: true,
    solidThreshold: 25,
    baseSize: 105,
    sizeVariation: -28,
    module: "text",
    symbols: "ЭНКО",
    rotation: 0,
    seed: 314159
  };

  var state = Object.assign({}, defaults);
  var canvas = document.getElementById("preview");
  var stage = document.getElementById("stage");
  var ctx = canvas.getContext("2d");
  var exportCanvas = document.createElement("canvas");
  var exportCtx = exportCanvas.getContext("2d");
  var badge = document.getElementById("renderBadge");
  var renderFrame = 0;
  var svgImage = null;
  var svgObjectUrl = null;
  var svgSource = null;
  var symbolWeights = [];
  var graphicFont = '"ENKO Hauss Next", "ALS Hauss Next 1.0", Arial, sans-serif';

  var printFormats = {
    "print-a4": [210, 297],
    "print-a5": [148, 210],
    "print-a6": [105, 148],
    "print-dl": [220, 110],
    "print-c5": [229, 162],
    "print-card": [90, 50],
    "print-bag-s": [240, 330],
    "print-bag-m": [320, 410]
  };

  // Прогрессивная blue-noise-последовательность даёт 64 уровня плотности.
  // Новые позиции появляются равномерно, но без крупного узора Bayer 4x4.
  var BLUE_NOISE_8X8 = [
    40, 21, 37, 24, 43, 23, 38, 27,
    54, 0, 57, 9, 53, 2, 58, 10,
    34, 28, 45, 17, 33, 31, 47, 19,
    63, 13, 49, 6, 61, 15, 51, 5,
    42, 22, 39, 26, 41, 20, 36, 25,
    52, 3, 59, 11, 55, 1, 56, 8,
    32, 30, 46, 18, 35, 29, 44, 16,
    60, 14, 50, 4, 62, 12, 48, 7
  ];

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

  function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function orderedThreshold(col, row) {
    // Seed сдвигает фазу растра без нарушения порядка внутри тайла.
    var phaseX = positiveModulo(state.seed, 8);
    var phaseY = positiveModulo(Math.floor(state.seed / 8), 8);
    var tileX = positiveModulo(col + phaseX, 8);
    var tileY = positiveModulo(row + phaseY, 8);
    return (BLUE_NOISE_8X8[tileY * 8 + tileX] + 0.5) / 64;
  }

  function rasterCoverage(col, row, probability) {
    var threshold = orderedThreshold(col, row);
    var smoothness = state.rasterSmoothness / 100;
    if (smoothness <= 0) return probability > threshold ? 1 : 0;
    // Уже выбранная позиция всегда остаётся полностью проявленной. Перо идёт
    // навстречу порогу и добавляет новые промежуточные элементы вместо дырок.
    var feather = mix(0.004, 0.085, smoothness);
    if (probability >= threshold) return 1;
    return smoothstep(Math.max(0, threshold - feather), threshold, probability);
  }

  function rasterDensityModulation(col, row) {
    // Одна медленная маска действует сразу на десятки соседних ячеек. Она
    // собирает разрежение в связные участки, не добавляя одиночных выбросов.
    var densityField = valueNoise(col * 0.045 + 14.2, row * 0.045 - 6.8, state.seed + 1307, 211);
    return mix(0.84, 1.08, smoothstep(0.18, 0.82, densityField));
  }

  function rasterDisplacement(col, row, step) {
    // Два связанных масштаба сильнее изгибают ряды, но не разрывают локальное
    // соседство. Небольшой hash-сдвиг работает только как дефект печати.
    var coarseScale = 0.052;
    var detailScale = 0.145;
    var coarseX = fbm(col * coarseScale + 3.7, row * coarseScale - 8.1, state.seed + 1901);
    var coarseY = fbm(col * coarseScale - 12.4, row * coarseScale + 5.6, state.seed + 2903);
    var detailX = valueNoise(col * detailScale - 4.3, row * detailScale + 9.7, state.seed + 3911, 307);
    var detailY = valueNoise(col * detailScale + 8.6, row * detailScale - 2.9, state.seed + 4903, 331);
    var flowX = mix(coarseX, detailX, 0.38);
    var flowY = mix(coarseY, detailY, 0.38);
    var maxShift = step * 0.4;
    var microShift = step * 0.065;
    var microX = (hash2(col, row, state.seed, 5) * 2 - 1) * microShift;
    var microY = (hash2(col, row, state.seed, 9) * 2 - 1) * microShift;
    return {
      x: clamp((flowX * 2 - 1) * maxShift * 1.55 + microX, -maxShift, maxShift),
      y: clamp((flowY * 2 - 1) * maxShift * 1.55 + microY, -maxShift, maxShift)
    };
  }

  function hexToRgb(hex) {
    var value = hex.replace("#", "");
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }

  function rgbToHsl(rgb) {
    var red = rgb.r / 255;
    var green = rgb.g / 255;
    var blue = rgb.b / 255;
    var max = Math.max(red, green, blue);
    var min = Math.min(red, green, blue);
    var delta = max - min;
    var hue = 0;
    if (delta) {
      if (max === red) hue = ((green - blue) / delta) % 6;
      else if (max === green) hue = (blue - red) / delta + 2;
      else hue = (red - green) / delta + 4;
      hue = positiveModulo(hue * 60, 360);
    }
    var lightness = (max + min) / 2;
    var saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
    return { h: hue, s: saturation, l: lightness };
  }

  function hslToRgb(hue, saturation, lightness) {
    var chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    var section = positiveModulo(hue, 360) / 60;
    var second = chroma * (1 - Math.abs(section % 2 - 1));
    var red = 0;
    var green = 0;
    var blue = 0;
    if (section < 1) { red = chroma; green = second; }
    else if (section < 2) { red = second; green = chroma; }
    else if (section < 3) { green = chroma; blue = second; }
    else if (section < 4) { green = second; blue = chroma; }
    else if (section < 5) { red = second; blue = chroma; }
    else { red = chroma; blue = second; }
    var offset = lightness - chroma / 2;
    return {
      r: (red + offset) * 255,
      g: (green + offset) * 255,
      b: (blue + offset) * 255
    };
  }

  function colorFlowAt(x, y) {
    var p = localCoordinates(x, y);
    var originDepth = p.diagonal * 0.105;
    var rayU = p.u + originDepth;
    var distanceN = Math.hypot(rayU, p.v) / p.diagonal;
    var axisShift = state.axisOffset / 100 * 0.42;
    var theta = Math.atan2(p.v, rayU) - axisShift;
    var halfAngle = mix(0.075, 0.72, state.beamWidth / 100);
    var conePosition = theta / halfAngle;
    var drift = state.volumeDrift / 100;
    var phase = state.seed * 0.00037;
    // Цветовые ленты следуют поперечной геометрии потоков и постепенно
    // изгибаются по длине луча. Здесь нет отдельной пятнистой noise-маски.
    var bend = Math.sin(distanceN * 3.1 + phase) * 0.42 * drift;
    var ripple = Math.sin(distanceN * 7.4 - phase * 1.7) * 0.11;
    var waveCoordinate = conePosition - bend + ripple;
    var primary = Math.sin(waveCoordinate * 7.2 + distanceN * 2.8 + phase * 2.3);
    var secondary = Math.sin(waveCoordinate * 3.4 - distanceN * 1.9 - phase);
    return clamp(0.5 + primary * 0.34 + secondary * 0.16, 0, 1);
  }

  function moduleAppearance(rgb, lightness, x, y) {
    var volume = state.volume / 100;
    var toneAmount = state.colorTones / 100;
    var baseHsl = rgbToHsl(rgb);
    var colorFlow = colorFlowAt(x, y);
    var core = smoothstep(0.56, 0.96, lightness);
    var edge = 1 - smoothstep(0.12, 0.78, lightness);
    // Для насыщенных цветов строим аналоговую палитру вокруг исходного hue.
    // Золотой, например, естественно уходит в красно-оранжевые полутона.
    var hueShift = mix(-38, 10, core) + (colorFlow - 0.5) * 28;
    var tintHue = baseHsl.s < 0.08
      ? mix(18, 210, clamp(core * 0.68 + colorFlow * 0.42, 0, 1))
      : baseHsl.h + hueShift;
    var tintSaturation = baseHsl.s < 0.08
      ? mix(0.72, 0.24, core)
      : clamp(baseHsl.s + edge * 0.2 + (colorFlow - 0.5) * 0.16, 0, 1);
    var tintLightness = clamp(baseHsl.l + mix(-0.13, 0.2, core) + (colorFlow - 0.5) * 0.08, 0.06, 0.96);
    var toneColor = hslToRgb(tintHue, tintSaturation, tintLightness);
    var toneMix = toneAmount * mix(0.34, 0.72, edge + Math.abs(colorFlow - 0.5) * 0.35);
    var whiteLift = toneAmount * core * 0.16;
    var red = mix(mix(rgb.r, toneColor.r, toneMix), 255, whiteLift);
    var green = mix(mix(rgb.g, toneColor.g, toneMix), 255, whiteLift);
    var blue = mix(mix(rgb.b, toneColor.b, toneMix), 255, whiteLift);

    var lightAlpha = mix(0.2, 1, smoothstep(0.02, 0.82, lightness));
    var alphaTexture = mix(0.88, 1.06, colorFlow);
    var dimensionalAlpha = clamp(lightAlpha * alphaTexture, 0.12, 1);
    return {
      color: "rgb(" + Math.round(red) + "," + Math.round(green) + "," + Math.round(blue) + ")",
      alpha: clamp(mix(1, dimensionalAlpha, volume), 0.05, 1),
      r: red,
      g: green,
      b: blue,
      flow: colorFlow
    };
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
      sampleCtx.font = "500 58px " + graphicFont;
      sampleCtx.textAlign = "center";
      sampleCtx.textBaseline = "middle";
      sampleCtx.fillText(char, 40, 41);
      var pixels = sampleCtx.getImageData(0, 0, 80, 80).data;
      var mass = 0;
      for (var i = 3; i < pixels.length; i += 4) mass += pixels[i];
      return { char: char, mass: mass };
    }).sort(function (a, b) { return a.mass - b.mass; });
  }

  function symbolAt(light, row, col) {
    if (!symbolWeights.length) measureSymbols();
    var index = Math.round(light * (symbolWeights.length - 1));
    var nearby = hash2(col, row, state.seed, 41) > 0.72 ? (hash2(col, row, state.seed, 43) > 0.5 ? 1 : -1) : 0;
    return symbolWeights[clamp(index + nearby, 0, symbolWeights.length - 1)].char;
  }

  function drawModule(x, y, size, light, row, col, glowRgb, coverage) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(state.rotation * Math.PI / 180);
    // Глобальный объём добавляет оптическую глубину каждому модулю, не создавая
    // отдельной маски или blur за пределами растровой системы.
    var appearance = moduleAppearance(glowRgb, light, x, y);
    var moduleColor = appearance.color;
    ctx.globalAlpha = appearance.alpha * coverage;
    ctx.fillStyle = moduleColor;

    if (state.module === "text") {
      ctx.font = "500 " + size.toFixed(2) + "px " + graphicFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(symbolAt(light, row, col), 0, size * 0.045);
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
      ctx.drawImage(svgImage, -size / 2, -size / 2, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function forEachParticle(visit) {
      var step = state.gridSize;
      var cols = Math.ceil(state.width / step) + 2;
      var rows = Math.ceil(state.height / step) + 2;
      var glowRgb = hexToRgb(state.glowColor);
      var densityPower = mix(2.4, 0.34, state.densityContrast / 240);
      var densityFactor = state.density / 100;
      var variation = state.sizeVariation / 100;
      var baseRatio = state.baseSize / 100;
      var drawn = 0;

      for (var row = -1; row < rows; row++) {
        for (var col = -1; col < cols; col++) {
          var x = (col + 0.5) * step;
          var y = (row + 0.5) * step;
          var displacement = rasterDisplacement(col, row, step);
          x += displacement.x;
          y += displacement.y;

          var light = brightnessAt(x, y);
          var concentration = state.solidAreas
            ? smoothstep(state.solidThreshold / 100 - 0.1, state.solidThreshold / 100 + 0.075, light)
            : 0;
          // Даже самые яркие участки сохраняют микропустоты и не превращаются
          // в сплошную заливку, пока режим концентрации выключен.
          var densityModulation = rasterDensityModulation(col, row);
          // При росте плавности яркие потоки заполняются полнее. У края луча
          // тон по-прежнему формируется постепенным появлением модулей.
          var densityCeiling = mix(0.88, 0.985, state.rasterSmoothness / 100);
          var probability = Math.min(Math.pow(light, densityPower) * densityFactor * densityModulation * 0.94, densityCeiling);
          // В режиме концентрации заливка возникает только из тех же модулей:
          // они становятся чаще и крупнее, пока не начинают перекрываться.
          probability = mix(probability, 0.995, concentration);
          var coverage = rasterCoverage(col, row, probability);
          if (coverage <= 0.001) continue;

          var constantSize = step * baseRatio;
          var tonalSize = step * baseRatio * mix(0.28, 1.38, Math.pow(light, 0.72));
          var size = mix(constantSize, tonalSize, variation);
          // Ползунок разброса определяет способ концентрации. При нуле размер
          // остаётся постоянным и яркое ядро собирается только количеством.
          // При росте параметра частицы также увеличиваются и перекрываются.
          var coalescedSize = step * mix(baseRatio, 1.72, concentration * variation);
          size = Math.max(size, coalescedSize);
          visit(x, y, Math.max(0.7, size), light, row, col, glowRgb, coverage);
          drawn++;
        }
      }
    return drawn;
  }

  function renderScene(targetCanvas, targetCtx, includeBackground) {
    var previousCtx = ctx;
    ctx = targetCtx;
    try {
      targetCanvas.width = state.width;
      targetCanvas.height = state.height;
      ctx.clearRect(0, 0, state.width, state.height);
      if (includeBackground) {
        ctx.fillStyle = state.backgroundColor;
        ctx.fillRect(0, 0, state.width, state.height);
      }
      return forEachParticle(drawModule);
    } finally {
      ctx = previousCtx;
    }
  }

  function svgNumber(value) {
    return Number(value.toFixed(3)).toString();
  }

  function glyphOutline(char) {
    var canvasSize = 256;
    var fontSize = 192;
    var glyphCanvas = document.createElement("canvas");
    glyphCanvas.width = glyphCanvas.height = canvasSize;
    var glyphCtx = glyphCanvas.getContext("2d");
    glyphCtx.clearRect(0, 0, canvasSize, canvasSize);
    glyphCtx.fillStyle = "white";
    glyphCtx.font = "500 " + fontSize + "px " + graphicFont;
    glyphCtx.textAlign = "center";
    glyphCtx.textBaseline = "middle";
    glyphCtx.fillText(char, canvasSize / 2, canvasSize / 2 + fontSize * 0.045);

    var pixels = glyphCtx.getImageData(0, 0, canvasSize, canvasSize).data;
    var mask = new Uint8Array(canvasSize * canvasSize);
    for (var pixel = 0; pixel < mask.length; pixel++) mask[pixel] = pixels[pixel * 4 + 3] >= 96 ? 1 : 0;
    function filled(x, y) {
      return x >= 0 && y >= 0 && x < canvasSize && y < canvasSize && mask[y * canvasSize + x];
    }

    var edges = [];
    function edge(sx, sy, ex, ey, direction) {
      edges.push({ sx: sx, sy: sy, ex: ex, ey: ey, direction: direction });
    }
    for (var y = 0; y < canvasSize; y++) {
      for (var x = 0; x < canvasSize; x++) {
        if (!filled(x, y)) continue;
        if (!filled(x, y - 1)) edge(x, y, x + 1, y, 0);
        if (!filled(x + 1, y)) edge(x + 1, y, x + 1, y + 1, 1);
        if (!filled(x, y + 1)) edge(x + 1, y + 1, x, y + 1, 2);
        if (!filled(x - 1, y)) edge(x, y + 1, x, y, 3);
      }
    }

    var starts = new Map();
    edges.forEach(function (item, index) {
      var key = item.sx + "," + item.sy;
      if (!starts.has(key)) starts.set(key, []);
      starts.get(key).push(index);
    });
    var used = new Uint8Array(edges.length);
    var commands = [];
    var turnOrder = [1, 0, 3, 2];

    edges.forEach(function (first, firstIndex) {
      if (used[firstIndex]) return;
      var loop = [];
      var edgeIndex = firstIndex;
      var startKey = first.sx + "," + first.sy;
      var guard = 0;
      while (!used[edgeIndex] && guard++ <= edges.length) {
        var current = edges[edgeIndex];
        used[edgeIndex] = 1;
        loop.push(current);
        var endKey = current.ex + "," + current.ey;
        if (endKey === startKey) break;
        var candidates = (starts.get(endKey) || []).filter(function (candidate) { return !used[candidate]; });
        if (!candidates.length) break;
        candidates.sort(function (a, b) {
          var turnA = (edges[a].direction - current.direction + 4) % 4;
          var turnB = (edges[b].direction - current.direction + 4) % 4;
          return turnOrder.indexOf(turnA) - turnOrder.indexOf(turnB);
        });
        edgeIndex = candidates[0];
      }
      if (!loop.length) return;
      function coordinate(value) { return svgNumber((value - canvasSize / 2) / fontSize); }
      var path = "M" + coordinate(loop[0].sx) + " " + coordinate(loop[0].sy);
      for (var segment = 0; segment < loop.length; segment++) {
        var next = loop[(segment + 1) % loop.length];
        if (segment === loop.length - 1 || loop[segment].direction !== next.direction) {
          path += "L" + coordinate(loop[segment].ex) + " " + coordinate(loop[segment].ey);
        }
      }
      commands.push(path + "Z");
    });
    return commands.join("");
  }

  function buildGlyphDefs() {
    var ids = new Map();
    var definitions = [];
    Array.from(new Set(Array.from(state.symbols || "·"))).forEach(function (char, index) {
      var id = "glyph-" + index;
      ids.set(char, id);
      definitions.push('<path id="' + id + '" d="' + glyphOutline(char) + '"/>');
    });
    return { ids: ids, markup: definitions.join("") };
  }

  function svgModule(x, y, size, light, row, col, glowRgb, coverage, customSvg, glyphIds) {
    var appearance = moduleAppearance(glowRgb, light, x, y);
    var parts = [
      '<g transform="translate(' + svgNumber(x) + ' ' + svgNumber(y) + ') rotate(' + svgNumber(state.rotation) + ')" opacity="' +
        svgNumber(appearance.alpha * coverage) + '">'
    ];
    var fill = appearance.color;

    if (state.module === "text") {
      var glyphId = glyphIds.get(symbolAt(light, row, col));
      parts.push('<use href="#' + glyphId + '" xlink:href="#' + glyphId + '" fill="' + fill + '" transform="scale(' + svgNumber(size) + ')"/>');
    } else if (state.module === "star") {
      var starPoints = [];
      for (var point = 0; point < 10; point++) {
        var radius = point % 2 === 0 ? size / 2 : size * 0.21;
        var angle = -Math.PI / 2 + point * Math.PI / 5;
        starPoints.push(svgNumber(Math.cos(angle) * radius) + ',' + svgNumber(Math.sin(angle) * radius));
      }
      parts.push('<polygon points="' + starPoints.join(' ') + '" fill="' + fill + '"/>');
    } else if (state.module === "snowflake") {
      var path = [];
      var snowRadius = size * 0.47;
      for (var arm = 0; arm < 6; arm++) {
        var armAngle = arm * Math.PI / 3;
        var ax = Math.cos(armAngle);
        var ay = Math.sin(armAngle);
        var bx = ax * snowRadius * 0.58;
        var by = ay * snowRadius * 0.58;
        var branchLength = snowRadius * 0.3;
        path.push('M0 0L' + svgNumber(ax * snowRadius) + ' ' + svgNumber(ay * snowRadius));
        path.push('M' + svgNumber(bx) + ' ' + svgNumber(by) + 'L' +
          svgNumber(bx + Math.cos(armAngle - 0.62) * branchLength) + ' ' +
          svgNumber(by + Math.sin(armAngle - 0.62) * branchLength));
        path.push('M' + svgNumber(bx) + ' ' + svgNumber(by) + 'L' +
          svgNumber(bx + Math.cos(armAngle + 0.62) * branchLength) + ' ' +
          svgNumber(by + Math.sin(armAngle + 0.62) * branchLength));
      }
      parts.push('<path d="' + path.join('') + '" fill="none" stroke="' + fill +
        '" stroke-width="' + svgNumber(Math.max(0.8, size * 0.075)) + '" stroke-linecap="round"/>');
    } else if (state.module === "svg" && customSvg) {
      var nested = customSvg.cloneNode(true);
      nested.setAttribute("x", svgNumber(-size / 2));
      nested.setAttribute("y", svgNumber(-size / 2));
      nested.setAttribute("width", svgNumber(size));
      nested.setAttribute("height", svgNumber(size));
      nested.setAttribute("preserveAspectRatio", "none");
      parts.push(new XMLSerializer().serializeToString(nested));
    } else {
      parts.push('<circle cx="0" cy="0" r="' + svgNumber(size / 2) + '" fill="' + fill + '"/>');
    }
    parts.push('</g>');
    return parts.join('');
  }

  function buildSvg() {
    var widthMm = state.printWidthMm;
    var heightMm = state.printHeightMm;
    var customSvg = null;
    var glyphDefs = { ids: new Map(), markup: "" };
    if (state.module === "svg") {
      if (!svgSource || !svgImage) throw new Error("Сначала загрузите SVG-модуль.");
      customSvg = new DOMParser().parseFromString(svgSource, "image/svg+xml").documentElement;
    }
    if (state.module === "text") glyphDefs = buildGlyphDefs();
    var fragments = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + svgNumber(widthMm) +
        'mm" height="' + svgNumber(heightMm) + 'mm" viewBox="0 0 ' + state.width + ' ' + state.height +
        '" preserveAspectRatio="none">',
      '<defs><clipPath id="artboard"><rect width="' + state.width + '" height="' + state.height + '"/></clipPath>' + glyphDefs.markup + '</defs>',
      '<rect width="' + state.width + '" height="' + state.height + '" fill="' + state.backgroundColor + '"/>',
      '<g clip-path="url(#artboard)">'
    ];
    forEachParticle(function (x, y, size, light, row, col, glowRgb, coverage) {
      fragments.push(svgModule(x, y, size, light, row, col, glowRgb, coverage, customSvg, glyphDefs.ids));
    });
    fragments.push('</g></svg>');
    return fragments.join('\n');
  }

  function render() {
    cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(function () {
      var drawn = renderScene(canvas, ctx, true);
      fitPreview();
      badge.textContent = drawn.toLocaleString("ru-RU") + " элементов";
    });
  }

  function fitPreview() {
    var scale = Math.min(stage.clientWidth / state.width, stage.clientHeight / state.height);
    if (!Number.isFinite(scale) || scale <= 0) return;
    canvas.style.width = Math.floor(state.width * scale) + "px";
    canvas.style.height = Math.floor(state.height * scale) + "px";
  }

  if (window.ResizeObserver) {
    new ResizeObserver(fitPreview).observe(stage);
  } else {
    window.addEventListener("resize", fitPreview);
  }

  function printCanvasSize(widthMm, heightMm) {
    var ratio = Math.max(widthMm, heightMm) / Math.min(widthMm, heightMm);
    var shortSide = Math.floor(Math.min(1080, 3000 / ratio));
    return widthMm <= heightMm
      ? [shortSide, Math.round(shortSide * ratio)]
      : [Math.round(shortSide * ratio), shortSide];
  }

  function updatePrintSizeFromFormat(format) {
    var dimensions = printFormats[format];
    if (!dimensions && /^\d+x\d+$/.test(format)) {
      var screenSize = format.split("x").map(Number);
      dimensions = [210, Math.round(21000 * screenSize[1] / screenSize[0]) / 100];
    }
    if (!dimensions) return;
    document.getElementById("printWidthMm").value = dimensions[0];
    document.getElementById("printHeightMm").value = dimensions[1];
  }

  function readControls() {
    ["axisOffset", "beamWidth", "beamCount", "falloff", "waviness", "waveScale", "waveIrregularity", "texture", "volumeDrift", "volume", "colorTones", "gridSize", "density", "densityContrast", "rasterSmoothness", "solidThreshold", "baseSize", "sizeVariation", "rotation", "seed"].forEach(function (id) {
      state[id] = Number(document.getElementById(id).value);
    });
    ["format", "backgroundColor", "glowColor", "symbols"].forEach(function (id) {
      state[id] = document.getElementById(id).value;
    });
    ["printWidthMm", "printHeightMm"].forEach(function (id) {
      var value = Number(document.getElementById(id).value);
      if (Number.isFinite(value) && value >= 20 && value <= 1000) state[id] = value;
    });
    state.solidAreas = document.getElementById("solidAreas").checked;
    var dimensions = /^\d+x\d+$/.test(state.format)
      ? state.format.split("x").map(Number)
      : printCanvasSize(state.printWidthMm, state.printHeightMm);
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
    document.getElementById("customPrintSize").hidden = state.format !== "print-custom";
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

  document.querySelectorAll("input:not([type=file]):not(#printWidthMm):not(#printHeightMm), select").forEach(function (input) {
    input.addEventListener("input", function () {
      if (input.id === "format") updatePrintSizeFromFormat(input.value);
      readControls();
      syncControls();
      render();
    });
  });

  ["printWidthMm", "printHeightMm"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", function () {
      var widthInput = document.getElementById("printWidthMm");
      var heightInput = document.getElementById("printHeightMm");
      var width = Number(widthInput.value);
      var height = Number(heightInput.value);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 20 || height < 20 || width > 1000 || height > 1000) {
        widthInput.value = state.printWidthMm;
        heightInput.value = state.printHeightMm;
        window.alert("Укажите ширину и высоту от 20 до 1000 мм.");
        return;
      }
      document.getElementById("format").value = "print-custom";
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
    renderScene(exportCanvas, exportCtx, false);
    exportCanvas.toBlob(function (blob) {
      if (blob) downloadBlob(blob, "enko-halftone-" + state.seed + ".png");
    }, "image/png");
  });

  document.getElementById("exportSvgButton").addEventListener("click", function () {
    try {
      var svg = buildSvg();
      var filename = "enko-halftone-" + svgNumber(state.printWidthMm) + "x" + svgNumber(state.printHeightMm) + "mm-" + state.seed + ".svg";
      downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), filename);
    } catch (error) {
      window.alert("Не удалось создать SVG: " + error.message);
    }
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
        if (!Number.isFinite(state.printWidthMm) || state.printWidthMm < 20 || state.printWidthMm > 1000) {
          state.printWidthMm = defaults.printWidthMm;
        }
        if (!Number.isFinite(state.printHeightMm) || state.printHeightMm < 20 || state.printHeightMm > 1000) {
          state.printHeightMm = defaults.printHeightMm;
        }
        var dimensions = /^\d+x\d+$/.test(state.format)
          ? state.format.split("x").map(Number)
          : printCanvasSize(state.printWidthMm, state.printHeightMm);
        state.width = dimensions[0];
        state.height = dimensions[1];
        syncControls();
        render();
      } catch (error) {
        window.alert("Не удалось прочитать пресет: некорректный JSON.");
      }
    };
    reader.readAsText(file);
  });

  function isSafeSvgSource(raw) {
    if (/<!DOCTYPE|<\?xml-stylesheet/i.test(raw)) return false;
    var documentSvg = new DOMParser().parseFromString(raw, "image/svg+xml");
    if (documentSvg.querySelector("parsererror") || documentSvg.documentElement.localName.toLowerCase() !== "svg") return false;
    var forbidden = /^(script|foreignobject|image|iframe|object|embed|audio|video|style|animate|animatetransform|animatemotion|set|feimage)$/i;
    var elements = documentSvg.getElementsByTagName("*");
    for (var elementIndex = 0; elementIndex < elements.length; elementIndex++) {
      var element = elements[elementIndex];
      if (forbidden.test(element.localName)) return false;
      for (var attributeIndex = 0; attributeIndex < element.attributes.length; attributeIndex++) {
        var attribute = element.attributes[attributeIndex];
        var name = attribute.localName.toLowerCase();
        var value = attribute.value.trim();
        if (/^on/.test(name) || name === "href" && value.charAt(0) !== "#") return false;
        if (/@import/i.test(value)) return false;
        var urls = value.match(/url\([^)]*\)/gi) || [];
        for (var urlIndex = 0; urlIndex < urls.length; urlIndex++) {
          if (!/^url\(\s*['"]?#[^'"\s)]+['"]?\s*\)$/i.test(urls[urlIndex])) return false;
        }
      }
    }
    return true;
  }

  document.getElementById("svgFile").addEventListener("change", function (event) {
    var file = event.target.files[0];
    var status = document.getElementById("svgStatus");
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var raw = String(reader.result);
      if (!isSafeSvgSource(raw)) {
        status.textContent = "SVG отклонён: найден неподдерживаемый активный контент.";
        svgImage = null;
        svgSource = null;
        render();
        return;
      }
      if (svgObjectUrl) URL.revokeObjectURL(svgObjectUrl);
      svgObjectUrl = URL.createObjectURL(new Blob([raw], { type: "image/svg+xml" }));
      var image = new Image();
      image.onload = function () {
        svgImage = image;
        svgSource = raw;
        status.textContent = "Загружено: " + file.name;
        render();
      };
      image.onerror = function () {
        svgImage = null;
        svgSource = null;
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
  if (document.fonts && document.fonts.load) {
    document.fonts.load('500 64px "ENKO Hauss Next"').then(function () {
      measureSymbols();
      render();
    }, render);
  } else render();
}());
