#!/usr/bin/env python3
"""
Comparative Benchmark Tool: NVENC vs Libx265
============================================
A rigorous benchmarking tool to compare compression efficiency and performance.
"""

import os
import sys
import time
import json
import csv
import argparse
import subprocess
import threading
import psutil
import shutil
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple, NamedTuple

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("Benchmark")

class BenchmarkResult(NamedTuple):
    encoder: str
    preset: str
    mode: str
    target: str  # "5M" or "CRF 23"
    time_sec: float
    size_mb: float
    bitrate_mbps: float
    fps: float
    cpu_usage_avg: float
    vmaf: float
    ssim: float
    psnr: float

class ComparativeBenchmark:
    def __init__(self, input_file: Path, output_dir: Path, force_cpu: bool = False):
        self.input_file = input_file
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir = self.output_dir / "temp_work"
        self.temp_dir.mkdir(exist_ok=True)
        self.force_cpu = force_cpu
        
        self.source_clip = self.temp_dir / "benchmark_source.mp4"
        self.results: List[BenchmarkResult] = []
        self.has_nvenc = False
        self.has_vmaf = False
        
        self.cpu_monitor_active = False
        self.cpu_readings = []

    def check_deps(self):
        """Check availability of FFmpeg, NVENC, and LibVMAF."""
        print("🔍 Checking dependencies...")
        
        # Check FFmpeg
        try:
            subprocess.run(['ffmpeg', '-version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        except (subprocess.CalledProcessError, FileNotFoundError):
            logger.error("❌ FFmpeg not found!")
            sys.exit(1)

        # Check NVENC
        if not self.force_cpu:
            try:
                res = subprocess.run(['ffmpeg', '-encoders'], capture_output=True, text=True)
                if "hevc_nvenc" in res.stdout:
                    self.has_nvenc = True
                    print("✅ NVENC available")
                else:
                    print("⚠️ NVENC not found, will run CPU only.")
            except Exception:
                pass
        
        # Check VMAF
        try:
            # Simple check if libvmaf filter exists
            res = subprocess.run(['ffmpeg', '-filters'], capture_output=True, text=True)
            if "libvmaf" in res.stdout:
                self.has_vmaf = True
                print("✅ VMAF filter available")
            else:
                print("⚠️ VMAF filter NOT found. Will fallback to SSIM only.")
        except Exception:
            pass

    def prepare_source_clip(self):
        """Create a consolidated source clip from 3 segments of the input video."""
        print(f"✂️  Preparing 3-clip sample from {self.input_file.name}...")
        
        # Get duration
        cmd = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(self.input_file)]
        try:
            duration = float(subprocess.check_output(cmd).decode().strip())
        except:
            logger.error("Could not determine video duration.")
            sys.exit(1)

        # Timestamps: 20%, 50%, 80%
        timestamps = [duration * 0.2, duration * 0.5, duration * 0.8]
        clip_paths = []
        
        # Extract individual clips (lossless-ish intermediate)
        for i, ts in enumerate(timestamps):
            clip_path = self.temp_dir / f"clip_{i}.mp4"
            # Extract 3 seconds
            cmd = [
                'ffmpeg', '-y', '-ss', str(ts), '-i', str(self.input_file),
                '-t', '3', '-c:v', 'libx264', '-crf', '16', '-preset', 'ultrafast',
                '-c:a', 'copy', str(clip_path)
            ]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            clip_paths.append(clip_path)

        # Concatenate using file list
        list_file = self.temp_dir / "clips.txt"
        with open(list_file, 'w') as f:
            for p in clip_paths:
                f.write(f"file '{p.name}'\n")
        
        cmd = [
            'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(list_file),
            '-c', 'copy', str(self.source_clip)
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print(f"✅ Created benchmark source: {self.source_clip} (~9s)")

    def _monitor_cpu(self):
        self.cpu_readings = []
        p = psutil.Process()
        while self.cpu_monitor_active:
            # Record system-wide CPU for simplicity, or process specific if needed.
            # Usually encoding affects whole system responsiveness, so system-wide is good metric for "Cost".
            self.cpu_readings.append(psutil.cpu_percent(interval=0.5))

    def measure_quality(self, encoded_file: Path) -> Tuple[float, float, float]:
        """Calculate VMAF, SSIM, PSNR."""
        # Need to scale encoded file to match source if resolutions differ? 
        # For this benchmark we assume same resolution.
        
        # Build complex filter
        # [0:v][1:v]libvmaf,ssim,psnr currently awkward to chain all in one output easily without valid model path issues for VMAF
        # Let's run individual or grounded checks.
        
        vmaf_score = 0.0
        ssim_score = 0.0
        psnr_score = 0.0

        # Run SSIM & PSNR (Fast)
        cmd_metrics = [
            'ffmpeg', '-i', str(encoded_file), '-i', str(self.source_clip),
            '-lavfi', 'ssim;[0:v][1:v]psnr', 
            '-f', 'null', '-'
        ]
        
        try:
            res = subprocess.run(cmd_metrics, capture_output=True, text=True)
            output = res.stderr
            
            # Parse SSIM
            # [Parsed_ssim_0 @ ...] SSIM Y:0.98... All:0.98...
            import re
            ssim_match = re.search(r"SSIM.*?All:([0-9\.]+)", output)
            if ssim_match:
                ssim_score = float(ssim_match.group(1))
            
            # Parse PSNR
            # [Parsed_psnr_1 @ ...] PSNR y:30... average:30...
            psnr_match = re.search(r"PSNR.*?average:([0-9\.]+)", output)
            if psnr_match:
                psnr_score = float(psnr_match.group(1))
                
        except Exception as e:
            logger.error(f"Metrics calculation failed: {e}")

        # Run VMAF (Slow) if enabled
        if self.has_vmaf:
            # We assume default model is available to ffmpeg
            cmd_vmaf = [
                'ffmpeg', '-i', str(encoded_file), '-i', str(self.source_clip),
                '-lavfi', 'libvmaf', '-f', 'null', '-'
            ]
            try:
                res = subprocess.run(cmd_vmaf, capture_output=True, text=True)
                # Output: [libvmaf @ ...] VMAF score: 95.123
                vmaf_match = re.search(r"VMAF score:\s*([0-9\.]+)", res.stderr)
                if vmaf_match:
                    vmaf_score = float(vmaf_match.group(1))
            except Exception as e:
                logger.error(f"VMAF calculation failed: {e}")

        return vmaf_score, ssim_score, psnr_score

    def run_encoding(self, mode_name: str, target_desc: str, cmd_base: List[str], encoder_name: str, output_file: Path):
        """Run single encoding task."""
        print(f"   Now running: {encoder_name} | {mode_name} | {target_desc} ...", end="", flush=True)
        
        # Start CPU Monitor
        self.cpu_monitor_active = True
        monitor_thread = threading.Thread(target=self._monitor_cpu)
        monitor_thread.start()
        
        start_time = time.time()
        
        try:
            # Run ffmpeg
            res = subprocess.run(cmd_base + [str(output_file)], capture_output=True, text=True)
            if res.returncode != 0:
                print(" ❌ Failed")
                logger.error(res.stderr)
                return
        finally:
            self.cpu_monitor_active = False
            monitor_thread.join()

        end_time = time.time()
        duration = end_time - start_time
        
        # Parse FPS
        fps = 0.0
        # frame=  234 fps= 45 ...
        import re
        fps_match = re.findall(r"fps=\s*([0-9\.]+)", res.stderr)
        if fps_match:
            fps = float(fps_match[-1])
        
        # Metrics
        size_mb = output_file.stat().st_size / (1024 * 1024)
        bitrate_mbps = (size_mb * 8) / 9.0 # approx 9s duration
        
        cpu_avg = sum(self.cpu_readings) / len(self.cpu_readings) if self.cpu_readings else 0
        
        print(" Analyzing...", end="", flush=True)
        vmaf, ssim, psnr = self.measure_quality(output_file)
        
        print(f" Done! (VMAF: {vmaf:.1f}, Size: {size_mb:.2f}MB, Time: {duration:.2f}s)")
        
        self.results.append(BenchmarkResult(
            encoder=encoder_name,
            preset="default", # Simplified
            mode=mode_name,
            target=target_desc,
            time_sec=duration,
            size_mb=size_mb,
            bitrate_mbps=bitrate_mbps,
            fps=fps,
            cpu_usage_avg=cpu_avg,
            vmaf=vmaf,
            ssim=ssim,
            psnr=psnr
        ))

    def run_benchmarks(self):
        modes_a_bitrate = [5, 15, 30] # Mbps
        modes_b_quality = [28, 23, 18] # CRF/CQ (Lower is better)

        # --- Mode A: Fixed Bitrate ---
        print("\n🚗 Running Mode A: Fixed Bitrate (Efficiency Mode)")
        for b in modes_a_bitrate:
            target = f"{b}M"
            
            # x265
            out_x265 = self.temp_dir / f"x265_rate_{b}M.mp4"
            cmd_x265 = [
                'ffmpeg', '-y', '-i', str(self.source_clip),
                '-c:v', 'libx265', 
                '-x265-params', f'vbv-maxrate={b*1000}:vbv-bufsize={b*2000}:pass=1',
                '-b:v', target,
                '-c:a', 'copy'
            ]
            self.run_encoding("FixedBitrate", target, cmd_x265, "libx265", out_x265)
            
            # NVENC
            if self.has_nvenc:
                out_nvenc = self.temp_dir / f"nvenc_rate_{b}M.mp4"
                cmd_nvenc = [
                    'ffmpeg', '-y', '-i', str(self.source_clip),
                    '-c:v', 'hevc_nvenc',
                    '-preset', 'p7', # SLOWEST/BEST
                    '-rc', 'vbr_hq',
                    '-b:v', target,
                    '-maxrate', f"{int(b*1.2)}M",
                    '-bufsize', f"{int(b*2)}M",
                    '-c:a', 'copy'
                ]
                self.run_encoding("FixedBitrate", target, cmd_nvenc, "nvenc_p7", out_nvenc)

        # --- Mode B: Quality Match ---
        print("\n💎 Running Mode B: Quality Match (File Size Mode)")
        for q in modes_b_quality:
            
            # x265 (CRF)
            out_x265 = self.temp_dir / f"x265_crf_{q}.mp4"
            cmd_x265 = [
                'ffmpeg', '-y', '-i', str(self.source_clip),
                '-c:v', 'libx265',
                '-crf', str(q),
                '-c:a', 'copy'
            ]
            self.run_encoding("FixedQuality", f"CRF {q}", cmd_x265, "libx265", out_x265)
            
            # NVENC (CQ)
            if self.has_nvenc:
                out_nvenc = self.temp_dir / f"nvenc_cq_{q}.mp4"
                cmd_nvenc = [
                    'ffmpeg', '-y', '-i', str(self.source_clip),
                    '-c:v', 'hevc_nvenc',
                    '-preset', 'p7',
                    '-rc', 'vbr',
                    '-cq', str(q),
                    '-b:v', '0', # Important for CQ mode
                    '-c:a', 'copy'
                ]
                self.run_encoding("FixedQuality", f"CQ {q}", cmd_nvenc, "nvenc_p7", out_nvenc)

    def generate_report(self):
        report_file = self.output_dir / "benchmark_report.md"
        csv_file = self.output_dir / "benchmark_data.csv"
        
        # Write CSV
        with open(csv_file, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(BenchmarkResult._fields)
            for r in self.results:
                writer.writerow(r)
        
        # Write Markdown
        with open(report_file, 'w', encoding='utf-8') as f:
            f.write("# NVENC vs Libx265 Comparative Benchmark\n\n")
            
            f.write("## 1. Efficiency Score (Mode A: Fixed Bitrate)\n")
            f.write("Lower bitrate with higher VMAF = Better Efficiency.\n\n")
            f.write("| Target | Encoder | VMAF | Mbps | Eff. Score (VMAF/Mbps) | CPU% | FPS |\n")
            f.write("|--------|---------|------|------|------------------------|------|-----|\n")
            
            for r in self.results:
                if r.mode == "FixedBitrate":
                    eff_score = r.vmaf / r.bitrate_mbps if r.bitrate_mbps > 0 else 0
                    f.write(f"| {r.target} | {r.encoder} | **{r.vmaf:.2f}** | {r.bitrate_mbps:.2f} | {eff_score:.2f} | {r.cpu_usage_avg:.1f}% | {r.fps:.1f} |\n")
            
            f.write("\n## 2. File Size Efficiency (Mode B: Quality Match)\n")
            f.write("Similar perceptual quality target (CRF vs CQ).\n\n")
            f.write("| Target | Encoder | VMAF | Size (MB) | Time (s) | CPU% |\n")
            f.write("|--------|---------|------|-----------|----------|------|\n")
            
            for r in self.results:
                if r.mode == "FixedQuality":
                    f.write(f"| {r.target} | {r.encoder} | {r.vmaf:.2f} | **{r.size_mb:.2f}** | {r.time_sec:.2f} | {r.cpu_usage_avg:.1f}% |\n")
            
            f.write("\n> **Note**: NVENC uses `p7` (Slowest) preset. VMAF scores are calculated against the source clip.\n")

        print(f"\n📄 Report generated: {report_file}")
        print(f"📄 Data saved: {csv_file}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, help="Input video file")
    parser.add_argument("--output", default=Path("benchmark_results_v2"), type=Path)
    parser.add_argument("--check-deps", action="store_true")
    parser.add_argument("--force-cpu", action="store_true")
    args = parser.parse_args()
    
    bench = ComparativeBenchmark(args.input, args.output, args.force_cpu)
    bench.check_deps()
    
    if args.check_deps:
        return

    if not args.input or not args.input.exists():
        print("❌ Error: Input file required for benchmarking.")
        return
        
    bench.prepare_source_clip()
    bench.run_benchmarks()
    bench.generate_report()

if __name__ == "__main__":
    main()
