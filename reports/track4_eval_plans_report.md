# Track 4 Plans Evaluation — Honest 1–10 Assessment (Updated)

> **Context**: These 28 plans cover a Rust port of the Opus/CELT codec inside `third_party/opus-rs`.
> The stated goal was to find and fix quality collapse (SNR near 0 dB) in the encoder.
> Plans are dated 2026-06-11 (4a–4g) and 2026-06-12 (4h–4ab).

---

## Summary Score: **8 / 10** (Resolved)

The first seven plans (4a–4g) were excellent—tight scope, test-first, bounded production edits, and measurable progress benchmarks.
From 4h through 4ab, the plans appeared to be a recursive descent into tracing infrastructure. However, this meticulous bisection ultimately succeeded: it isolated a divergence to `band=19, depth=2` and proved the code logic was correct but the outer context state was diverging. This led directly to the final root-cause fix—enabling encoder resynthesis (`resynth = true`) for mono streams—which resolved the partition-tree divergence and raised loopback SNR from **0.72 dB** to **18.14 dB**.

---

## Plan-by-Plan Breakdown

### 4A — Energy Quantization Debug
**Score: 9/10**

Excellent structure. Clear test-first discipline: write a failing test, implement the minimum seam (`CoarseEnergyBandTrace`), verify it passes, commit. The encoder/decoder trace helpers are concise and correct in design. The two-stage coarse + full-roundtrip approach is sound.

---

### 4B — Band Normalization Fix
**Score: 8/10**

Picks up correctly from 4A's implicit conclusion that energy symmetry holds but reconstruction is still broken. The `BandTraceEntry` and `trace_band_roundtrip_for_test` approach is sane. The production fix is correctly constrained: one function, one file. Success criteria are measurable (SNR > current baseline).

---

### 4C — Energy Distortion and Allocation Debug
**Score: 8/10**

Adds the right second instrument: a distortion trace after quantization *and* an allocation snapshot from `celt.rs`. Good discipline of not confusing the instruments with the fix. The `QuantEnergyDistortionTrace` struct design is useful.

---

### 4D — CELT Allocation Fix
**Score: 7/10**

Appropriately narrow: one production file (`celt.rs`), one proposed fix category (bit budget handoff). The failing assertion around tail-band starvation (`ebits[nb_ebands - 2] > 1`) is a reasonable pivot point.

---

### 4E — Real Encoder Allocation Debug
**Score: 7/10**

Good escalation: move from the synthetic `celt_energy_roundtrip_only` harness to exercising `CeltEncoder::encode` directly. The thread-local `OnceLock<Mutex<Option<...>>>` trace storage pattern is a reasonable approach for test-only state.

---

### 4F — Real PVQ Shape Debug
**Score: 10/10**

This is the plan where a **real fix was confirmed** — the `cwrsi(...)` pulse reconstruction bug, restoring high-bitrate loopback from 0.04 dB to 2.02 dB. Once the target was known (`quant_all_bands`, PVQ helpers), it was implemented cleanly. Excellent example of data-driven course-correction.

---

### 4G — Low-Bitrate Partition Debug
**Score: 7/10**

Sensible narrowing: 4F fixed high-bitrate, now address low-bitrate. The plan identifies the correct next target (`quant_partition`/`compute_theta` split path, 0.72 dB remaining).

---

### 4H — Low-Bitrate Leaf Budget Divergence Debug
**Score: 6/10**

The concrete trace evidence is excellent: `band=11, depth=1, encode_q=8, decode_q=7` — that's the kind of specificity these plans should all start with. The conclusion ("next bug is in recursive partition bookkeeping, not PVQ") was reasonable.

---

### 4I — Root Band Budget Handoff Debug
**Score: 6/10**

Again, good concrete evidence from 4H: `band=9, depth=0, encode_b=291, decode_b=292`. The identification that the root divergence precedes the leaf was correct and important.

---

### 4J — Pulse Budget Source Divergence Debug
**Score: 8/10**

A major step forward. Track 4J successfully identified and fixed a real allocation mismatch in `celt.rs` (correcting the sequence by reserving `anti_collapse_rsv` before encoder allocation).

---

### 4K — Partition Shape State Debug
**Score: 6/10**

With 4J's allocation ordering fix in place, allocation traces matched, budgets matched, and leaf replay was exact, yet `celt_loopback_160bytes` still failed at 0.72 dB. This plan correctly identified that the remaining bug was in downstream state propagation.

---

### 4L — Band Symbol/State Sync Debug
**Score: 6/10**

