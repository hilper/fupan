const enginePath = "vendor/tesseract-7.0.0";
const reviewPasses = [
  ["full", 0, 1, ""],
  ["left", 0, 0.33, "0123456789-"],
  ["mid", 0.33, 0.6, "0123456789.,-+"],
  ["right", 0.6, 1, "0123456789.,-+"],
];

let scriptPromise;
let workerPromise;
let queue = Promise.resolve();

function pageUrl(path) {
  return new URL(path, window.location.href).href;
}

function loadScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = pageUrl(`${enginePath}/tesseract.min.js`);
    script.onload = () => {
      if (window.Tesseract?.createWorker) resolve();
      else reject(new Error("識別程式未能初始化"));
    };
    script.onerror = () => reject(new Error("無法載入識別程式檔案"));
    document.head.append(script);
  });
  return scriptPromise;
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    onProgress?.("載入識別程式（第一次約 5 MB）…");
    workerPromise = loadScript().then(() => new Promise((resolve, reject) => {
      window.Tesseract.createWorker("chi_sim", 1, {
        workerPath: pageUrl(`${enginePath}/worker.min.js`),
        corePath: pageUrl("vendor/tesseract-core-7.0.0"),
        langPath: pageUrl("vendor/tessdata-chi_sim-1.0.0"),
        gzip: true,
        errorHandler: reject,
      }).then(resolve, reject);
    }));
  }
  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null;
    throw new Error("載入識別程式失敗，請重新整理頁面後再試", { cause: error });
  }
}

function prepareCanvas(canvas, image, start, end, scale) {
  const x = Math.floor(image.naturalWidth * start);
  const width = Math.floor(image.naturalWidth * end) - x;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, x, 0, width, image.naturalHeight, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = pixels.data;
  for (let index = 0; index < rgba.length; index += 4) {
    const grey = 0.299 * rgba[index] + 0.587 * rgba[index + 1] + 0.114 * rgba[index + 2];
    rgba[index] = rgba[index + 1] = rgba[index + 2] = grey < 200 ? 0 : 255;
  }
  context.putImageData(pixels, 0, 0);
}

async function recognizeFile(file, passes, onProgress) {
  const worker = await getWorker(onProgress);
  const url = URL.createObjectURL(file);
  const canvas = document.createElement("canvas");
  try {
    const image = new Image();
    let timeout;
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("圖片無法開啟"));
        timeout = setTimeout(() => reject(new Error("讀取圖片逾時")), 20_000);
        image.src = url;
      });
    } finally {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
    }

    try {
      const scale = Math.min(2, Math.sqrt(16e6 / (image.naturalWidth * image.naturalHeight)));
      const result = {};
      for (const [index, [column, start, end, whitelist]] of passes.entries()) {
        onProgress?.(`識別中 ${index + 1}/${passes.length}…`);
        prepareCanvas(canvas, image, start, end, scale);
        await worker.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: whitelist });
        const { data } = await worker.recognize(canvas, {}, { blocks: true });
        result[column] = (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap(
          (paragraph) => paragraph.lines.map(({ text, bbox }) => ({
            text: text.trim(), y0: bbox.y0 / scale, y1: bbox.y1 / scale,
          })),
        ));
      }
      return result;
    } catch (error) {
      throw new Error("截圖識別失敗，請確認圖片可開啟後再試", { cause: error });
    }
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}

export async function recognizeColumns(file, passes, { onProgress } = {}) {
  // 每張圖共用同一個 worker，完成後才能設定下一張的白名單。
  const result = queue.then(() => recognizeFile(file, passes, onProgress));
  queue = result.catch(() => {});
  return result;
}

export function recognizeReview(file, options) {
  return recognizeColumns(file, reviewPasses, options);
}
