#!/usr/bin/env python3
"""
Video Splitter for VR Video Processing Pipeline.

This module provides functionality to split VR videos into segments
for processing and encoding.
"""

import os
import json
import subprocess
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
from utils.progress_monitor import ProgressLogger
import threading
from utils.dynamic_worker_pool import DynamicWorkerPool


@dataclass
class SplitSegment:
    """Video segment information."""
    input_file: Path
    output_file: Path
    start_time: float
    end_time: float
    duration: float
    segment_index: int
    status: str = "pending"  # pending, processing, completed, failed
    error_message: Optional[str] = None


class VideoSplitter:
    """Split VR videos into segments for processing."""
    
    def __init__(self, config: Dict):
        """Initialize the video splitter.
        
        Args:
            config: Configuration dictionary
        """
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.ffmpeg_path = self._get_ffmpeg_path()
        self.max_workers = config.get('processing', {}).get('max_workers', 4)
        
    def _get_ffmpeg_path(self) -> str:
        """Get FFmpeg executable path."""
        # Try to find ffmpeg in PATH
        try:
            result = subprocess.run(['ffmpeg', '-version'], 
                                  capture_output=True, text=True, check=True)
            return 'ffmpeg'
        except (subprocess.CalledProcessError, FileNotFoundError):
            # Try common installation paths
            common_paths = [
                'C:/ffmpeg/bin/ffmpeg.exe',
                'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
                '/usr/local/bin/ffmpeg',
                '/usr/bin/ffmpeg'
            ]
            
            for path in common_paths:
                if os.path.exists(path):
                    return path
            
            raise FileNotFoundError("FFmpeg not found. Please install FFmpeg.")
    
    def get_video_duration(self, video_path: Path) -> float:
        """Get video duration in seconds."""
        try:
            cmd = [
                'ffprobe',
                '-v', 'quiet',
                '-show_entries', 'format=duration',
                '-of', 'csv=p=0',
                str(video_path)
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return float(result.stdout.strip())
            
        except Exception as e:
            self.logger.error(f"Error getting video duration: {e}")
            return 0.0
    
    def calculate_crf(self, resolution: str, quality: str = "medium") -> int:
        """Calculate CRF value based on resolution and quality.
        
        Args:
            resolution: Video resolution (e.g., "4k", "8k")
            quality: Quality level (low, medium, high)
            
        Returns:
            CRF value
        """
        # Base CRF values for different resolutions
        base_crf = {
            "hd": 23,
            "fhd": 23,
            "4k": 25,
            "8k": 28
        }
        
        # Quality adjustments
        quality_adjustments = {
            "low": 5,
            "medium": 0,
            "high": -3
        }
        
        base = base_crf.get(resolution.lower(), 23)
        adjustment = quality_adjustments.get(quality.lower(), 0)
        
        return max(15, min(35, base + adjustment))
    
    def create_split_plan(self, video_path: Path, segment_duration: float = 300.0, base_dir: Path = None) -> List[SplitSegment]:
        self.logger.info(f"Creating split plan for: {video_path}")
        if not video_path.exists():
            raise FileNotFoundError(f"Video file not found: {video_path}")
        total_duration = self.get_video_duration(video_path)
        if total_duration <= 0:
            raise ValueError(f"Invalid video duration: {total_duration}")
        # 统一分段输出目录
        if base_dir is None:
            base_dir = Path(self.config.get_path('paths.temp', './temp')) / f"splits"
        output_dir = base_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        segments = []
        segment_index = 0
        for start_time in range(0, int(total_duration), int(segment_duration)):
            end_time = min(start_time + segment_duration, total_duration)
            duration = end_time - start_time
            output_filename = f"{video_path.stem}_segment_{segment_index:03d}.mp4"
            output_file = output_dir / output_filename
            segment = SplitSegment(
                input_file=video_path,
                output_file=output_file.resolve(),
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                segment_index=segment_index
            )
            segments.append(segment)
            segment_index += 1
        self.logger.info(f"Created split plan with {len(segments)} segments")
        return segments
    
    def split_video_segment(self, segment: SplitSegment, quality: str = "medium", encoder_type: str = "libx265", crf: int = 23, progress_logger: ProgressLogger = None, skip_encode: bool = False) -> bool:
        """Split a single video segment with high precision and custom encoder.
        Args:
            segment: SplitSegment object
            quality: Quality preset (low, medium, high)
            encoder_type: 'libx265' or 'hevc_nvenc'
            crf: CRF value
            progress_logger: Optional ProgressLogger for streaming output
            skip_encode: If True, only split without re-encoding (copy mode)
        Returns:
            True if successful, False otherwise
        """
        try:
            segment.status = "processing"
            self.logger.info(f"Processing segment {segment.segment_index}: {segment.start_time:.2f}s - {segment.end_time:.2f}s")
            
            if skip_encode:
                # 只分割，不重新编码（快速模式）
                cmd = [
                    self.ffmpeg_path,
                    '-stats',
                    '-ss', str(segment.start_time),
                    '-t', str(segment.duration),
                    '-i', str(segment.input_file),
                    '-c', 'copy',  # 直接复制，不重新编码
                    '-y', str(segment.output_file)
                ]
            else:
                # 分割并重新编码（高质量模式）
                preset_map = {
                    "low": "fast",
                    "medium": "medium",
                    "high": "slow"
                }
                preset = preset_map.get(quality, "medium")
                cmd = [
                    self.ffmpeg_path,
                    '-stats',
                    '-ss', str(segment.start_time),
                    '-t', str(segment.duration),
                    '-i', str(segment.input_file),
                    '-c:v', encoder_type,
                    '-crf', str(crf),
                    '-preset', preset,
                    '-c:a', 'copy',
                    '-y', str(segment.output_file)
                ]
                # hevc_nvenc 兼容参数
                if encoder_type == 'hevc_nvenc':
                    cmd += ['-rc', 'vbr', '-cq', str(crf), '-b:v', '0', '-maxrate', '50M', '-bufsize', '100M']
            
            # Run FFmpeg
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, bufsize=1)
            for line in process.stdout:
                if progress_logger:
                    progress_logger.format_and_write(line)
            process.wait()
            
            # Verify output file
            if segment.output_file.exists() and segment.output_file.stat().st_size > 0:
                segment.status = "completed"
                self.logger.info(f"[SUCCESS] Segment {segment.segment_index} completed: {segment.output_file}")
                return True
            else:
                segment.status = "failed"
                segment.error_message = "Output file is empty or missing"
                self.logger.error(f"[ERROR] Segment {segment.segment_index} failed: {segment.error_message}")
                return False
        except subprocess.CalledProcessError as e:
            segment.status = "failed"
            segment.error_message = f"FFmpeg error: {e.stderr}"
            self.logger.error(f"[ERROR] Segment {segment.segment_index} failed: {segment.error_message}")
            return False
        except Exception as e:
            segment.status = "failed"
            segment.error_message = str(e)
            self.logger.error(f"[ERROR] Segment {segment.segment_index} failed: {segment.error_message}")
            return False
    
    @staticmethod
    def save_split_status(segments, status_json_path):
        data = []
        for seg in segments:
            data.append({
                "segment_index": seg.segment_index,
                "start_time": seg.start_time,
                "end_time": seg.end_time,
                "duration": seg.duration,
                "output_file": str(seg.output_file),
                "status": seg.status,
                "error_message": seg.error_message
            })
        with open(status_json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    @staticmethod
    def load_split_status(status_json_path):
        if not os.path.exists(status_json_path):
            return None
        with open(status_json_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def split_video(self, video_path: Path, segment_duration: float = 300.0, 
                   quality: str = "medium", parallel: bool = True,
                   encoder_type: str = "libx265", crf: int = 23, max_workers: int = None, base_dir: Path = None, skip_encode: bool = False) -> List[SplitSegment]:
        self.logger.info(f"Starting video split: {video_path}")
        if base_dir is None:
            base_dir = Path(self.config.get_path('paths.temp', './temp')) / f"splits"
        status_json_path = base_dir / 'split_status.json'
        segments = self.create_split_plan(video_path, segment_duration, base_dir=base_dir)
        # 检查现有片段文件，而不是依赖状态文件
        to_process = []
        for seg in segments:
            if seg.output_file.exists() and seg.output_file.stat().st_size > 0:
                seg.status = "completed"
                self.logger.info(f"Segment {seg.segment_index} already exists: {seg.output_file}")
            else:
                seg.status = "pending"
                to_process.append(seg)
        
        if not to_process:
            self.logger.info("All segments already completed, nothing to do.")
            return segments
        def process_and_save(seg, *args, **kwargs):
            result = self.split_video_segment(seg, *args, **kwargs)
            self.save_split_status(segments, status_json_path)
            return result
        pool_max_workers = max_workers if max_workers is not None else self.max_workers
        if parallel and len(to_process) > 1:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=pool_max_workers) as executor:
                futures = []
                for seg in to_process:
                    task_id = f"segment_{seg.segment_index}"
                    log_path = base_dir / f"{task_id}.log"
                    progress_logger = ProgressLogger(str(log_path), task_id)
                    futures.append(executor.submit(process_and_save, seg, quality, encoder_type, crf, progress_logger, skip_encode))
                for future in futures:
                    future.result()
        else:
            for seg in to_process:
                task_id = f"segment_{seg.segment_index}"
                log_path = base_dir / f"{task_id}.log"
                progress_logger = ProgressLogger(str(log_path), task_id)
                process_and_save(seg, quality, encoder_type, crf, progress_logger, skip_encode)
        return segments
    
    def _process_segments_parallel(self, segments: List[SplitSegment], quality: str, encoder_type: str, crf: int):
        """Process segments in parallel with custom encoder and crf."""
        from pathlib import Path
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            future_to_segment = {}
            for segment in segments:
                task_id = f"segment_{segment.segment_index}"
                log_path = Path(self.config.get_path('paths.temp', './temp')) / f"{task_id}.log"
                progress_logger = ProgressLogger(str(log_path), task_id)
                future = executor.submit(self.split_video_segment, segment, quality, encoder_type, crf, progress_logger)
                future_to_segment[future] = segment
            # Process completed tasks
            for future in as_completed(future_to_segment):
                segment = future_to_segment[future]
                try:
                    future.result()  # This will raise any exceptions
                except Exception as e:
                    segment.status = "failed"
                    segment.error_message = str(e)
                    self.logger.error(f"❌ Segment {segment.segment_index} failed: {e}")
    
    def _process_segments_sequential(self, segments: List[SplitSegment], quality: str):
        """Process segments sequentially."""
        for segment in segments:
            self.split_video_segment(segment, quality)
    
    def merge_segments(self, segments: List[SplitSegment], output_path: Path) -> bool:
        """Merge video segments back into a single file.
        
        Args:
            segments: List of completed SplitSegment objects
            output_path: Path for the merged output file
            
        Returns:
            True if successful, False otherwise
        """
        self.logger.info(f"Merging {len(segments)} segments into: {output_path}")
        
        # Filter completed segments
        completed_segments = [s for s in segments if s.status == "completed"]
        if not completed_segments:
            self.logger.error("No completed segments to merge")
            return False
        
        # Sort segments by index
        completed_segments.sort(key=lambda s: s.segment_index)
        
        try:
            # Create file list for FFmpeg
            file_list_path = output_path.parent / "file_list.txt"
            with open(file_list_path, 'w', encoding='utf-8') as f:
                for segment in completed_segments:
                    f.write(f"file '{segment.output_file.absolute()}'\n")
            
            # Build FFmpeg command for concatenation
            cmd = [
                self.ffmpeg_path,
                '-f', 'concat',
                '-safe', '0',
                '-i', str(file_list_path),
                '-c', 'copy',
                '-y',
                str(output_path)
            ]
            
            # Run FFmpeg
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            
            # Clean up file list
            file_list_path.unlink(missing_ok=True)
            
            if output_path.exists() and output_path.stat().st_size > 0:
                self.logger.info(f"✅ Merge completed: {output_path}")
                return True
            else:
                self.logger.error("❌ Merge failed: Output file is empty or missing")
                return False
                
        except subprocess.CalledProcessError as e:
            self.logger.error(f"❌ Merge failed: {e.stderr}")
            return False
        except Exception as e:
            self.logger.error(f"❌ Merge failed: {e}")
            return False
    
    def cleanup_segments(self, segments: List[SplitSegment]) -> int:
        """Clean up segment files.
        
        Args:
            segments: List of SplitSegment objects
            
        Returns:
            Number of files cleaned up
        """
        cleaned_count = 0
        
        for segment in segments:
            if segment.output_file.exists():
                try:
                    segment.output_file.unlink()
                    cleaned_count += 1
                    self.logger.debug(f"Cleaned up: {segment.output_file}")
                except Exception as e:
                    self.logger.warning(f"Failed to clean up {segment.output_file}: {e}")
        
        self.logger.info(f"Cleaned up {cleaned_count} segment files")
        return cleaned_count
    
    def generate_split_report(self, segments: List[SplitSegment]) -> Dict:
        """Generate a split operation report.
        
        Args:
            segments: List of SplitSegment objects
            
        Returns:
            Split report dictionary
        """
        report = {
            'total_segments': len(segments),
            'completed_segments': sum(1 for s in segments if s.status == "completed"),
            'failed_segments': sum(1 for s in segments if s.status == "failed"),
            'pending_segments': sum(1 for s in segments if s.status == "pending"),
            'total_duration': sum(s.duration for s in segments),
            'total_size': sum(s.output_file.stat().st_size for s in segments if s.status == "completed" and s.output_file.exists()),
            'errors': [s.error_message for s in segments if s.error_message]
        }
        
        return report
