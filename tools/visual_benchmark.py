#!/usr/bin/env python3
"""
Visual Benchmark to Compare VR Encoding Presets
===============================================
Compares 'Original', 'Low', 'High', 'Ultra' presets using actual project logic.
Focuses on off-center ROI (Left Eye) to avoid VR black zones.
"""

import sys
import os
import time
import argparse
import random
import json
import subprocess
import shutil
from pathlib import Path
from typing import List, Dict, Optional, Tuple

# Enable importing from src
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "src"))

# PIL for image processing
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("❌ Pillow (PIL) is required. Please run: pip install Pillow")
    sys.exit(1)

# Project imports
from src.config.settings import Config
from src.encoders.hevc_encoder import HEVCEncoder, EncoderType, QualityPreset

def get_font(size=24):
    """Get a usable font."""
    try:
        # Try a few common fonts
        fonts = ["arial.ttf", "segoeui.ttf", "DejaVuSans.ttf", "FreeSans.ttf"]
        for font_name in fonts:
            try:
                return ImageFont.truetype(font_name, size)
            except IOError:
                continue
        return ImageFont.load_default()
    except Exception:
        return ImageFont.load_default()

class PrintLogger:
    def format_and_write(self, line):
        # Only print errors or warnings to avoid spam
        if "Error" in line or "error" in line or "Warning" in line:
            print(f"FFMPEG: {line.strip()}")

