import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import png2icons from "png2icons";
import UPNG from "png2icons/lib/UPNG.js";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptsDirectory, "..");
const pdfIconSource = path.join(
  projectDirectory,
  "installer",
  "PdfDocument-original.png",
);
const pdfIconPng = path.join(
  projectDirectory,
  "installer",
  "PdfDocument.png",
);
const pptxIconPng = path.join(
  projectDirectory,
  "installer",
  "PptxDocument.png",
);
const pdfIconSize = 1024;
const pdfCropPadding = 6;
const pdfTargetPadding = 48;

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

function isRedPixel(red, green, blue) {
  return (
    red >= 120 &&
    red - green >= 10 &&
    red - blue >= 10
  );
}

function findRedBounds(pixels, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (
        isRedPixel(
          pixels[offset],
          pixels[offset + 1],
          pixels[offset + 2],
        )
      ) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }

  if (right < left || bottom < top) {
    throw new Error(
      "No se encontró el dibujo rojo del icono PDF.",
    );
  }

  return {
    left: Math.max(0, left - pdfCropPadding),
    top: Math.max(0, top - pdfCropPadding),
    right: Math.min(width - 1, right + pdfCropPadding),
    bottom: Math.min(height - 1, bottom + pdfCropPadding),
  };
}

function cropPixels(pixels, sourceWidth, bounds) {
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const cropped = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceStart =
      ((bounds.top + y) * sourceWidth + bounds.left) * 4;
    const destinationStart = y * width * 4;
    cropped.set(
      pixels.subarray(sourceStart, sourceStart + width * 4),
      destinationStart,
    );
  }

  return { pixels: cropped, width, height };
}

function makeExteriorTransparent(pixels, width, height) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (x, y) => {
    const index = y * width + x;
    if (visited[index]) {
      return;
    }

    const offset = index * 4;
    if (
      isRedPixel(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
      )
    ) {
      return;
    }

    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    pixels[index * 4 + 3] = 0;

    if (x > 0) {
      enqueue(x - 1, y);
    }
    if (x + 1 < width) {
      enqueue(x + 1, y);
    }
    if (y > 0) {
      enqueue(x, y - 1);
    }
    if (y + 1 < height) {
      enqueue(x, y + 1);
    }
  }
}

function resizePremultiplied(
  source,
  sourceWidth,
  sourceHeight,
  destinationWidth,
  destinationHeight,
) {
  const destination = new Uint8Array(
    destinationWidth * destinationHeight * 4,
  );

  for (let y = 0; y < destinationHeight; y += 1) {
    const sourceY =
      ((y + 0.5) * sourceHeight) / destinationHeight - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const yWeight = Math.max(0, sourceY - y0);

    for (let x = 0; x < destinationWidth; x += 1) {
      const sourceX =
        ((x + 0.5) * sourceWidth) / destinationWidth - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const xWeight = Math.max(0, sourceX - x0);
      const samples = [
        [
          (y0 * sourceWidth + x0) * 4,
          (1 - xWeight) * (1 - yWeight),
        ],
        [
          (y0 * sourceWidth + x1) * 4,
          xWeight * (1 - yWeight),
        ],
        [
          (y1 * sourceWidth + x0) * 4,
          (1 - xWeight) * yWeight,
        ],
        [
          (y1 * sourceWidth + x1) * 4,
          xWeight * yWeight,
        ],
      ];

      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (const [offset, weight] of samples) {
        const sampleAlpha = source[offset + 3] / 255;
        alpha += sampleAlpha * weight;
        red += source[offset] * sampleAlpha * weight;
        green += source[offset + 1] * sampleAlpha * weight;
        blue += source[offset + 2] * sampleAlpha * weight;
      }

      const destinationOffset =
        (y * destinationWidth + x) * 4;
      if (alpha > 0) {
        destination[destinationOffset] = Math.round(
          red / alpha,
        );
        destination[destinationOffset + 1] = Math.round(
          green / alpha,
        );
        destination[destinationOffset + 2] = Math.round(
          blue / alpha,
        );
        destination[destinationOffset + 3] = Math.round(
          alpha * 255,
        );
      }
    }
  }

  return destination;
}

