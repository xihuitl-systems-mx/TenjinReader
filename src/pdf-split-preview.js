import { PDFJS_ASSET_OPTIONS } from "./pdf-source.js";

const THUMBNAIL_WIDTH = 118;
const THUMBNAIL_HEIGHT = 154;
const MAX_PIXEL_RATIO = 1.5;
const MAX_PARALLEL_RENDERS = 2;

function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("El PDF de previsualización debe ser binario.");
}

export function describeSplitGroups(groups, pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new RangeError("El PDF debe tener al menos una página.");
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TypeError("La división debe producir al menos un archivo.");
  }

  const membership = new Map();
  const outputOrder = [];
  let selectedPageCount = 0;
  groups.forEach((group, groupIndex) => {
    if (!Array.isArray(group) || group.length === 0) {
      throw new TypeError(`El archivo ${groupIndex + 1} no contiene páginas.`);
    }
    group.forEach((pageIndex) => {
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
        throw new RangeError(`La página ${pageIndex + 1} está fuera del documento.`);
      }
      if (!membership.has(pageIndex)) membership.set(pageIndex, []);
      membership.get(pageIndex).push(groupIndex);
      outputOrder.push(pageIndex);
      selectedPageCount += 1;
    });
  });

  return {
    fileCount: groups.length,
    membership,
    outputOrder,
    selectedPageCount,
    summary: groups.length === 1
      ? `1 archivo · ${selectedPageCount} página${selectedPageCount === 1 ? "" : "s"}`
      : `${groups.length} archivos · ${selectedPageCount} páginas en total`,
  };
}

function thumbnailScale(viewport) {
  return Math.min(
    THUMBNAIL_WIDTH / viewport.width,
    THUMBNAIL_HEIGHT / viewport.height,
  );
}

