#!/usr/bin/env python3
"""
nnue_io.py — standalone reader/writer for zugzwang's bullet-float32 .nnue export
(net.nnue -> gomachine/data/nnue/kb-mirror.bin, ~180MB, H=512 D2=16 D3=32 NB=8).

FILE LAYOUT (verified against src/nnue_net.cpp, byte-exact, NO HEADER):

  The file is a flat, little-endian float32 concatenation of 8 sections, in
  this exact order, followed by a fixed 32-byte "bullet" ASCII marker trailer.
  There is no magic number and no version field — the loader (nnue_net.cpp
  load_net()) reads the whole file and slices it by cumulative float offset.

    section  dtype(on disk)  count                  on-disk bytes         in-memory (after load_net)
    -------  --------------  ---------------------  --------------------  ---------------------------------
    l0w      float32         InputTotal*H            = 92144*512           quantized -> int16 W0i  (x255, no clamp)
                              = 47,177,728             = 188,710,912 B      feature-major W0i[f*H+i]
    l0b      float32         H = 512                  = 2,048 B            quantized -> int16 B0i  (x255, no clamp)
    l1w      float32         H*(NB*D2)                 = 262,144 B          quantized -> int8  L1W8 (x64, clamp +-127)
                              = 65,536                                      input-major on disk; gathered to
                                                                             per-output-row [(bk*D2+o)*H+i] in memory
    l1b      float32         NB*D2 = 128               = 512 B              straight copy -> float L1B (bucket-major)
    l2w      float32         D2*(NB*D3)                = 16,384 B           straight copy -> float L2W
                              = 4,096                                       input-major L2W[i*(NB*D3)+bk*D3+o]
    l2b      float32         NB*D3 = 256               = 1,024 B            straight copy -> float L2B
    l3w      float32         D3*NB = 256               = 1,024 B            straight copy -> float OW (output wt)
                                                                             input-major OW[i*NB+bk]
    l3b      float32         NB = 8                    = 32 B               straight copy -> float OB (output bias)
    -------------------------------------------------------------------------------------------------------
    TOTAL floats: 47,248,520   TOTAL data bytes: 188,994,080
    + 32-byte trailer: ASCII "bullet" repeated (bullet-crate export marker,
      not part of any array — verified present past `want` in load_net(),
      tolerated via `fsize >= want*4` not `==`).
    = 188,994,112 bytes total file size (matches kb-mirror.bin exactly).

  CRITICAL: only l1b, l2w, l2b, l3w, l3b are used by the engine as plain
  floats (straight copy, no requantization) — see load_net()'s comments
  "straight copy". l0w/l0b are FT weights, requantized to int16 on load
  (scale ftQA=255, NO clamp). l1w is requantized to int8 on load (scale
  L1QB=64, clamped to +-127) AND transposed from input-major to per-output-row.
  Because l0w/l0b/l1w on disk are plain float32 that get *reinterpreted* at
  load time, editing them in the .nnue file changes what the engine's
  quantizer produces — but this tool does not touch them (see OUTPUT SURFACE
  below); they are round-tripped byte-identical.

OUTPUT SURFACE (the SPSA-tunable "output side", ~SFNNv9's 648 params):

  This tool exposes exactly 4 of the 8 sections as one flat parameter vector,
  in this fixed order — deliberately EXCLUDING l0w/l0b (the huge FT) and l1w/
  l2w (the two weight *matrices* feeding the tail, too many params + no direct
  per-param interpretability for a first cut). All 4 exposed arrays are plain
  float32 on disk with NO requantization on load, so perturbing them needs no
  dequant/requant round-trip — just read the float, add a delta, write it back.

    name        source array   count           note
    ----        ------------   -----           ----
    l1_bias     l1b -> L1B     NB*D2  = 128     task's "L2-layer biases" (D2 output width, per NB bucket)
    l2_bias     l2b -> L2B     NB*D3  = 256     task's "L3-layer biases" (D3 output width, per NB bucket)
    out_weight  l3w -> OW      D3*NB  = 256     task's "output weights"
    out_bias    l3b -> OB      NB     = 8       task's "output biases"
    ------------------------------------------------------------------
    TOTAL SURFACE PARAMS: 128 + 256 + 256 + 8 = 648
"""

