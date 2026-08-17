#!/usr/bin/env python3
"""Reference parser + validator for Stockfish 18 .nnue files (big threats net / small net).

Proves the file-format spec in docs/tasks/open/sf-net-experiment.md §3 against the real
bytes. Every hash is RECOMPUTED from SF's own rules, never read from the file and then
compared to itself. No Stockfish code is used or vendored; only the format is reproduced.

Stdlib only, so it runs anywhere (coalla included).

Usage: python3 sfnet_validate.py <path-to-net.nnue> [--small] [--full]
       --small  parse a HalfKAv2_hm-only net (no threats, 128-wide)
       --full   also LEB128-decode the 23M-entry weights array (slow, ~1 min)
"""

import sys
import time

# ---------------------------------------------------------------- hash rules
VERSION = 0x7AF32F20  # nnue_common.h:58
THREATS_HASH = 0x8F234CB8  # features/full_threats.h:41
HALFKA_HASH = 0x7F234CB8  # features/half_ka_v2_hm.h:70
M32 = 0xFFFFFFFF


def ft_hash(feature_set_hash, half_dims):
    """nnue_feature_transformer.h:126-130"""
    return (feature_set_hash ^ (half_dims * 2)) & M32


def affine_hash(prev, out_dims):
    """layers/affine_transform.h:145-151 (bit-identical in the sparse variant)"""
    h = (0xCC03DAE4 + out_dims) & M32
    h ^= prev >> 1
    h ^= (prev << 31) & M32
    return h & M32


def relu_hash(prev):
    """layers/clipped_relu.h:49-52 == sqr_clipped_relu.h:49-52 (same constant)"""
    return (0x538D24C7 + prev) & M32


def arch_hash(half_dims, l2, l3):
    """nnue_architecture.h:74-86 — ac_sqr_0 is deliberately NOT in this chain."""
    h = (0xEC42E90D ^ (half_dims * 2)) & M32
    h = affine_hash(h, l2 + 1)  # fc_0
    h = relu_hash(h)  # ac_0
    h = affine_hash(h, l3)  # fc_1
    h = relu_hash(h)  # ac_1
    h = affine_hash(h, 1)  # fc_2
    return h


def ceil_to_multiple(n, base):
    return (n + base - 1) // base * base


# ---------------------------------------------------------------- LEB128
LEB_MAGIC = b"COMPRESSED_LEB128"  # 17 bytes, no NUL: sizeof(literal) - 1

# High bit clear => this byte terminates a value. Counting them counts the values
# without decoding any of them.
_TERM = bytes(1 if b < 0x80 else 0 for b in range(256))


def count_leb128(buf):
    return buf.translate(_TERM).count(1)


def decode_leb128(buf):
    """Inverse of nnue_common.h:176-207, including the `shift % 32` and the
    sign-extension rule `(shift >= 32 || !(byte & 0x40)) ? result : result | ~mask`."""
    out = []
    push = out.append
    result = 0
    shift = 0
    for byte in buf:
        result |= (byte & 0x7F) << (shift % 32)
        shift += 7
        if not (byte & 0x80):
            if shift < 32 and (byte & 0x40):
                result |= (M32 << shift) & M32
            push(result - 0x100000000 if result & 0x80000000 else result)
            result = 0
            shift = 0
    return out


class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def raw(self, n):
        assert self.p + n <= len(self.d), f"ran off the end at {self.p} wanting {n}"
        v = self.d[self.p : self.p + n]
        self.p += n
        return v

    def u32(self):
        return int.from_bytes(self.raw(4), "little")

    def i8_range(self, count):
        seen = set(self.raw(count))
        vals = [x - 256 if x > 127 else x for x in seen]
        return min(vals), max(vals)

    def skip_le(self, itemsize, count):
        self.raw(itemsize * count)

    def leb128(self, *counts, decode=True):
        """One read_leb_128 call, filling several arrays back to back from ONE
        bitstream with no re-framing between them."""
        magic = self.raw(len(LEB_MAGIC))
        assert magic == LEB_MAGIC, f"bad LEB magic {magic!r} at {self.p}"
        nbytes = self.u32()
        payload = self.raw(nbytes)
        total = sum(counts)
        got = count_leb128(payload)
        assert got == total, f"LEB frame: {got:,} values in {nbytes:,} B, want {total:,}"
        if not decode:
            return None, nbytes
        vals = decode_leb128(payload)
        out, off = [], 0
        for c in counts:
            out.append(vals[off : off + c])
            off += c
        return out, nbytes


def check(label, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'}{label:<34} {got:#010x}"
          + ("" if ok else f"   expected {want:#010x}"))
    return ok