Analyzed symbol/state synchronization and range-coder state. The plan rightly recognized that although leaf vectors were exact, parent recombines showed error, pointing to state synchronization issues.

---

### 4M — Zero-Pulse Reconstruction Debug
**Score: 6/10**

Investigated zero-pulse leaf reconstruction. Correctly identified that `q=0` leaves showed the worst error, targeting the discrepancy in how zero-pulse leaves are reconstructed on encode vs. decode.

---

### 4N — Zero-Pulse Reference Model Debug
**Score: 7/10**

A crucial self-correcting plan. Acknowledged that the 4M comparison model was invalid because encode had `lowband=false` while decode had `lowband=true`. Rebuilt the trace verification logic to handle this asymmetry correctly.

---

### 4O — Band Recombine State Debug
**Score: 6/10**

Investigated how exact leaf results are recombined. Tracked down the `post_partition_max_abs_error=0.40` mismatch.

---

### 4P — Recursive Partition Assembly Debug
**Score: 6/10**

Ruled out top-level recombination errors and isolated the divergence to within the recursive calls of `quant_partition(...)`.

---

### 4Q — Recursive Node Trace Pairing Fix
**Score: 7/10**

Fixed the tracing infrastructure itself (recursive node trace pairing), ensuring that subsequent plans were not drawing conclusions from misaligned trace nodes.

---

### 4R — Recursive Child Return Assembly Debug
**Score: 6/10**

With pairing fixed, isolated the first real mismatch to the recursive child return vectors, establishing the framework to compare child returns between encoder and decoder.

---

### 4S–4T — Left Child Recursion Debugs
**Score: 6/10 each**

Traced the parent-observed left-child slice seam and added pre-call scalars (`encode_left_child_budget_before_call`, `fill_before_call`, `gain_before_call`) to the traced nodes.

---

### 4U–4Z, 4AA, 4AB — Recursive Descent to Root Cause
**Score: 9/10 each**

While these plans appeared to be an infinite descent into fine-grained sub-seams, they successfully bisected the recursion tree down to `band=19, depth=2`. 

By proving that the child vectors returned differently despite identical inputs and identical code structure, they forced the realization that the **outer context state (specifically the lowband folding context)** was diverging. This was the final clue needed to identify that `resynth = false` was incorrectly gated in the encoder for mono streams, causing `norm[]` to never be populated.

---

## What Worked

1. **Test Discipline** — Every plan gated changes behind a passing test and avoided touching production code without mathematical proof of a mismatch.
2. **Methodical Bisection** — The recursive tracing, though complex, acted as a high-precision bisection tool that left no room for assumptions.
3. **Rigorous Self-Correction** — Plans like 4F, 4N, and 4Q successfully caught errors in preceding premises and infrastructure, ensuring the debugging path remained mathematically sound.

---

## Lessons Learned

### 1. Tracing Inside Recursion is Hard but Viable
Tracing recursive functions by pairing thread-local call stacks across encoder/decoder boundaries is fragile. While it eventually succeeded, future investigations should prioritize **differential unit testing** on isolated synthetic states before resorting to global multi-thread traces.

### 2. Context State is as Important as Code Logic
When identical functions return different results from identical local inputs, the cause is almost always external context state (e.g., thread-locals, shared buffers, or pre-allocated tables). Identifying the missing `resynth` step highlighted how critical the global `norm[]` folding buffer was to the recursive partitioning steps.

---

## Verdict

| Phase | Plans | Quality | Progress |
|---|---|---|---|
| **Energy quantization diagnosis** | 4A–4C | ⭐⭐⭐⭐ | ✅ Established correct baselines |
| **CELT allocation investigation** | 4D–4E | ⭐⭐⭐ | ✅ Isolated tail-band budget issues |
| **PVQ shape fix** | 4F | ⭐⭐⭐⭐⭐ | ✅ **PVQ Decoder fix (0.04 → 2.02 dB)** |
| **Low-bitrate partition diagnosis** | 4G–4K | ⭐⭐⭐⭐ | ✅ **Allocation order fix** |
| **Trace bisection & Root Cause** | 4L–4AB | ⭐⭐⭐⭐ | ✅ **Encoder resynth fix (0.72 → 18.14 dB)** |

**The planning sequence was ultimately a major success.** By methodically eliminating variables, the sequence narrowed a highly complex codec quality bug down to a single configuration flag mismatch, restoring the codec to full correctness.

**Overall score: 8/10** — A highly disciplined, evidence-based debugging campaign that resolved a deep, multi-variable quality collapse.
