/* C / C++ in the browser: clang (compiled to WebAssembly by binji, runno's build)
   -> wasm-ld -> the compiled program, all driven by @runno/wasi.
   Nothing here touches the network or a server: the sysroot is a static asset. */
import { WASI } from "./wasi.js";
import { gunzip, untar, fileEntry, binEntry } from "./untar.js";

const NOW = () => ({ access: new Date(), modification: new Date(), change: new Date() });

const C_PRELUDE =
  "#define _POSIX_C_SOURCE 200809L\n" +
  "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <math.h>\n" +
  "#include <limits.h>\n#include <stdbool.h>\n#include <stdint.h>\n#include <ctype.h>\n" +
  "#include <stdarg.h>\n";

const CPP_PRELUDE = [
  "#include <iostream>", "#include <vector>", "#include <string>", "#include <algorithm>",
  "#include <unordered_map>", "#include <unordered_set>", "#include <map>", "#include <set>",
  "#include <queue>", "#include <stack>", "#include <deque>", "#include <numeric>",
  "#include <cmath>", "#include <cstring>", "#include <cstdlib>", "#include <climits>",
  "#include <cstdint>", "#include <functional>", "#include <utility>", "#include <sstream>",
  "#include <iterator>", "#include <bitset>", "#include <tuple>", "#include <array>",
  "#include <list>", "#include <memory>", "#include <cassert>", "#include <limits>",
  "using namespace std;",
].join("\n") + "\n";

export async function runWasm(bytes, { args = [], fs = {}, stdin = "", stdout, stderr } = {}) {
  const enc = new TextEncoder();
  let pushed = false;
  const wasi = new WASI({
    args, env: {}, fs, isTTY: false,
    stdin: () => (pushed ? null : ((pushed = true), stdin)),
    stdout: (s) => { if (stdout) stdout(s); },
    stderr: (s) => { if (stderr) stderr(s); },
  });
  const module = await WebAssembly.compile(bytes);
  const imports = wasi.getImportObject();
  const missing = new Set(WebAssembly.Module.imports(module).filter((i) => i.module === "env").map((i) => i.name));
  if (missing.has("memory")) {
    imports.env = Object.assign({ memory: new WebAssembly.Memory({ initial: 512, maximum: 4096 }) }, imports.env);
  }
  for (const im of WebAssembly.Module.imports(module)) {
    if (!imports[im.module]) imports[im.module] = {};
    if (!(im.name in imports[im.module])) imports[im.module][im.name] = () => 0;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  void enc;
  try {
    const res = wasi.start({ module, instance }, { memory: instance.exports.memory });
    return { exitCode: res.exitCode, fs: res.fs };
  } catch (e) {
    if (e && typeof e.exitCode === "number") return { exitCode: e.exitCode, fs: {} };
    throw e;
  }
}

const CLANG_C = ["clang", "-cc1", "-triple", "wasm32-unknown-wasi", "-isysroot", "/sys",
  "-internal-isystem", "/sys/include", "-internal-isystem", "/sys/lib/clang/8.0.1/include",
  "-ferror-limit", "8", "-fmessage-length", "80", "-O2", "-emit-obj", "-o", "/program.o", "/program.c"];

const CLANG_CPP = ["clang", "-cc1", "-triple", "wasm32-unknown-wasi", "-emit-obj", "-isysroot", "/sys",
  "-internal-isystem", "/sys/include/c++/v1", "-internal-isystem", "/sys/include",
  "-internal-isystem", "/sys/lib/clang/8.0.1/include", "-ferror-limit", "6", "-fmessage-length", "80",
  "-O2", "-o", "/program.o", "-x", "c++", "/program.cpp"];

const LD_C = ["wasm-ld", "--no-threads", "--export-dynamic", "-z", "stack-size=1048576",
  "-L/sys/lib/wasm32-wasi", "/sys/lib/wasm32-wasi/crt1.o", "/program.o", "-lc", "-o", "/program.wasm"];

const LD_CPP = ["wasm-ld", "--no-threads", "--export-dynamic", "-z", "stack-size=1048576",
  "-L/sys/lib/wasm32-wasi", "-L/sys/lib/clang/8.0.1/lib/wasi", "/sys/lib/wasm32-wasi/crt1.o",
  "/program.o", "-lc", "-lc++", "-lc++abi", "-lclang_rt.builtins-wasm32", "-o", "/program.wasm"];

export async function compileAndRun(source, lang, { sysroot, clang, ld, stdin = "", stdout, stderr, onPhase }) {
  const isCpp = lang === "cpp";
  const code = /#include/.test(source) ? source : (isCpp ? CPP_PRELUDE : C_PRELUDE) + source;
  const entry = isCpp ? "/program.cpp" : "/program.c";
  const err = (s) => { if (stderr) stderr(s); };

  if (onPhase) onPhase("compiling");
  const cc = await runWasm(clang, { args: isCpp ? CLANG_CPP : CLANG_C, fs: { ...sysroot, [entry]: fileEntry(entry, code) }, stderr: err });
  if (cc.exitCode !== 0) return { stage: "compile", ok: false, stdout: "", stderr: "" };
  const obj = cc.fs["/program.o"];
  if (!obj) { err("clang produced no object file\n"); return { stage: "compile", ok: false, stdout: "", stderr: "" }; }

  if (onPhase) onPhase("linking");
  const link = await runWasm(ld, {
    args: isCpp ? LD_CPP : LD_C,
    fs: { ...sysroot, "/program.o": binEntry("/program.o", obj.content) },
    stderr: err,
  });
  if (link.exitCode !== 0) return { stage: "compile", ok: false, stdout: "", stderr: "" };
  const bin = link.fs["/program.wasm"];
  if (!bin) { err("wasm-ld produced no executable\n"); return { stage: "compile", ok: false, stdout: "", stderr: "" }; }

  let out = "", errText = "";
  if (onPhase) onPhase("running");
  const run = await runWasm(bin.content, {
    args: ["program"], fs: {}, stdin,
    stdout: (s) => { out += s; if (stdout) stdout(s); },
    stderr: (s) => { errText += s; if (stderr) stderr(s); },
  });
  return { stage: "run", ok: run.exitCode === 0, exitCode: run.exitCode, stdout: out, stderr: errText };
}

export async function loadSysroot(url, onProgress) {
  const gz = await fetchBytes(url, onProgress);
  return untar(await gunzip(gz));
}

export async function fetchBytes(url, onProgress) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error("cannot load " + url + " (" + res.status + ")");
  const total = Number(res.headers.get("content-length") || 0);
  if (!res.body || !onProgress || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export async function fetchWasm(url, onProgress) {
  const gz = await fetchBytes(url, onProgress);
  return gunzip(gz);
}

export { NOW };
