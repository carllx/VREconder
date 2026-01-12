import subprocess
import sys
import shutil

# Check ffmpeg availability
ffmpeg_path = shutil.which('ffmpeg')
if not ffmpeg_path:
    print("Error: ffmpeg not found in PATH")
    sys.exit(1)

print(f"Using ffmpeg: {ffmpeg_path}")

# Flags from hevc_encoder.py we want to test
# input/output paths
input_file = "C:\\Users\\carll\\Documents\\Projects\\VREconder\\benchmark_results\\temp_clips\\sample_0_ref.mp4"
output_file = "C:\\Users\\carll\\Documents\\Projects\\VREconder\\benchmark_results\\temp_clips\\debug_nvenc.mp4"

# Basic flags common to all
base_flags = [
    ffmpeg_path,
    '-stats',
    '-y',
    '-i', input_file,
    '-c:v', 'hevc_nvenc',
    '-c:a', 'aac',
    '-b:a', '128k',
]


def test_flags(name, flags):
    print(f"\n--- Testing Combo: {name} ---")
    cmd = base_flags + flags + [output_file]
    print("Command:", " ".join(cmd))
    
    try:
        result = subprocess.run(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE, 
            text=True
        )
        if result.returncode == 0:
            print("✅ SUCCESS!")
            return True
        else:
            print("❌ FAILURE!")
            # Print last few lines of error
            lines = result.stderr.splitlines()
            for line in lines[-5:]:
                print(f"   {line}")
            return False
    except Exception as e:
        print(f"Exec Error: {e}")
        return False

# Combo 1: Current project new fix (p4 preset, rc vbr, cq)
combo_1 = [
    '-preset', 'p4',
    '-rc', 'vbr',
    '-cq', '25',
    '-b:v', '0',
    '-maxrate', '50M',
    '-bufsize', '100M'
]

# Combo 2: Simplified (remove rc explicit, just cq)
combo_2 = [
    '-preset', 'p4',
    '-rc', 'constqp', # try constqp
    '-qp', '25',
    '-b:v', '0'
]

# Combo 3: Minimal (just preset and cq)
# Note: some nvenc use -cq, others -qp. 
combo_3 = [
    '-preset', 'p4',
    '-cq', '25' 
]

# Combo 4: Standard ffmpeg nvenc CRF-like
combo_4 = [
    '-preset', 'p4',
    '-rc', 'constqp',
    '-qp', '25'
]

# Combo 5: Just preset (CBR default)
combo_5 = [
    '-preset', 'p4',
    '-b:v', '20M'
]

tests = [
    ("Current (VBR+CQ)", combo_1),
    ("ConstQP", combo_2),
    ("Minimal CQ", combo_3),
    ("ConstQP Clean", combo_4),
    ("Simple CBR", combo_5)
]

for name, flags in tests:
    if test_flags(name, flags):
        print(f"\n🎉 Finding: '{name}' works! Please update hevc_encoder.py specific flags.")
        break