class VisualBenchmark:
    def __init__(self, input_file: Path, output_dir: Path, samples: int = 3, roi_pos: float = 0.25):
        self.input_file = input_file
        self.output_dir = output_dir
        self.samples = samples
        self.roi_pos = roi_pos  # 0.25 = center of left half (approx)
        
        self.config = Config()
        self.encoder = HEVCEncoder(self.config)
        
        # Ensure output dir exists
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir = self.output_dir / "temp_clips"
        self.temp_dir.mkdir(exist_ok=True)

    def probe_video(self) -> Dict:
        """Get video duration and resolution."""
        cmd = [
            'ffprobe', 
            '-v', 'error', 
            '-select_streams', 'v:0', 
            '-show_entries', 'stream=width,height,duration', 
            '-of', 'json', 
            str(self.input_file)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        data = json.loads(result.stdout)
        stream = data['streams'][0]
        return {
            'width': int(stream['width']),
            'height': int(stream['height']),
            'duration': float(stream.get('duration', 0))
        }

    def generate_random_timestamps(self, duration: float, clip_len: float = 5.0) -> List[float]:
        """Generate random start timestamps."""
        possible_start = 0
        possible_end = max(0, duration - clip_len)
        return sorted([random.uniform(possible_start, possible_end) for _ in range(self.samples)])

    def extract_clip_raw(self, start_time: float, output_path: Path, duration: float = 5.0):
        """Extract a raw clip using hybrid seek for frame accuracy."""
        # Hybrid seeking:
        # 1. Fast seek to nearby keyframe (start_time - 10s)
        # 2. Slow seek to exact timestamp
        
        seek_buffer = 15.0
        if start_time > seek_buffer:
            fast_seek = start_time - seek_buffer
            slow_seek = seek_buffer
        else:
            fast_seek = 0.0
            slow_seek = start_time

        cmd = [
            'ffmpeg', '-y',
            '-ss', str(fast_seek),
            '-i', str(self.input_file),
            '-ss', str(slow_seek),
            '-t', str(duration),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', # Near lossless
            '-c:a', 'copy',
            str(output_path)
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

    def extract_frame_at_timestamp(self, video_path: Path, timestamp: float) -> Image.Image:
        """Extract a frame from the VIDEO at a specific timestamp."""
        frame_path = self.temp_dir / f"frame_{timestamp:.2f}.jpg"
        cmd = [
            'ffmpeg', '-y',
            '-ss', str(timestamp),
            '-i', str(video_path),
            '-frames:v', '1',
            '-q:v', '2',
            str(frame_path)
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return Image.open(frame_path)

    def extract_frame(self, video_path: Path, time_offset: float = 2.5) -> Image.Image:
        """Extract a frame from the CLIP at a specific offset."""
        frame_path = self.temp_dir / f"{video_path.stem}_frame.jpg"
        cmd = [
            'ffmpeg', '-y',
            '-ss', str(time_offset),
            '-i', str(video_path),
            '-frames:v', '1',
            '-q:v', '2',
            str(frame_path)
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return Image.open(frame_path)

    def save_roi_preview(self, image: Image.Image, meta: Dict, sample_idx: int):
        """Save a full-size image with ROI box drawn for validation."""
        width = meta['width']
        height = meta['height']
        
        # Calculate ROI box
        crop_size = 512
        cx = int(width * self.roi_pos)
        cy = int(height * 0.5)
        
        left = max(0, cx - crop_size // 2)
        top = max(0, cy - crop_size // 2)
        right = min(width, left + crop_size)
        bottom = min(height, top + crop_size)
        
        # Adjust if off-edge
        if right - left < crop_size: left = right - crop_size
        if bottom - top < crop_size: top = bottom - crop_size
        
        preview = image.copy()
        draw = ImageDraw.Draw(preview)
        
        # Draw Red Box
        draw.rectangle([left, top, right, bottom], outline=(255, 0, 0), width=10)
        draw.text((left, top - 60), "ROI AREA", fill=(255, 0, 0), font=get_font(48))
        
        preview_path = self.output_dir / f"roi_preview_sample_{sample_idx+1}.jpg"
        preview.save(preview_path)
        print(f"🖼️ Saved ROI Preview: {preview_path} (Please check this matches your valid visual area!)")

    def create_comparison_image(self, 
                              images: Dict[str, Image.Image], 
                              times: Dict[str, float], 
                              sample_idx: int,
                              resolution: Tuple[int, int]):
        """Stitch images side-by-side with labels."""
        width, height = resolution
        
        # Crop size: 512x512
        crop_size = 512
        
        # Calculate crop box centered at ROI
        # ROI is self.roi_pos (0.25) of width, 0.5 of height
        cx = int(width * self.roi_pos)
        cy = int(height * 0.5)
        
        left = max(0, cx - crop_size // 2)
        top = max(0, cy - crop_size // 2)
        right = min(width, left + crop_size)
        bottom = min(height, top + crop_size)
        
        # Adjust if off-edge
        if right - left < crop_size: left = right - crop_size
        if bottom - top < crop_size: top = bottom - crop_size
        
        crop_box = (left, top, right, bottom)
        
        # Presets order
        presets = ['Original', 'Low', 'High', 'Ultra']
        
        # Calculate canvas size
        # 4 images wide, some padding
        padding = 20
        canvas_width = (crop_size * 4) + (padding * 5)
        canvas_height = crop_size + 100 # Space for header/footer
        
        canvas = Image.new('RGB', (canvas_width, canvas_height), (30, 30, 30))
        draw = ImageDraw.Draw(canvas)
        font_title = get_font(36)
        font_label = get_font(24)
        
        # Draw Title
        draw.text((padding, 20), f"Sample #{sample_idx+1} - ROI Focus: Left Eye Center", fill=(200, 200, 200), font=font_title)
        
        for idx, preset_name in enumerate(presets):
            img = images.get(preset_name)
            if not img:
                continue
            
            # Crop
            crop = img.crop(crop_box)
            
            # Position
            x = padding + (idx * (crop_size + padding))
            y = 80
            
            # Paste
            canvas.paste(crop, (x, y))
            
            # Label
            time_val = times.get(preset_name, 0)
            
            label_color = (255, 255, 255)
            if preset_name == 'Original':
                label_text = f"{preset_name}\n(Reference)"
                label_color = (100, 200, 255)
            else:
                label_text = f"{preset_name}\nTime: {time_val:.2f}s"
                
            draw.text((x, y + crop_size + 10), label_text, fill=label_color, font=font_label)
            
            # Draw border
            draw.rectangle([x-2, y-2, x+crop_size+2, y+crop_size+2], outline=label_color, width=2)
            
        output_path = self.output_dir / f"benchmark_sample_{sample_idx+1}.jpg"
        canvas.save(output_path, quality=95)
        print(f"✅ Saved comparison image: {output_path}")



    def run(self):
        # Setup logging
        import logging
        logging.basicConfig(level=logging.INFO)
        
        print(f"🚀 Starting Visual Benchmark on {self.input_file.name}")
        
        # Probe
        meta = self.probe_video()
        print(f"   Resolution: {meta['width']}x{meta['height']}, Duration: {meta['duration']:.2f}s")
        
        timestamps = self.generate_random_timestamps(meta['duration'])
        
        # Quality mapping
        quality_map = {
            'Low': QualityPreset.FAST,
            'High': QualityPreset.SLOW,
            'Ultra': QualityPreset.VERY_SLOW
        }

        # Select encoder dynamically
        encoder_type = self.encoder.get_optimal_encoder()
            
        print(f"   Using Encoder: {encoder_type.value}")
        print(f"   Samples: {self.samples}")
        print("-" * 60)

        logger = PrintLogger()

        # Statistics Collection
        all_times = {
            'Low': [],
            'High': [],
            'Ultra': []
        }

        for i, ts in enumerate(timestamps):
            print(f"\nProcessing Sample {i+1}/{self.samples} at timestamp {ts:.2f}s")
            
            sample_images = {}
            sample_times = {}
            
            # 1. Original (Reference) - Extract directly from source for best quality
            print("   Extracting Original Reference...", end="", flush=True)
            ref_path = self.temp_dir / f"sample_{i}_ref.mp4"
            # We still need the clip for encoding source, but image comes from source
            self.extract_clip_raw(ts, ref_path)
            
            # Key Change: Extract frame from SOURCE video (pixel perfect)
            # Offset = ts + 2.5 (middle of clip)
            sample_images['Original'] = self.extract_frame_at_timestamp(self.input_file, ts + 2.5)
            sample_times['Original'] = 0
            print(" Done.")
            
            # Generate ROI Preview for the first sample
            if i == 0:
                self.save_roi_preview(sample_images['Original'], meta, i)

            # 2. Transcode Presets
            for q_name, q_preset in quality_map.items():
                print(f"   Encoding {q_name}...", end="", flush=True)
                
                # Output path
                out_path = self.temp_dir / f"sample_{i}_{q_name}.mp4"
                
                # Encode
                start_t = time.time()
                
                # Debug: Print command
                try:
                    debug_cmd = self.encoder._build_ffmpeg_command(
                         ref_path, out_path, encoder_type, q_preset, self.encoder.calculate_crf("4k", "medium"), resolution="4k"
                    )
                except:
                    pass

                success = self.encoder.encode_video(
                    input_file=ref_path,
                    output_file=out_path,
                    encoder_type=encoder_type,
                    quality_preset=q_preset,
                    crf=None, # auto
                    resolution="4k",
                    progress_logger=logger
                )
                
                # Fallback to LIBX265 if failed
                if not success and encoder_type != EncoderType.LIBX265:
                    print("   [NVENC Failed, Retrying with LIBX265]...", end="", flush=True)
                    success = self.encoder.encode_video(
                        input_file=ref_path,
                        output_file=out_path,
                        encoder_type=EncoderType.LIBX265,
                        quality_preset=q_preset,
                        crf=None,
                        resolution="4k",
                        progress_logger=logger
                    )

                end_t = time.time()
                
                if success:
                    duration = end_t - start_t
                    print(f" Done ({duration:.2f}s)")
                    sample_times[q_name] = duration
                    sample_images[q_name] = self.extract_frame(out_path)
                    all_times[q_name].append(duration)
                else:
                    print(" Failed!")
            
            # 3. Create Composite
            self.create_comparison_image(
                sample_images, 
                sample_times, 
                i, 
                (meta['width'], meta['height'])
            )

        # Cleanup
        try:
            shutil.rmtree(self.temp_dir)
        except:
            pass
            
        print("\n" + "="*60)
        print("📊 STATISTICAL REPORT")
        print("="*60)
        print(f"{'Preset':<10} | {'Avg Time':<10} | {'Min Time':<10} | {'Max Time':<10} | {'Samples':<8}")
        print("-" * 60)
        
        for preset in ['Low', 'High', 'Ultra']:
            times = all_times[preset]
            if times:
                avg_t = sum(times) / len(times)
                min_t = min(times)
                max_t = max(times)
                count = len(times)
                print(f"{preset:<10} | {avg_t:<9.2f}s | {min_t:<9.2f}s | {max_t:<9.2f}s | {count:<8}")
            else:
                print(f"{preset:<10} | {'N/A':<10} | {'N/A':<10} | {'N/A':<10} | 0")
        print("="*60)
        print("\n✨ Benchmark Complete.")

def main():
    parser = argparse.ArgumentParser(description="Visual Benchmark for VR Encoding")
    parser.add_argument('--input-file', type=Path, required=True, help='Input video file')
    parser.add_argument('--output-dir', type=Path, default=Path('benchmark_results'), help='Output directory')
    parser.add_argument('--samples', type=int, default=3, help='Number of samples')
    
    args = parser.parse_args()
    
    if not args.input_file.exists():
        print(f"Error: Input file {args.input_file} not found.")
        return 1
        
    bench = VisualBenchmark(args.input_file, args.output_dir, args.samples)
    bench.run()
    return 0

if __name__ == '__main__':
    sys.exit(main())