export async function createPdfSplitPreview(input, container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError("Se necesita un contenedor para las miniaturas.");
  }
  const bytes = normalizeBytes(input);
  // Keep the planning helpers usable in Node-based tests without eagerly
  // evaluating PDF.js, whose browser build expects DOMMatrix at import time.
  const { getDocument } = await import("pdfjs-dist");
  const loadingTask = getDocument({
    data: bytes.slice(),
    ...PDFJS_ASSET_OPTIONS,
    useSystemFonts: true,
    enableXfa: false,
    isEvalSupported: false,
    stopAtErrors: false,
  });
  const documentProxy = await loadingTask.promise;
  const cards = [];
  const queued = [];
  const queuedPages = new Set();
  const renderTasks = new Set();
  let activeRenders = 0;
  let destroyed = false;

  const renderPage = async (pageNumber) => {
    const card = cards[pageNumber - 1];
    if (!card || card.dataset.rendered === "true" || destroyed) return;
    card.dataset.rendered = "loading";
    let page;
    try {
      page = await documentProxy.getPage(pageNumber);
      if (destroyed) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = thumbnailScale(baseViewport);
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.min(
        MAX_PIXEL_RATIO,
        Math.max(1, globalThis.devicePixelRatio || 1),
      );
      const canvas = card.querySelector("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(viewport.height * pixelRatio));
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      const context = canvas.getContext("2d", { alpha: false });
      const task = page.render({
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1
          ? null
          : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        background: "rgb(255,255,255)",
        intent: "display",
      });
      renderTasks.add(task);
      try {
        await task.promise;
      } finally {
        renderTasks.delete(task);
      }
      if (!destroyed) card.dataset.rendered = "true";
    } catch (error) {
      if (!destroyed && error?.name !== "RenderingCancelledException") {
        card.dataset.rendered = "error";
        options.onError?.(error);
      }
    } finally {
      page?.cleanup?.();
    }
  };

  const drainQueue = () => {
    while (!destroyed && activeRenders < MAX_PARALLEL_RENDERS && queued.length) {
      const pageNumber = queued.shift();
      queuedPages.delete(pageNumber);
      activeRenders += 1;
      void renderPage(pageNumber).finally(() => {
        activeRenders -= 1;
        drainQueue();
      });
    }
  };

  const enqueue = (pageNumber) => {
    if (
      destroyed
      || queuedPages.has(pageNumber)
      || cards[pageNumber - 1]?.dataset.rendered === "true"
      || cards[pageNumber - 1]?.dataset.rendered === "loading"
    ) {
      return;
    }
    queuedPages.add(pageNumber);
    queued.push(pageNumber);
    drainQueue();
  };

  const fragment = document.createDocumentFragment();
  container.replaceChildren();
  for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
    const card = document.createElement("figure");
    const canvasFrame = document.createElement("div");
    const canvas = document.createElement("canvas");
    const caption = document.createElement("figcaption");
    const groupLabel = document.createElement("span");
    card.className = "split-preview-card";
    card.dataset.pageIndex = String(pageNumber - 1);
    card.dataset.rendered = "false";
    card.setAttribute("aria-label", `Página ${pageNumber}`);
    canvasFrame.className = "split-preview-canvas-frame";
    canvas.setAttribute("aria-hidden", "true");
    caption.textContent = `Página ${pageNumber}`;
    groupLabel.className = "split-preview-group-label";
    groupLabel.hidden = true;
    canvasFrame.append(canvas);
    card.append(canvasFrame, caption, groupLabel);
    cards.push(card);
    fragment.append(card);
    if (pageNumber % 200 === 0) {
      container.append(fragment);
      await new Promise((resolve) => {
        if (typeof globalThis.requestAnimationFrame === "function") {
          globalThis.requestAnimationFrame(() => resolve());
        } else {
          globalThis.setTimeout(resolve, 0);
        }
      });
    }
  }
  container.append(fragment);

  let observer = null;
  if ("IntersectionObserver" in globalThis) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          enqueue(Number(entry.target.dataset.pageIndex) + 1);
          observer.unobserve(entry.target);
        }
      }
    }, {
      root: container,
      rootMargin: "180px 0px",
    });
    for (const card of cards) observer.observe(card);
  } else {
    for (let pageNumber = 1; pageNumber <= Math.min(8, cards.length); pageNumber += 1) {
      enqueue(pageNumber);
    }
  }

  return {
    pageCount: documentProxy.numPages,
    setGroups(groups) {
      const description = describeSplitGroups(groups, documentProxy.numPages);
      const orderedCards = [];
      const orderedPageIndexes = new Set();
      for (const pageIndex of description.outputOrder) {
        if (!orderedPageIndexes.has(pageIndex)) {
          orderedPageIndexes.add(pageIndex);
          orderedCards.push(cards[pageIndex]);
        }
      }
      for (let pageIndex = 0; pageIndex < cards.length; pageIndex += 1) {
        if (!orderedPageIndexes.has(pageIndex)) orderedCards.push(cards[pageIndex]);
      }
      container.append(...orderedCards);

      cards.forEach((card, pageIndex) => {
        const groupIndexes = description.membership.get(pageIndex) || [];
        const groupLabel = card.querySelector(".split-preview-group-label");
        card.classList.toggle("is-selected", groupIndexes.length > 0);
        card.classList.toggle("is-excluded", groupIndexes.length === 0);
        if (groupIndexes.length === 0) {
          groupLabel.hidden = true;
          groupLabel.textContent = "";
        } else if (groups.length === 1) {
          groupLabel.hidden = false;
          groupLabel.textContent = `Salida ${groups[0].indexOf(pageIndex) + 1}`;
        } else {
          groupLabel.hidden = false;
          groupLabel.textContent = `Archivo ${groupIndexes[0] + 1}`;
        }
      });
      return description;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      queued.length = 0;
      queuedPages.clear();
      for (const task of renderTasks) task.cancel?.();
      await loadingTask.destroy();
    },
  };
}
