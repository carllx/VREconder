#!/usr/bin/env python3
"""
HEVC Encoder for VR Video Processing Pipeline.

This module provides functionality to encode videos to HEVC format
with various quality presets and hardware acceleration options.
"""

import os
import json
import subprocess
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
from utils.progress_monitor import ProgressLogger
from .base_encoder import BaseEncoder
from utils.resolve_path import resolve_path
from utils.ffmpeg_detector import detect_ffmpeg_path


class EncoderType(Enum):
    """HEVC encoder types."""
    LIBX265 = "libx265"
    NVENC = "hevc_nvenc"
    QSV = "hevc_qsv"
    AMF = "hevc_amf"


class QualityPreset(Enum):
    """Quality presets."""
    ULTRA_FAST = "ultrafast"
    SUPER_FAST = "superfast"
    VERY_FAST = "veryfast"
    FASTER = "faster"
    FAST = "fast"
    MEDIUM = "medium"
    SLOW = "slow"
    SLOWER = "slower"
    VERY_SLOW = "veryslow"


@dataclass
class EncodingTask:
    """Encoding task information."""
    input_file: Path
    output_file: Path
    encoder_type: EncoderType
    quality_preset: QualityPreset
    crf: int
    status: str = "pending"  # pending, processing, completed, failed
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    error_message: Optional[str] = None
    output_size: Optional[int] = None
    progress_logger: Optional[ProgressLogger] = None


