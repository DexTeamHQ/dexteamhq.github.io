/* Minimal gzip + tar reader used to unpack the WASI sysroot.
   No dependencies: gzip comes from the platform's DecompressionStream. */
"use strict";

const NOW = () => ({ access: new Date(), modification: new Date(), change: new Date() });

export function hasDecompression() {
  return typeof DecompressionStream === "function";
}

export async function gunzip(bytes) {
  if (!hasDecompression()) throw new Error("this browser has no DecompressionStream (gzip) support");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function cstr(buf, start, len) {
  let end = start + len;
  for (let i = start; i < start + len; i++) { if (buf[i] === 0) { end = i; break; } }
  return new TextDecoder().decode(buf.subarray(start, end));
}

/* USTAR tape -> { "/sys/include/stdio.h": {path, mode, content, timestamps}, ... } */
export function untar(buf) {
  const files = Object.create(null);
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = cstr(buf, off, 100);
    if (!name) break;
    const sizeStr = cstr(buf, off + 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr.replace(/[^0-7]/g, ""), 8) || 0 : 0;
    const type = String.fromCharCode(buf[off + 156]);
    const prefix = cstr(buf, off + 345, 155);
    const full = "/" + (prefix ? prefix + "/" + name : name).replace(/^\.\//, "");
    const start = off + 512;
    if (type === "0" || type === "\0" || type === "" || type === "7") {
      files[full] = { path: full, mode: "binary", content: buf.slice(start, start + size), timestamps: NOW() };
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

export const fileEntry = (path, content) => ({ path, mode: "string", content, timestamps: NOW() });
export const binEntry = (path, content) => ({ path, mode: "binary", content, timestamps: NOW() });
