import json

transcript_path = "/home/jeff/.gemini/antigravity-ide/brain/5987e312-7b1f-46a1-8e45-7a270b0d01ce/.system_generated/logs/transcript.jsonl"
output_path = "/home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/scratch/parsed_diffs.txt"

with open(transcript_path, "r") as f:
    lines = f.readlines()

out_lines = []
for line_idx, line in enumerate(lines):
    try:
        data = json.loads(line)
    except Exception as e:
        continue
    
    for tc in data.get("tool_calls", []):
        if tc.get("name") in ["replace_file_content", "write_to_file", "multi_replace_file_content"]:
            args = tc.get("args", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    pass
            
            target_file = args.get("TargetFile", "")
            if not target_file:
                continue
            
            # Print details
            out_lines.append(f"Line {line_idx+1}: {tc.get('name')} to {target_file}")
            out_lines.append(json.dumps(args, indent=2))
            out_lines.append("=" * 80)

with open(output_path, "w") as f:
    f.write("\n".join(out_lines))