def rng(v):
    return f"range [{min(v)}, {max(v)}]" if v else ""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    small = "--small" in sys.argv
    full = "--full" in sys.argv
    path = args[0]

    half_dims = 128 if small else 1024
    use_threats = not small
    l2, l3, stacks, psqt_buckets = 15, 32, 8, 8
    psq_dims = 22528  # SQUARE_NB * PS_NB / 2 == 64 * (11*64) / 2
    threat_dims = 79856

    data = open(path, "rb").read()
    print(f"{path}\n  {len(data):,} bytes on disk"
          f"   ({'HalfKAv2_hm only' if small else 'HalfKAv2_hm + FullThreats'}, "
          f"HalfDimensions={half_dims})\n")

    fth = ft_hash(THREATS_HASH if use_threats else HALFKA_HASH, half_dims)
    ah = arch_hash(half_dims, l2, l3)
    top = (fth ^ ah) & M32

    print("recomputed from SF's hash rules (nothing read from the file yet):")
    print(f"      feature-transformer hash           {fth:#010x}")
    print(f"      layer-stack (arch) hash            {ah:#010x}")
    print(f"      top-level network hash             {top:#010x}\n")

    r = Reader(data)
    ok = True
    t0 = time.time()

    print("header (96 B):")
    ok &= check("version", r.u32(), VERSION)
    ok &= check("hash", r.u32(), top)
    desc_len = r.u32()
    desc = r.raw(desc_len).decode("utf-8", "replace")
    print(f"  ok  descLen                           {desc_len}")
    print(f"      description                       {desc!r}")

    print("\nfeature transformer:")
    ok &= check("sub-header hash", r.u32(), fth)
    ft_start = r.p

    (biases,), n = r.leb128(half_dims)
    print(f"  ok  biases                    i16 x {half_dims:<10,} LEB128 {n:>12,} B   {rng(biases)}")

    if use_threats:
        lo, hi = r.i8_range(threat_dims * half_dims)
        print(f"  ok  threatWeights              i8 x {threat_dims * half_dims:<10,} raw    "
              f"{threat_dims * half_dims:>12,} B   range [{lo}, {hi}]")

        res, n = r.leb128(psq_dims * half_dims, decode=full)
        print(f"  ok  weights                   i16 x {psq_dims * half_dims:<10,} LEB128 {n:>12,} B"
              f"   {rng(res[0]) if full else '(count-verified; --full to decode)'}")

        (tpsqt, psqt), n = r.leb128(threat_dims * psqt_buckets, psq_dims * psqt_buckets)
        print(f"  ok  threatPsqt then psqt      i32 x {len(tpsqt) + len(psqt):<10,} LEB128 "
              f"{n:>12,} B   ONE call, ONE blob")
        print(f"        threatPsqtWeights            {len(tpsqt):>10,}   {rng(tpsqt)}")
        print(f"        psqtWeights                  {len(psqt):>10,}   {rng(psqt)}")
    else:
        res, n = r.leb128(psq_dims * half_dims, decode=full)
        print(f"  ok  weights                   i16 x {psq_dims * half_dims:<10,} LEB128 {n:>12,} B"
              f"   (x2 on read: scale_weights)")
        (psqt,), n = r.leb128(psq_dims * psqt_buckets)
        print(f"  ok  psqtWeights               i32 x {len(psqt):<10,} LEB128 {n:>12,} B   {rng(psqt)}")

    print(f"      feature-transformer block        {r.p - ft_start:,} B")

    print(f"\n{stacks} layer stacks (raw little-endian, never LEB128):")
    layers = [("fc_0", half_dims, l2 + 1), ("fc_1", l2 * 2, l3), ("fc_2", l3, 1)]
    per_stack = None
    for s in range(stacks):
        start = r.p
        h = r.u32()
        if h != ah:
            ok = False
            print(f"  FAIL stack {s} hash {h:#010x} expected {ah:#010x}")
        for name, ind, outd in layers:
            padded = ceil_to_multiple(ind, 32)
            r.skip_le(4, outd)  # biases  i32
            r.skip_le(1, outd * padded)  # weights i8, row-major over PADDED input
        size = r.p - start
        if per_stack is None:
            per_stack = size
            for name, ind, outd in layers:
                padded = ceil_to_multiple(ind, 32)
                print(f"  ok  {name:<5} in {ind:>4} -> out {outd:<3} padded in {padded:<5}"
                      f" {outd:>3} x i32 bias + {outd * padded:>8,} x i8 weight")
            print(f"      per stack                        {size:,} B")
        assert size == per_stack, "layer stacks are not all the same size"

    print(f"      all {stacks} stacks                      {per_stack * stacks:,} B")

    rem = len(data) - r.p
    print(f"\nconsumed {r.p:,} of {len(data):,} bytes; remainder {rem}   [{time.time()-t0:.1f}s]")
    ok &= rem == 0
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
