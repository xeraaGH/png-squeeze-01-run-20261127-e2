# PNG Squeeze v2

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127) [![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/xeraaGH/png-squeeze-01-run-20261127-e2/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127) [![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/xeraaGH/png-squeeze-01-run-20261127-e2/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

A lossless PNG encoder with a zopfli-style optimal-parse DEFLATE compressor. Entry #2 for the [PNG Squeeze bounty](https://make.fun/c/png-squeeze-01-run-20261127) (make.fun, $100 top 50) — improves on entry #1 ("PNG Squeeze v1").

## How it works

- Per-image colour-type reduction (palette / grey / RGB, whichever is smallest)
- Per-row min-sum filter search, including Average (filter 3)
- Optimal-parse (shortest-path, zopfli-style) DEFLATE over the filtered stream

## Results (kit practice set, 8 instances)

- Total **538,257 bytes** vs fixed-paeth baseline 708,151 — **24% smaller**
- Kit score **721,835** vs baseline 420,399 (entry #1 scored 711,688)
- Runtime **23.6 s** for 8 instances (limit 60 s), two runs byte-identical (deterministic)
- Scorer passed 8/8 instances, all "exact" (lossless)

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads the screenshots from `MAKEFUN_INPUT_DIR` and writes the squeezed PNGs to `MAKEFUN_OUTPUT_DIR`. Node 22, no dependencies beyond the standard library.
