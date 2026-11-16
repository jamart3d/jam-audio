#!/usr/bin/env bash
# Extract quant_partition_encode and quant_partition for diffing
# Encode: lines 2309-2672, Decode: lines 2676-3220
SCRATCH="/home/jeff/.gemini/antigravity-ide/brain/5987e312-7b1f-46a1-8e45-7a270b0d01ce/scratch"
sed -n '2309,2672p' src/bands.rs > "$SCRATCH/encode_fn.rs"
sed -n '2676,3220p' src/bands.rs > "$SCRATCH/decode_fn.rs"

# Strip all trace/record calls, alg_quant/alg_unquant lines, and quant_partition_nX dispatch lines
# to see only the structural logic differences
grep -v \
  -e 'alg_quant\|alg_unquant' \
  -e 'record_partition' \
  -e 'quant_partition_n[0-9]\|quant_partition_direct' \
  -e 'node_visit_index\|record_partition_node' \
  "$SCRATCH/encode_fn.rs" > "$SCRATCH/encode_stripped.rs"

grep -v \
  -e 'alg_quant\|alg_unquant' \
  -e 'record_partition' \
  -e 'quant_partition_n[0-9]\|quant_partition_direct' \
  -e 'node_visit_index\|record_partition_node' \
  "$SCRATCH/decode_fn.rs" > "$SCRATCH/decode_stripped.rs"

echo "=== FULL STRUCTURAL DIFF (encode vs decode, trace/quant calls stripped) ==="
diff "$SCRATCH/encode_stripped.rs" "$SCRATCH/decode_stripped.rs"

echo ""
echo "=== RAW DIFF (first 200 lines, all content) ==="
diff "$SCRATCH/encode_fn.rs" "$SCRATCH/decode_fn.rs" | head -200

