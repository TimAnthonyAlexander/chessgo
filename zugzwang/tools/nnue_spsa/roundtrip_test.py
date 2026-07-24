#!/usr/bin/env python3
"""
roundtrip_test.py — the pass/fail gate for nnue_io.py's layout parse+emit.

Test 1 (identity): load net.nnue, write it back UNCHANGED, and require the
output file to be byte-identical (cmp) to the input. This is the proof that
the section offsets/counts in nnue_io.py exactly match the real on-disk
layout — any offset/count bug would show up as drift here (bytes shifting,
sections overlapping, trailer truncated, etc).

Test 2 (single-param perturbation): load net.nnue, add a known delta to
exactly one output-bias entry (out_b[bk=0]), write it out, re-read it, and
assert:
  - every OTHER surface param is bit-identical to the original
  - every non-surface section (l0w, l0b, l1w, l2w) is byte-identical to the
    original (this tool must never touch the FT or the two weight matrices)
  - the trailer is byte-identical
  - the perturbed param changed by exactly `delta` (float32 precision)

Usage:
  python3 roundtrip_test.py <path/to/net.nnue>

Exits 0 and prints "ROUNDTRIP: PASS" / "PERTURB: PASS" on success, exits 1
with a diagnostic on first mismatch found (so a failure here means "the
layout parse is wrong", per the task's report criterion).
"""

import filecmp
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nnue_io  # noqa: E402


def test_identity(src_path: str) -> None:
    net = nnue_io.NNUEFile.load(src_path)

    with tempfile.NamedTemporaryFile(suffix=".nnue", delete=False) as tmp:
        out_path = tmp.name
    try:
        net.save(out_path)

        src_size = os.path.getsize(src_path)
        out_size = os.path.getsize(out_path)
        if src_size != out_size:
            print(f"ROUNDTRIP: FAIL — size mismatch: src={src_size} out={out_size}")
            sys.exit(1)

        identical = filecmp.cmp(src_path, out_path, shallow=False)
        if not identical:
            # Find the first differing byte for diagnostics.
            with open(src_path, "rb") as f1, open(out_path, "rb") as f2:
                a = f1.read()
                b = f2.read()
            first_diff = next((i for i in range(len(a)) if a[i] != b[i]), None)
            print(f"ROUNDTRIP: FAIL — byte mismatch at offset {first_diff}")
            print(f"  src[{first_diff}:{first_diff+8}] = {a[first_diff:first_diff+8]!r}")
            print(f"  out[{first_diff}:{first_diff+8}] = {b[first_diff:first_diff+8]!r}")
            sys.exit(1)

        print(f"ROUNDTRIP: PASS — {out_size} bytes byte-identical to {src_path}")
    finally:
        os.unlink(out_path)


def test_perturb(src_path: str) -> None:
    net = nnue_io.NNUEFile.load(src_path)

    surface_before = net.get_surface_vector()
    names = net.surface_param_names()
    target_idx = names.index("out_b[bk=0]")
    delta_value = 0.125  # arbitrary, exactly representable in float32

    delta_vec = [0.0] * nnue_io.SURFACE_PARAM_COUNT
    delta_vec[target_idx] = delta_value

    perturbed = net.with_surface_delta(delta_vec)

    with tempfile.NamedTemporaryFile(suffix=".nnue", delete=False) as tmp:
        out_path = tmp.name
    try:
        perturbed.save(out_path)

        reread = nnue_io.NNUEFile.load(out_path)
        surface_after = reread.get_surface_vector()

        # 1) exactly one surface param changed, by exactly delta_value.
        n_changed = 0
        for i, (b, a) in enumerate(zip(surface_before, surface_after)):
            if b != a:
                n_changed += 1
                if i != target_idx:
                    print(f"PERTURB: FAIL — unexpected param changed at index {i} ({names[i]})")
                    sys.exit(1)
                got_delta = a - b
                if abs(got_delta - delta_value) > 1e-6:
                    print(f"PERTURB: FAIL — {names[i]} changed by {got_delta}, expected {delta_value}")
                    sys.exit(1)
        if n_changed != 1:
            print(f"PERTURB: FAIL — {n_changed} params changed, expected exactly 1")
            sys.exit(1)

        # 2) every non-surface section is byte-identical to the original.
        for name in ("l0w", "l0b", "l1w", "l2w"):
            orig_bytes = net.sections[name].tobytes()
            new_bytes = reread.sections[name].tobytes()
            if orig_bytes != new_bytes:
                print(f"PERTURB: FAIL — non-surface section '{name}' changed unexpectedly")
                sys.exit(1)

        # 3) trailer unchanged.
        if net.trailer != reread.trailer:
            print("PERTURB: FAIL — trailer changed unexpectedly")
            sys.exit(1)

        print(
            f"PERTURB: PASS — {names[target_idx]} changed by exactly {delta_value}, "
            f"all other {nnue_io.SURFACE_PARAM_COUNT - 1} surface params and all "
            f"non-surface sections + trailer are byte-identical"
        )
    finally:
        os.unlink(out_path)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <net.nnue>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    test_identity(path)
    test_perturb(path)
