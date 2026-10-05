/* Code Guides — browser engine front end.
   Exposes window.CodeGuidesWasm so pages can run code with no server at all:
   python goes through Pyodide, C and C++ through a WebAssembly clang.
   A runaway program cannot hang the page: the worker is terminated on timeout. */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.CodeGuidesWasm) return;

  var script = document.currentScript;
  var base = script && script.src ? script.src.replace(/[^/]*$/, "") : "assets/run/";
  var SUPPORTED = { python: true, c: true, cpp: true, java: false };
  var RUN_TIMEOUT = 20000;      // once the program is actually running
  var WORK_TIMEOUT = 120000;    // while compiling or downloading

  var worker = null, workerLang = null, seq = 0, jobs = Object.create(null), lastError = "";

  function canUseWorker() {
    return typeof Worker === "function" && typeof WebAssembly === "object";
  }

  function supported(lang) {
    return !!SUPPORTED[lang] && canUseWorker() && typeof DecompressionStream === "function";
  }

  function spawn(lang) {
    kill();
    worker = new Worker(base + "worker.js", { type: "module" });
    workerLang = lang;
    worker.onmessage = function (ev) {
      var m = ev.data || {}, job = jobs[m.id];
      if (!job) return;
      if (m.type === "progress") { if (job.onProgress) job.onProgress(m); arm(job, WORK_TIMEOUT); }
      else if (m.type === "phase") { job.phase = m.phase; arm(job, m.phase === "running" ? RUN_TIMEOUT : WORK_TIMEOUT); }
      else if (m.type === "stdout") { if (job.onStdout) job.onStdout(m.text); }
      else if (m.type === "stderr") { if (job.onStderr) job.onStderr(m.text); }
      else if (m.type === "result") { finish(job, null, m.res); }
      else if (m.type === "error") { finish(job, m.message || "the browser engine failed", null); }
    };
    worker.onerror = function (ev) {
      lastError = (ev && ev.message) || "the browser engine crashed";
      for (var id in jobs) finish(jobs[id], lastError, null);
    };
    return worker;
  }

  function arm(job, ms) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(function () {
      kill();
      finish(job, null, {
        stage: job.phase === "running" ? "run" : "compile",
        ok: false,
        exit_code: 124,
        stdout: "",
        stderr: "[stopped after " + Math.round(ms / 1000) + " s — an endless loop or an endless wait]",
        engine: "browser",
      });
    }, ms);
  }

  function finish(job, error, res) {
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    delete jobs[job.id];
    var cb = job.done;
    job.done = null;
    if (!cb) return;
    if (error) cb({ stage: "engine", ok: false, exit_code: 1, stdout: "", stderr: error, engine: "browser" });
    else { res.engine = "browser"; res.exit_code = res.exit_code === undefined ? (res.exitCode || 0) : res.exit_code; cb(res); }
  }

  function kill() {
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null; workerLang = null;
  }

  /* Stop a run that is still going (an endless loop, a program waiting for input
     that never comes). The worker is destroyed, then every waiting promise is
     answered, so the page always gets its result back and re-enables Run. */
  function stop() {
    var pending = [];
    for (var id in jobs) if (jobs[id]) pending.push(jobs[id]);
    kill();
    for (var i = 0; i < pending.length; i++) {
      var job = pending[i];
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
      delete jobs[job.id];
      var cb = job.done;
      job.done = null;
      if (cb) cb({
        stage: "run", ok: false, exit_code: 130, stdout: "", engine: "browser",
        stderr: "[stopped — you pressed Stop, so the worker was destroyed]",
      });
    }
  }

  function run(opts) {
    var lang = opts.lang;
    if (!supported(lang)) {
      return Promise.resolve({
        stage: "engine", ok: false, exit_code: 1, stdout: "", engine: "browser",
        stderr: lang === "java"
          ? "Java has no offline browser engine yet — run the bundled server (python3 tools/practice_server.py) for javac."
          : "this browser cannot run " + lang + " in the page",
      });
    }
    if (!worker || workerLang !== lang) spawn(lang);
    var id = "j" + (++seq);
    var job = { id: id, phase: "loading", onProgress: opts.onProgress, onStdout: opts.onStdout, onStderr: opts.onStderr, timer: null };
    return new Promise(function (resolve) {
      job.done = function (res) { resolve(res); };
      jobs[id] = job;
      arm(job, WORK_TIMEOUT);
      worker.postMessage({ id: id, lang: lang, code: opts.code, stdin: opts.stdin || "" });
    });
  }

  function warm(lang) {
    if (!supported(lang)) return;
    if (!worker || workerLang !== lang) spawn(lang);
    worker.postMessage({ id: "w" + (++seq), type: "warmup", lang: lang });
  }

  window.CodeGuidesWasm = {
    supported: supported,
    languages: Object.keys(SUPPORTED).filter(supported),
    run: run,
    warm: warm,
    stop: stop,
    reset: stop,
    ready: canUseWorker,
    lastError: function () { return lastError; },
  };
})();