class HEVCEncoder(BaseEncoder):
    """HEVC video encoder with multiple encoder support."""
    
    def __init__(self, config: Dict):
        super().__init__(config)
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.ffmpeg_path = self._get_ffmpeg_path()
        self.max_workers = config.get('processing', {}).get('max_workers', 4)
        self.available_encoders = self._detect_available_encoders()
        
    def _get_ffmpeg_path(self) -> str:
        """Get FFmpeg executable path using the new detector."""
        try:
            return detect_ffmpeg_path(self.config)
        except Exception as e:
            self.logger.error(f"FFmpeg 路径检测失败: {e}")
            raise
    
    def _detect_available_encoders(self) -> List[EncoderType]:
        """Detect available HEVC encoders."""
        available = []
        
        try:
            cmd = [self.ffmpeg_path, '-encoders']
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            
            encoder_list = result.stdout.lower()
            
            if 'libx265' in encoder_list:
                available.append(EncoderType.LIBX265)
            
            if 'hevc_nvenc' in encoder_list:
                available.append(EncoderType.NVENC)
            
            if 'hevc_qsv' in encoder_list:
                available.append(EncoderType.QSV)
            
            if 'hevc_amf' in encoder_list:
                available.append(EncoderType.AMF)
                
        except Exception as e:
            self.logger.error(f"Error detecting encoders: {e}")
            # Fallback to libx265
            available.append(EncoderType.LIBX265)
        
        self.logger.info(f"Available encoders: {[e.value for e in available]}")
        return available
    
    def get_optimal_encoder(self, priority: List[EncoderType] = None) -> EncoderType:
        """Get the optimal encoder based on availability and priority.
        
        Args:
            priority: List of encoder priorities (first available will be used)
            
        Returns:
            Optimal encoder type
        """
        if priority is None:
            priority = [EncoderType.NVENC, EncoderType.QSV, EncoderType.LIBX265]
        
        for encoder in priority:
            if encoder in self.available_encoders:
                return encoder
        
        # Fallback to first available
        if self.available_encoders:
            return self.available_encoders[0]
        
        raise RuntimeError("No HEVC encoders available")
    
    def calculate_crf(self, resolution: str, quality: str = "medium") -> int:
        """Calculate CRF value based on resolution and quality.
        
        Args:
            resolution: Video resolution (e.g., "4k", "8k")
            quality: Quality level (low, medium, high)
            
        Returns:
            CRF value
        """
        # 防御性检查，确保参数不为 None
        if resolution is None:
            resolution = "4k"
        if quality is None:
            quality = "medium"
            
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
    
    def encode_video(self, input_file: Path, output_file: Path,
                    encoder_type: Optional[EncoderType] = None,
                    quality_preset: QualityPreset = QualityPreset.MEDIUM,
                    crf: Optional[int] = None,
                    resolution: str = "4k",
                    progress_logger: ProgressLogger = None,
                    force_4k: bool = False) -> bool:
        """Encode a video to HEVC format."""
        self.logger.info(f"Encoding video: {input_file} -> {output_file}")

        # 防御性处理，确保 encoder_type 为 Enum 实例
        if encoder_type is None:
            encoder_type = self.get_optimal_encoder()
        if not isinstance(encoder_type, EncoderType):
            try:
                encoder_type = EncoderType(str(encoder_type))
            except Exception:
                encoder_type = self.get_optimal_encoder()

        # 防御性处理，确保 quality_preset 为 Enum 实例
        if not isinstance(quality_preset, QualityPreset):
            # 映射用户友好的质量名称到 FFmpeg 预设
            quality_map = {
                "low": QualityPreset.FAST,
                "medium": QualityPreset.MEDIUM,
                "high": QualityPreset.SLOW,
                "ultra": QualityPreset.VERY_SLOW
            }
            
            qp_str = str(quality_preset).lower()
            if qp_str in quality_map:
                quality_preset = quality_map[qp_str]
            else:
                try:
                    quality_preset = QualityPreset(qp_str)
                except Exception:
                    self.logger.warning(f"Unknown quality preset '{quality_preset}', defaulting to MEDIUM")
                    quality_preset = QualityPreset.MEDIUM
        
        if not input_file.exists():
            raise FileNotFoundError(f"Input file not found: {input_file}")
        
        
        # Auto-calculate CRF if not specified
        if crf is None:
            crf = self.calculate_crf(resolution, "medium")
        
        # Create output directory
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        # Build FFmpeg command
        cmd = self._build_ffmpeg_command(
            input_file, output_file, encoder_type, quality_preset, crf, force_4k
        )
        
        try:
            # Run FFmpeg
            start_time = time.time()
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, bufsize=1)
            for line in process.stdout:
                if progress_logger:
                    progress_logger.format_and_write(line)
            process.wait()
            end_time = time.time()
            
            # Verify output
            if output_file.exists() and output_file.stat().st_size > 0:
                self.logger.info(f"[SUCCESS] Encoding completed: {output_file}")
                self.logger.info(f"   Duration: {end_time - start_time:.2f}s")
                self.logger.info(f"   Output size: {output_file.stat().st_size / (1024*1024):.2f} MB")
                return True
            else:
                self.logger.error("[ERROR] Encoding failed: Output file is empty or missing")
                return False
                
        except subprocess.CalledProcessError as e:
            self.logger.error(f"[ERROR] Encoding failed: {e.stderr}")
            return False
        except Exception as e:
            self.logger.error(f"[ERROR] Encoding failed: {e}")
            return False
    
    def _build_ffmpeg_command(self, input_file: Path, output_file: Path,
                             encoder_type: EncoderType, quality_preset: QualityPreset,
                             crf: int, force_4k: bool = False) -> List[str]:
        """Build FFmpeg command for encoding."""
        cmd = [
            self.ffmpeg_path,
            '-stats',
            '-i', str(input_file),
        ]
        
        # Add scaling filter if force_4k is enabled
        if force_4k:
            cmd.extend([
                '-vf', 'scale=min(4096,iw):-2'  # 强制缩放到4K以内，保持宽高比
            ])
        
        if encoder_type == EncoderType.NVENC:
            # Map generic presets to NVENC p1-p7
            nvenc_preset_map = {
                QualityPreset.ULTRA_FAST: "p1",
                QualityPreset.SUPER_FAST: "p1",
                QualityPreset.VERY_FAST: "p2",
                QualityPreset.FASTER: "p3",
                QualityPreset.FAST: "p3",
                QualityPreset.MEDIUM: "p4",
                QualityPreset.SLOW: "p6", # High quality
                QualityPreset.SLOWER: "p6",
                QualityPreset.VERY_SLOW: "p7", # Best quality
            }
            preset_val = nvenc_preset_map.get(quality_preset, "p4")
            cmd.extend([
                '-c:v', encoder_type.value,
                '-preset', preset_val,
            ])
        else:
            cmd.extend([
                '-c:v', encoder_type.value,
                '-preset', quality_preset.value,
            ])

        cmd.extend([
            '-crf', str(crf),
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y'
        ])
        
        # Add encoder-specific options
        if encoder_type == EncoderType.NVENC:
            cmd.extend([
                '-rc', 'vbr',
                '-cq', str(crf),
                '-b:v', '0',
                '-maxrate', '50M',
                '-bufsize', '100M'
            ])
        elif encoder_type == EncoderType.LIBX265:
            cmd.extend([
                '-x265-params', f'crf={crf}:preset={quality_preset.value}'
            ])
        
        cmd.append(str(output_file))
        # 去掉 -progress pipe:1，只保留 -stats
        return cmd
    
    def batch_encode(self, input_files: List[Path], output_dir: Path,
                    encoder_type: Optional[EncoderType] = None,
                    quality_preset: QualityPreset = QualityPreset.MEDIUM,
                    crf: Optional[int] = None,
                    resolution: str = "4k",
                    parallel: bool = True) -> List[EncodingTask]:
        """Batch encode multiple videos.
        
        Args:
            input_files: List of input video files
            output_dir: Output directory
            encoder_type: HEVC encoder type
            quality_preset: Quality preset
            crf: CRF value
            resolution: Video resolution
            parallel: Whether to process in parallel
        Returns:
            List of EncodingTask objects with results
        """
        self.logger.info(f"Starting batch encoding of {len(input_files)} files")
        
        # Create encoding tasks
        tasks = []
        log_files = {}  # {task_id: log_path}
        for input_file in input_files:
            output_file = output_dir / f"{input_file.stem}_hevc.mp4"
            task_id = input_file.stem
            log_path = output_dir / f"{input_file.stem}.log"
            log_files[task_id] = str(log_path)
            
            task = EncodingTask(
                input_file=input_file,
                output_file=output_file,
                encoder_type=encoder_type or self.get_optimal_encoder(),
                quality_preset=quality_preset,
                crf=crf or self.calculate_crf(resolution)
            )
            task.progress_logger = ProgressLogger(str(log_path), task_id)
            tasks.append(task)
        
        # Process tasks
        if parallel and len(tasks) > 1:
            self.logger.info(f"Processing {len(tasks)} files in parallel with {self.max_workers} workers")
            self._process_tasks_parallel(tasks)
        else:
            self.logger.info(f"Processing {len(tasks)} files sequentially")
            self._process_tasks_sequential(tasks)
        
        # Generate summary
        completed = sum(1 for t in tasks if t.status == "completed")
        failed = sum(1 for t in tasks if t.status == "failed")
        
        self.logger.info(f"Batch encoding completed: {completed} successful, {failed} failed")
        
        return tasks
    
    def _process_tasks_parallel(self, tasks: List[EncodingTask]):
        """Process encoding tasks in parallel."""
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit all tasks
            future_to_task = {
                executor.submit(self._encode_task, task): task
                for task in tasks
            }
            
            # Process completed tasks
            for future in as_completed(future_to_task):
                task = future_to_task[future]
                try:
                    future.result()  # This will raise any exceptions
                except Exception as e:
                    task.status = "failed"
                    task.error_message = str(e)
                    self.logger.error(f"❌ Task failed: {e}")
    
    def _process_tasks_sequential(self, tasks: List[EncodingTask]):
        """Process encoding tasks sequentially."""
        for task in tasks:
            self._encode_task(task)
    
    def _encode_task(self, task: EncodingTask):
        """Execute a single encoding task."""
        try:
            task.status = "processing"
            task.start_time = time.time()
            
            success = self.encode_video(
                task.input_file,
                task.output_file,
                task.encoder_type,
                task.quality_preset,
                task.crf,
                progress_logger=getattr(task, 'progress_logger', None)
            )
            
            task.end_time = time.time()
            
            if success:
                task.status = "completed"
                task.output_size = task.output_file.stat().st_size
            else:
                task.status = "failed"
                task.error_message = "Encoding failed"
                
        except Exception as e:
            task.status = "failed"
            task.error_message = str(e)
            self.logger.error(f"❌ Task failed: {e}")
    
    def generate_encoding_report(self, tasks: List[EncodingTask]) -> Dict:
        """Generate an encoding operation report.
        
        Args:
            tasks: List of EncodingTask objects
            
        Returns:
            Encoding report dictionary
        """
        report = {
            'total_tasks': len(tasks),
            'completed_tasks': sum(1 for t in tasks if t.status == "completed"),
            'failed_tasks': sum(1 for t in tasks if t.status == "failed"),
            'total_input_size': sum(t.input_file.stat().st_size for t in tasks if t.input_file.exists()),
            'total_output_size': sum(t.output_size or 0 for t in tasks if t.status == "completed"),
            'total_processing_time': sum((t.end_time or 0) - (t.start_time or 0) for t in tasks if t.start_time),
            'encoder_usage': {},
            'errors': [t.error_message for t in tasks if t.error_message]
        }
        
        # Calculate compression ratio
        if report['total_input_size'] > 0:
            report['compression_ratio'] = report['total_output_size'] / report['total_input_size']
        
        # Calculate average processing time
        completed_tasks = [t for t in tasks if t.status == "completed" and t.start_time and t.end_time]
        if completed_tasks:
            report['average_processing_time'] = sum((t.end_time - t.start_time) for t in completed_tasks) / len(completed_tasks)
        
        # Count encoder usage
        for task in tasks:
            encoder = task.encoder_type.value
            report['encoder_usage'][encoder] = report['encoder_usage'].get(encoder, 0) + 1
        
        return report 