# Wave 8 — block-sparse fc_0

Ported SF's `AffineTransformSparseInput` (`~/sf18-arm/src/nnue/layers/`), which scans the
feature-transformer output for non-zero 4-byte chunks and accumulates only those columns,
instead of multiplying all 1024 inputs. **Default OFF** (`-DSFNET_FC0_SPARSE`).

## 1. The measurement that justified attempting it

`test/sfnet_sparsity_probe.cpp` over the 560-position corpus:

```
zero-count per position (of 1024):  min=738  p25=824  median=842  p75=861  max=905
zero-FRACTION:                      mean=0.8220   (min 0.721, max 0.884)
nonzero-CHUNK fraction (ChunkSize=4, SF's find_nnz granularity):  mean=0.4395
projected fc_0 speedup from skipping zero chunks:  2.28x
```

The FT's pairwise step clamps at 0, so **82% of activations are exactly zero** and SF skips
all of them. At chunk granularity `find_nnz` visits 44% of the 256 chunks where a dense
`fc_0` visits 100%. The layer-level win is real and large.

## 2. It does not translate, on arm64

```
sparse OFF (Wave 7)   327,166 nps
sparse ON  (Wave 8)   314,875 nps      -3.8%   (run-to-run noise on this box ~3%)
```

A 2.28x win on `fc_0` moving the engine −3.8% means `fc_0` is not where the time goes.
That is arithmetically unsurprising in hindsight: `fc_0` is 1024→16, i.e. 16K MACs, which
is ~256 vector ops at AVX-512 width. Scanning 256 chunks to find the non-zeros costs the
same order as just doing the multiply. Sparsity pays when the skipped work is large
relative to the bookkeeping, and at 16 outputs it is not.

**amd64 is unmeasured** — coalla was running the `margins2` SPSA and benchmarking would
have perturbed both. It may differ (VNNI's `vpdpbusd` changes the dense side's cost too),
so the flag stays in the tree rather than being deleted.

## 3. Correctness

Bit-exactness was gated **with the flag ON**, which matters — an earlier gate run passed
560/560 against a build where `SFNET_FC0_SPARSE` was undefined and the sparse code was
compiled out entirely, so it proved nothing about this path. With it on:

- `sfnet_eval_test` vs `sfnet_corpus_ref.tsv`: **560/560 bit-exact**
- default (flag off) build: byte-identical binary to Wave 7, as expected

## 4. What this points at instead

`fc_0` runs **once per eval**. The accumulator runs **once per move**, over 2 feature sets
× 2 perspectives × 1024 int16 ≈ 8KB of working set. That is the term that scales with the
tree, and it is where SF's real advantage lives — see `find_last_usable_accumulator` /
`forward_update_incremental` (`nnue_accumulator.cpp:165-198`): SF marks accumulator states
dirty on `do_move` and only materializes them when an eval is actually required, walking
back to the nearest computed ancestor and rolling forward. Our `SFNet::AccStack` updates
**eagerly on every `do_move`** — no `computed` flag, no deferral.

Our own net has had exactly this (`LAZYACC`/`LAZYACC2`, deferred-apply, default-on) since
July, worth +7.2% NPS / +17.8 Elo when it shipped. The SF backend never got it. That is
the next lever and it is a much better bet than this one was.
