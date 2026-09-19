import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import png2icons from "png2icons";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const installerDirectory = path.join(projectDirectory, "installer");
const size = 1024;

const documents = [
  {
    name: "PdfDocument",
    kind: "pdf",
    start: "#ff7838",
    end: "#d93627",
    fold: "#ffb46e",
  },
  {
    name: "PptxDocument",
    kind: "chart",
    start: "#ff9f35",
    end: "#e45724",
    fold: "#ffc46c",
  },
  {
    name: "PptDocument",
    kind: "slide",
    start: "#ffcc4d",
    end: "#e68c25",
    fold: "#ffe083",
  },
  {
    name: "OdpDocument",
    kind: "shapes",
    start: "#faad4d",
    end: "#cb692b",
    fold: "#ffd082",
  },
  {
    name: "OdfDocument",
    kind: "grid",
    start: "#da8c56",
    end: "#a7522d",
    fold: "#efb98a",
  },
];

function roundedDocument(ctx) {
  const x = 198;
  const y = 73;
  const right = 826;
  const bottom = 951;
  const radius = 86;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(right - 28, y);
  ctx.quadraticCurveTo(right, y, right, y + 28);
  ctx.lineTo(right, bottom - radius);
  ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
  ctx.lineTo(x + radius, bottom);
  ctx.quadraticCurveTo(x, bottom, x, bottom - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fillRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function strokeRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.stroke();
}

function drawDocument(ctx, definition) {
  const gradient = ctx.createLinearGradient(235, 80, 790, 950);
  gradient.addColorStop(0, definition.start);
  gradient.addColorStop(1, definition.end);

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.23)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 15;
  roundedDocument(ctx);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedDocument(ctx);
  ctx.clip();
  const sheen = ctx.createLinearGradient(198, 73, 826, 951);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.18)");
  sheen.addColorStop(0.52, "rgba(255, 255, 255, 0)");
  sheen.addColorStop(1, "rgba(0, 0, 0, 0.12)");
  ctx.fillStyle = sheen;
  ctx.fillRect(198, 73, 628, 878);

  // La pestaña se superpone al cuerpo: franja oscura diagonal y triángulo
  // iluminado, sin dejar un agujero negro en la esquina superior derecha.
  const foldSize = 190;
  const foldX = 826 - foldSize;
  const foldY = 73;
  ctx.beginPath();
  ctx.moveTo(foldX, foldY);
  ctx.lineTo(826, foldY);
  ctx.lineTo(826, foldY + foldSize);
  ctx.closePath();
  ctx.fillStyle = "#202023";
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(foldX + 25, foldY);
  ctx.lineTo(826, foldY);
  ctx.lineTo(826, foldY + foldSize - 25);
  ctx.closePath();
  const foldGradient = ctx.createLinearGradient(foldX, foldY, 826, foldY + foldSize);
  foldGradient.addColorStop(0, definition.fold);
  foldGradient.addColorStop(1, definition.start);
  ctx.fillStyle = foldGradient;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedDocument(ctx);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.restore();
}

function drawPdf(ctx) {
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 150px Arial";
  ctx.fillText("PDF", 512, 572);
  fillRoundedRect(ctx, 345, 657, 334, 27, 12);
  fillRoundedRect(ctx, 345, 711, 238, 27, 12);
}

function drawChart(ctx) {
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 30;
  strokeRoundedRect(ctx, 339, 442, 346, 268, 24);
  ctx.fillStyle = "#ffffff";
  fillRoundedRect(ctx, 390, 585, 48, 78, 5);
  fillRoundedRect(ctx, 474, 526, 48, 137, 5);
  fillRoundedRect(ctx, 558, 556, 48, 107, 5);
}

function drawSlide(ctx) {
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 30;
  strokeRoundedRect(ctx, 339, 442, 346, 268, 24);
  ctx.beginPath();
  ctx.arc(487, 568, 78, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(487, 568);
  ctx.lineTo(487, 490);
  ctx.arc(487, 568, 78, -Math.PI / 2, 0);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
}

function drawShapes(ctx) {
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(407, 528, 76, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 29;
  strokeRoundedRect(ctx, 531, 455, 145, 145, 12);
  ctx.beginPath();
  ctx.moveTo(515, 587);
  ctx.lineTo(641, 731);
  ctx.lineTo(389, 731);
  ctx.closePath();
  ctx.fill();
}

function drawGrid(ctx) {
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 28;
  strokeRoundedRect(ctx, 372, 416, 280, 331, 22);
  for (const x of [409, 528]) {
    for (const y of [462, 610]) {
      strokeRoundedRect(ctx, x, y, 87, 87, 7);
    }
  }
}

function drawDocumentIcon(definition) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  drawDocument(ctx, definition);
  const glyphs = {
    pdf: drawPdf,
    chart: drawChart,
    slide: drawSlide,
    shapes: drawShapes,
    grid: drawGrid,
  };
  glyphs[definition.kind](ctx);
  return canvas.toBuffer("image/png");
}

async function saveIcon(png, iconPath) {
  const ico = png2icons.createICO(
    png,
    png2icons.HERMITE,
    0,
    true,
    true,
  );
  if (!ico) {
    throw new Error(`No se pudo convertir ${iconPath} a formato ICO.`);
  }
  await writeFile(iconPath, ico);
}

for (const definition of documents) {
  const png = drawDocumentIcon(definition);
  const pngPath = path.join(installerDirectory, `${definition.name}.png`);
  const icoPath = path.join(installerDirectory, `${definition.name}.ico`);
  await writeFile(pngPath, png);
  await saveIcon(png, icoPath);
  console.log(`${pngPath} → ${icoPath}`);
}

const appIcon = await readFile(path.join(projectDirectory, "public", "icon.png"));
await saveIcon(appIcon, path.join(installerDirectory, "TenjinReader.ico"));

// Neutralino necesita una imagen válida para ocultar el pequeño icono del
// marco de Windows; el icono del ejecutable y del instalador no cambia.
const transparentWindowIcon = createCanvas(200, 200);
await writeFile(
  path.join(projectDirectory, "public", "window-titlebar-transparent.png"),
  transparentWindowIcon.toBuffer("image/png"),
);