async function preparePdfIcon() {
  const source = await readFile(pdfIconSource);
  const decoded = UPNG.decode(asArrayBuffer(source));
  const sourcePixels = new Uint8Array(
    UPNG.toRGBA8(decoded)[0],
  );
  const bounds = findRedBounds(
    sourcePixels,
    decoded.width,
    decoded.height,
  );
  const cropped = cropPixels(
    sourcePixels,
    decoded.width,
    bounds,
  );

  makeExteriorTransparent(
    cropped.pixels,
    cropped.width,
    cropped.height,
  );

  const availableSize =
    pdfIconSize - pdfTargetPadding * 2;
  const scale = Math.min(
    availableSize / cropped.width,
    availableSize / cropped.height,
  );
  const innerWidth = Math.round(cropped.width * scale);
  const innerHeight = Math.round(cropped.height * scale);
  const innerPixels = resizePremultiplied(
    cropped.pixels,
    cropped.width,
    cropped.height,
    innerWidth,
    innerHeight,
  );
  const outputPixels = new Uint8Array(
    pdfIconSize * pdfIconSize * 4,
  );
  const offsetX = Math.floor(
    (pdfIconSize - innerWidth) / 2,
  );
  const offsetY = Math.floor(
    (pdfIconSize - innerHeight) / 2,
  );

  for (let y = 0; y < innerHeight; y += 1) {
    const sourceStart = y * innerWidth * 4;
    const destinationStart =
      ((y + offsetY) * pdfIconSize + offsetX) *
      4;
    outputPixels.set(
      innerPixels.subarray(
        sourceStart,
        sourceStart + innerWidth * 4,
      ),
      destinationStart,
    );
  }
  const output = UPNG.encode(
    [outputPixels.buffer],
    pdfIconSize,
    pdfIconSize,
    0,
    [],
    true,
  );

  await writeFile(pdfIconPng, Buffer.from(output));
  console.log(pdfIconPng);
}

await preparePdfIcon();

function recolorRedAsOrange(pixels) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    if (
      red < 90 ||
      red - green < 8 ||
      red - blue < 8
    ) {
      continue;
    }

    const maximum = Math.max(red, green, blue) / 255;
    const minimum = Math.min(red, green, blue) / 255;
    const saturation = maximum === 0
      ? 0
      : (maximum - minimum) / maximum;
    const hue = 28 / 60;
    const chroma = maximum * saturation;
    const intermediate = chroma * (1 - Math.abs((hue % 2) - 1));
    const match = maximum - chroma;

    pixels[offset] = Math.round((chroma + match) * 255);
    pixels[offset + 1] = Math.round((intermediate + match) * 255);
    pixels[offset + 2] = Math.round(match * 255);
  }
}

function fillRectangle(pixels, width, x, y, rectangleWidth, rectangleHeight, color) {
  for (let row = y; row < y + rectangleHeight; row += 1) {
    for (let column = x; column < x + rectangleWidth; column += 1) {
      const offset = (row * width + column) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}

const pptxGlyphs = {
  P: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10000",
    "10000",
    "10000",
  ],
  T: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
  ],
  X: [
    "10001",
    "10001",
    "01010",
    "00100",
    "01010",
    "10001",
    "10001",
  ],
};

function drawPptxLabel(pixels, width) {
  const interior = {
    x: 466,
    y: 401,
    width: 280,
    height: 168,
  };
  fillRectangle(
    pixels,
    width,
    interior.x,
    interior.y,
    interior.width,
    interior.height,
    [254, 254, 253, 255],
  );

  const label = "PPTX";
  const cellWidth = 9;
  const cellHeight = 16;
  const letterGap = 14;
  const letterWidth = cellWidth * 5;
  const textWidth = letterWidth * label.length + letterGap * (label.length - 1);
  const textHeight = cellHeight * 7;
  const startX = interior.x + Math.floor((interior.width - textWidth) / 2);
  const startY = interior.y + Math.floor((interior.height - textHeight) / 2);
  const orange = [221, 101, 18, 255];

  for (let letterIndex = 0; letterIndex < label.length; letterIndex += 1) {
    const glyph = pptxGlyphs[label[letterIndex]];
    const letterX = startX + letterIndex * (letterWidth + letterGap);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== "1") continue;
        fillRectangle(
          pixels,
          width,
          letterX + column * cellWidth,
          startY + row * cellHeight,
          cellWidth,
          cellHeight,
          orange,
        );
      }
    }
  }
}

async function preparePptxIcon() {
  const source = await readFile(pdfIconPng);
  const decoded = UPNG.decode(asArrayBuffer(source));
  const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  recolorRedAsOrange(pixels);
  drawPptxLabel(pixels, decoded.width);
  const output = UPNG.encode(
    [pixels.buffer],
    decoded.width,
    decoded.height,
    0,
    [],
    true,
  );
  await writeFile(pptxIconPng, Buffer.from(output));
  console.log(pptxIconPng);
}

await preparePptxIcon();

const iconDefinitions = [
  {
    source: path.join(projectDirectory, "public", "icon.png"),
    destination: path.join(
      projectDirectory,
      "installer",
      "TenjinReader.ico",
    ),
  },
  {
    source: pdfIconPng,
    destination: path.join(
      projectDirectory,
      "installer",
      "PdfDocument.ico",
    ),
  },
  {
    source: pptxIconPng,
    destination: path.join(
      projectDirectory,
      "installer",
      "PptxDocument.ico",
    ),
  },
];

for (const definition of iconDefinitions) {
  const source = await readFile(definition.source);
  const icon = png2icons.createICO(
    source,
    png2icons.HERMITE,
    0,
    true,
    true,
  );

  if (!icon) {
    throw new Error(
      `No se pudo convertir ${definition.source} a formato ICO.`,
    );
  }

  await writeFile(definition.destination, icon);
  console.log(definition.destination);
}
