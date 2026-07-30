#pragma once
#include <cstdint>
#include <cstddef>
#include <vector>
#include "nnue_arch.h"

// Loaded + quantized weights for the multilayer full-threats net (kb-mirror.bin).
// Layouts are gomachine-native (bullet export, no transpose) — see spec §1a/§3/§4.
namespace NNUE {

struct Net {
    // Feature transformer, int16, scale ftQA=255. Feature-major: W0i[f*H + i].
    std::vector<int16_t> W0i;   // InputTotal * H
    std::vector<int16_t> B0i;   // H

    // int8 L1 (per-output-row, weight scale L1QB=64). Row (bk*D2+o) = L1W8[(bk*D2+o)*H : +H].
    std::vector<int8_t>  L1W8;  // NB * D2 * H
    std::vector<float>   L1B;   // NB * D2

    // float L2 / output tail — bullet-native input-major layout (no transpose).
    std::vector<float>   L2W;   // D2 * (NB*D3), index L2W[i*(NB*D3) + bk*D3 + o]
    std::vector<float>   L2B;   // NB * D3
    std::vector<float>   OW;    // D3 * NB,       index OW[i*NB + bk]
    std::vector<float>   OB;    // NB

    bool ok = false;
};

extern Net g_net;

// Reads the bullet float32 export at `path`, quantizes into g_net (W0i, B0i, L1W8,
// L1B, L2*, O*), sets g_net.ok. Returns false on any size/format mismatch.
bool load_net(const char* path);

// Loads a pre-quantized "web format" net (nnue_web_format.h) directly from an
// in-memory buffer — no filesystem access, no quantization arithmetic (just
// validated byte copies). This is the WASM/browser entry point (no
// filesystem there); shares its validation + payload-copy logic with the
// file-path pre-quantized loader inside nnue_net.cpp, so the two can never
// silently diverge. Returns false (leaving g_net.ok == false) on any
// size/magic/version/arch/checksum mismatch.
bool load_net_from_memory(const std::uint8_t* data, std::size_t len);

} // namespace NNUE
