/* Code Guides — in-browser runner worker.
   One language per worker:  python -> Pyodide,  c / cpp -> clang + wasm-ld + WASI.
   The worker is disposable: the page terminates it to kill a runaway program,
   which is also how the run timeout is enforced. */
import { compileAndRun, loadSysroot, fetchWasm } from "./cc.js";

const BASE = new URL("./", import.meta.url).href;

let pyodide = null;
const cc = { sysroot: null, clang: null, ld: null };

const post = (msg) => self.postMessage(msg);
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

function progress(id, label, loaded, total) {
  post({ id, type: "progress", label, loaded, total,
         text: total ? label + " " + mb(loaded) + " / " + mb(total) : label });
}

async function ensureC(id) {
  const jobs = [];
  if (!cc.sysroot) jobs.push(loadSysroot(BASE + "clang/clang-fs.tar.gz", null)
    .then((fs) => { cc.sysroot = fs; }));
  if (!cc.clang) jobs.push(fetchWasm(BASE + "clang/clang.wasm.gz", (a, b) => progress(id, "clang", a, b))
    .then((w) => { cc.clang = w; }));
  if (!cc.ld) jobs.push(fetchWasm(BASE + "clang/wasm-ld.wasm.gz", (a, b) => progress(id, "linker", a, b))
    .then((w) => { cc.ld = w; }));
  if (jobs.length) progress(id, "loading the C/C++ compiler", 0, 0);
  await Promise.all(jobs);
  return cc;
}

/* Turn the text in the page's stdin box into something Pyodide can read.
   Pyodide asks for one line at a time and takes null as end-of-input; with
   autoEOF it also reports EOF after the last line, so input(), sys.stdin.read(),
   readline() and `for line in sys.stdin` all behave like a real terminal.
   Without this, sys.stdin is an error stream and every read raises OSError 29. */
function lineReader(text) {
  const parts = String(text || "").split("\n");
  if (parts.length === 1 && parts[0] === "") return () => null;   // no input at all
  let i = 0;
  return () => (i < parts.length ? parts[i++] + "\n" : null);
}

function bindStdin(py, stdin, sink, id) {
  if (typeof py.setStdin !== "function") return;
  try {
    py.setStdin({ stdin: lineReader(stdin), autoEOF: true, isatty: false });
  } catch (e) {
    const msg = "stdin could not be attached: " + String((e && e.message) || e) + "\n";
    sink.err += msg;
    post({ id: id, type: "stderr", text: msg });
  }
}

async function ensurePy(id, sink) {
  if (pyodide) return pyodide;
  progress(id, "loading python (WebAssembly)", 0, 0);
  const { loadPyodide } = await import("./pyodide/pyodide.js");
  pyodide = await loadPyodide({
    indexURL: BASE + "pyodide/",
    stdout: (text) => { sink.out += text + "\n"; post({ id, type: "stdout", text: text + "\n" }); },
    stderr: (text) => { sink.err += text + "\n"; post({ id, type: "stderr", text: text + "\n" }); },
  });
  return pyodide;
}

async function runJob(id, lang, code, stdin) {
  const sink = { out: "", err: "", capped: false };
  const MAX_OUTPUT = 64000;   // a program that prints forever must not grow the page without end
  // type is what the page listens for ("stdout"/"stderr"); key is where we accumulate
  const emit = (type, key) => (text) => {
    if (key === "err" && /^\d+ warnings? generated\.$/.test(text.trim())) return;
    if (sink[key].length >= MAX_OUTPUT) {
      if (!sink.capped) {
        sink.capped = true;
        const note = "\n\u2026[output truncated after " + MAX_OUTPUT.toLocaleString("en-US") + " characters]\n";
        sink[key] += note;
        post({ id: id, type: type, text: note });
      }
      return;
    }
    sink[key] += text;
    post({ id, type: type, text: text });
  };

  if (lang === "python") {
    const py = await ensurePy(id, sink);
    // pyodide only honours the handlers passed to loadPyodide for the first run,
    // so re-bind them every time
    const out = emit("stdout", "out"), err = emit("stderr", "err");
    py.setStdout({ batched: (text) => out(text + "\n") });
    py.setStderr({ batched: (text) => err(text + "\n") });
    bindStdin(py, stdin, sink, id);
    post({ id, type: "phase", phase: "running" });
    try {
      await py.runPythonAsync(code);
      return { stage: "run", ok: true, exitCode: 0, stdout: sink.out, stderr: sink.err };
    } catch (e) {
      // a Python exception is the *program* failing, not the engine: report it as
      // a normal failed run so the panel does not blame the WebAssembly engine.
      const tb = sink.err && sink.err.trim() ? sink.err : String((e && e.message) || e);
      return { stage: "run", ok: false, exitCode: 1, stdout: sink.out, stderr: /\n$/.test(tb) ? tb : tb + "\n" };
    }
  }

  if (lang === "c" || lang === "cpp") {
    const kit = await ensureC(id);
    progress(id, "compiling", 0, 0);
    const res = await compileAndRun(code, lang, {
      sysroot: kit.sysroot, clang: kit.clang, ld: kit.ld, stdin: stdin || "",
      stdout: emit("stdout", "out"), stderr: emit("stderr", "err"),
      onPhase: (phase) => post({ id, type: "phase", phase }),
    });
    // compileAndRun streams compiler output through stderr; keep it for the panel
    return {
      stage: res.stage, ok: res.ok, exitCode: res.exitCode === undefined ? (res.ok ? 0 : 1) : res.exitCode,
      stdout: sink.out, stderr: sink.err || res.stderr || "",
    };
  }

  throw new Error("this browser engine cannot run " + lang + " yet");
}

self.onmessage = async (ev) => {
  const data = ev.data || {};
  const id = data.id;
  if (data.type === "warmup") {
    try { await (data.lang === "python" ? ensurePy(id, { out: "", err: "" }) : ensureC(id)); }
    catch (e) { post({ id, type: "error", message: String((e && e.message) || e) }); }
    return;
  }
  try {
    const res = await runJob(id, data.lang, data.code, data.stdin);
    post({ id, type: "result", res });
  } catch (e) {
    post({ id, type: "error", message: String((e && e.message) || e) });
  }
};