from __future__ import annotations

import array
import sys
from dataclasses import dataclass, replace
from pathlib import Path

# ---- Architecture constants (must track src/nnue_arch.h exactly) ----------
INPUT_DIM = 768
NUM_KING_BUCKETS = 16
PSQ_SIZE = NUM_KING_BUCKETS * INPUT_DIM  # 12288
THREAT_BLOCK = 79856
INPUT_TOTAL = PSQ_SIZE + THREAT_BLOCK  # 92144

H = 512   # FT hidden width per perspective
D2 = 16   # tail L1 width
D3 = 32   # tail L2 width
NB = 8    # output buckets

# ---- Section float counts (mirrors nnue_net.cpp load_net() exactly) -------
N_L0W = INPUT_TOTAL * H          # 47,177,728  FT weights
N_L0B = H                        # 512         FT bias
N_L1W = H * (NB * D2)            # 65,536      L1 weights (input-major)
N_L1B = NB * D2                  # 128         L1 bias
N_L2W = D2 * (NB * D3)           # 4,096       L2 weights (input-major)
N_L2B = NB * D3                  # 256         L2 bias
N_L3W = D3 * NB                  # 256         output weights (input-major)
N_L3B = NB                       # 8           output bias

_SECTION_COUNTS = [N_L0W, N_L0B, N_L1W, N_L1B, N_L2W, N_L2B, N_L3W, N_L3B]
_SECTION_NAMES = ["l0w", "l0b", "l1w", "l1b", "l2w", "l2b", "l3w", "l3b"]

WANT_FLOATS = sum(_SECTION_COUNTS)   # 47,248,520
WANT_BYTES = WANT_FLOATS * 4         # 188,994,080

# Cumulative float offsets, one per section, in file order.
_OFFSETS = []
_running = 0
for _n in _SECTION_COUNTS:
    _OFFSETS.append(_running)
    _running += _n

BULLET_TRAILER_LEN = 32  # ASCII "bullet" repeated; present in kb-mirror.bin

# The 4 arrays that make up the tunable output surface, in a fixed, stable
# order. (section_name, float_count) — matches load_net()'s section names.
SURFACE_SECTIONS = [
    ("l1b", N_L1B),  # -> L1B  (task: "L2-layer biases")
    ("l2b", N_L2B),  # -> L2B  (task: "L3-layer biases")
    ("l3w", N_L3W),  # -> OW   (task: "output weights")
    ("l3b", N_L3B),  # -> OB   (task: "output biases")
]
SURFACE_PARAM_COUNT = sum(n for _, n in SURFACE_SECTIONS)  # 648


def _assert_little_endian() -> None:
    if sys.byteorder != "little":
        raise RuntimeError(
            "nnue_io requires a little-endian host (matches the engine's "
            "le_f32 reader); this host is big-endian."
        )


