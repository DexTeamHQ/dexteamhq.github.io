# In-browser engines — what is in this folder and where it came from

The practice page can compile and run code **with no server at all**: everything
below is downloaded once, cached by the browser, and executed inside a Web Worker
on the visitor's own machine. Nothing typed into the editor is sent anywhere.

| Language | Engine | Version | First-run download |
|---|---|---|---|
| Python | Pyodide (CPython compiled to WebAssembly) | 314.0.7 | ≈ 6 MB (13.4 MB uncompressed) |
| C | clang → wasm-ld → WASI (runno's WASM build of clang 8.0.1) | clang 8.0.1 | ≈ 19 MB |
| C++ | same, plus libc++ / libc++abi / compiler-rt builtins | clang 8.0.1 | ≈ 19 MB (shared with C) |
| Java | *not available offline* — needs `python3 tools/practice_server.py` | — | — |

## Files

```
engine.js        main-thread front end: window.CodeGuidesWasm.run({lang, code, stdin,…})
worker.js        the worker: keeps the engines warm, streams output back
cc.js            untar + gunzip + clang/wasm-ld/WASI pipeline
untar.js         minimal gzip/tar reader for the WASI sysroot
wasi.js          @runno/wasi, bundled (MIT)
pyodide/         Pyodide distribution (MPL-2.0)
clang/           clang.wasm.gz · wasm-ld.wasm.gz · clang-fs.tar.gz
```

## Credits and licences

- **Pyodide** — https://pyodide.org — Mozilla Public License 2.0.
  Files: `pyodide/pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`,
  `python_stdlib.zip`, `pyodide-lock.json`.
- **clang / wasm-ld / WASI sysroot** — Ben Smith's `wasm-clang`
  (https://github.com/binji/wasm-clang), distributed by Runno
  (https://github.com/taybenlor/runno) as `@runno/sandbox` language binaries.
  LLVM/Apache-2.0 with LLVM exceptions; wasi-libc is Apache-2.0 with LLVM exception.
- **@runno/wasi** — https://github.com/taybenlor/runno — MIT,
  Copyright (c) Benjamin Taylor.
- Loaders, preludes and this integration: part of the code-guides project.

## Notes for maintainers

- The C/C++ preludes live in `cc.js` (`C_PRELUDE`, `CPP_PRELUDE`); they mirror
  `C_PRELUDE` / `CPP_PRELUDE` in `tools/practice_server.py` so a solution behaves
  the same in the browser and on the local runner. The C++ prelude lists standard
  headers instead of `<bits/stdc++.h>`, which libc++ does not ship.
- `clang-fs.tar.gz` is already gzipped; the two `.wasm.gz` files are gzipped by
  `gzip -9` at build time and inflated in the browser with `DecompressionStream`.
  Re-shipping them uncompressed would triple the download.
- Timeouts: 20 s once the program is running, 120 s while compiling or downloading
  (`engine.js`). A timeout terminates the worker, which is what makes an endless
  loop survivable.
- Java could be added with CheerpJ (free for personal projects) but that loads from
  Leaning Technologies' CDN, which would break the offline promise, so it is not
  wired in yet.