@dataclass(frozen=True)
class NNUEFile:
    """Immutable in-memory view of a .nnue file.

    `sections` maps section name -> array.array('f', ...) (native float32,
    exact bit-for-bit reinterpretation of the on-disk bytes on a
    little-endian host). `trailer` is the raw bytes after the 8 sections
    (verified to be the 32-byte "bullet" marker in kb-mirror.bin, but stored
    verbatim and NOT assumed to be any particular length/content beyond
    "whatever followed WANT_BYTES in the source file").
    """

    sections: dict
    trailer: bytes
    source_path: str

    @staticmethod
    def load(path: str) -> "NNUEFile":
        _assert_little_endian()
        data = Path(path).read_bytes()
        if len(data) < WANT_BYTES:
            raise ValueError(
                f"{path}: file is {len(data)} bytes, need >= {WANT_BYTES} "
                f"({WANT_FLOATS} floats) for H={H} D2={D2} D3={D3} NB={NB}"
            )

        sections = {}
        for name, count, foff in zip(_SECTION_NAMES, _SECTION_COUNTS, _OFFSETS):
            boff = foff * 4
            blen = count * 4
            a = array.array("f")
            a.frombytes(data[boff : boff + blen])
            sections[name] = a

        trailer = bytes(data[WANT_BYTES:])
        return NNUEFile(sections=sections, trailer=trailer, source_path=path)

    def to_bytes(self) -> bytes:
        """Serialize back to the exact on-disk layout (sections in file
        order + trailer verbatim)."""
        out = bytearray()
        for name in _SECTION_NAMES:
            out += self.sections[name].tobytes()
        out += self.trailer
        return bytes(out)

    def save(self, path: str) -> None:
        Path(path).write_bytes(self.to_bytes())

    # -- Output-surface accessors -------------------------------------------

    def get_surface_vector(self) -> list:
        """Flat list of the 648 output-surface floats, in fixed section
        order (l1b, l2b, l3w, l3b) matching SURFACE_SECTIONS."""
        vec = []
        for name, count in SURFACE_SECTIONS:
            arr = self.sections[name]
            assert len(arr) == count
            vec.extend(arr)
        return vec

    def with_surface_vector(self, vec) -> "NNUEFile":
        """Return a NEW NNUEFile (immutable-style update) with the output
        surface replaced by `vec` (must have exactly SURFACE_PARAM_COUNT
        entries, same fixed order as get_surface_vector()). All other
        sections + trailer are copied unchanged."""
        if len(vec) != SURFACE_PARAM_COUNT:
            raise ValueError(
                f"expected {SURFACE_PARAM_COUNT} surface params, got {len(vec)}"
            )

        new_sections = dict(self.sections)  # shallow copy of the mapping
        idx = 0
        for name, count in SURFACE_SECTIONS:
            chunk = vec[idx : idx + count]
            idx += count
            new_sections[name] = array.array("f", (float(x) for x in chunk))

        return replace(self, sections=new_sections)

    def with_surface_delta(self, delta) -> "NNUEFile":
        """Return a NEW NNUEFile with `delta` (SURFACE_PARAM_COUNT floats)
        added elementwise to the current output surface."""
        base = self.get_surface_vector()
        if len(delta) != len(base):
            raise ValueError(
                f"delta has {len(delta)} entries, surface has {len(base)}"
            )
        new_vec = [b + d for b, d in zip(base, delta)]
        return self.with_surface_vector(new_vec)

    def surface_param_names(self) -> list:
        """Human-readable name for every entry in the surface vector, same
        order as get_surface_vector(), for logging/debugging SPSA runs."""
        names = []
        for name, count in SURFACE_SECTIONS:
            if name == "l1b":
                for bk in range(NB):
                    for o in range(D2):
                        names.append(f"l1b[bk={bk},o={o}]")
            elif name == "l2b":
                for bk in range(NB):
                    for o in range(D3):
                        names.append(f"l2b[bk={bk},o={o}]")
            elif name == "l3w":
                for i in range(D3):
                    for bk in range(NB):
                        names.append(f"out_w[i={i},bk={bk}]")
            elif name == "l3b":
                for bk in range(NB):
                    names.append(f"out_b[bk={bk}]")
        assert len(names) == SURFACE_PARAM_COUNT
        return names


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <net.nnue>", file=sys.stderr)
        sys.exit(2)
    net = NNUEFile.load(sys.argv[1])
    print(f"loaded {sys.argv[1]}")
    print(f"  total floats: {WANT_FLOATS}  total bytes: {WANT_BYTES}  trailer: {len(net.trailer)} bytes")
    for name, count in zip(_SECTION_NAMES, _SECTION_COUNTS):
        print(f"  {name}: {count} floats ({count*4} bytes)")
    print(f"  output surface: {SURFACE_PARAM_COUNT} params "
          f"({', '.join(f'{n}={c}' for n, c in SURFACE_SECTIONS)})")
