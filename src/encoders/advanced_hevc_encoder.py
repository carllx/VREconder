#!/usr/bin/env python3
"""
Advanced HEVC Encoder with CUDA Acceleration and AI Enhancement.

This module provides advanced HEVC encoding capabilities including:
- CUDA hardware acceleration
- AI enhancement features
- Dynamic parameter calculation
- Performance monitoring
- Concurrent processing
- GPU filter chains
"""

import os
import json
import subprocess
import logging
import time
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass
from enum import Enum
from concurrent.futures import ThreadPoolExecutor, as_completed
import psutil
import GPUtil
from utils.progress_monitor import ProgressLogger, monitor_progress
from .base_encoder import BaseEncoder
from utils.resolve_path import resolve_path
from utils.ffmpeg_detector import detect_ffmpeg_path, detect_ffprobe_path


class QualityLevel(Enum):
    """Quality levels for encoding."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    ULTRA = "ultra"


class HardwareAcceleration(Enum):
    """Hardware acceleration types."""
    CUDA = "cuda"
    QSV = "qsv"
    AMF = "amf"
    NONE = "none"


@dataclass
class VideoInfo:
    """Video information."""
    codec: str
    width: int
    height: int
    frame_rate: float
    video_bitrate: int
    audio_codec: str
    audio_bitrate: int
    color_space: str = "bt709"
    duration: float = 0.0
    file_size: int = 0


@dataclass
class EncodingParameters:
    """Encoding parameters."""
    preset: str
    tune: str
    rc: str
    cq: int
    qmin: int
    qmax: int
    profile: str
    pix_fmt: str
    bframes: int
    rc_lookahead: int
    spatial_aq: int
    temporal_aq: int
    aq_strength: int
    multipass: int
    flags: str
    g: int
    level: str
    movflags: str
    metadata: str
    scale: Optional[str] = None


@dataclass
class PerformanceMetrics:
    """Performance monitoring metrics."""
    timestamp: float
    cpu_percent: float
    memory_percent: float
    gpu_utilization: Optional[float] = None
    gpu_memory_used: Optional[int] = None
    gpu_memory_total: Optional[int] = None
    gpu_temperature: Optional[float] = None


class AdvancedHEVCEncoder(BaseEncoder):
    """Advanced HEVC encoder with CUDA acceleration and AI enhancement."""
    
    def __init__(self, config: Dict):
        super().__init__(config)
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.ffmpeg_path = self._get_ffmpeg_path()
        self.mediainfo_path = self._get_mediainfo_path()
        self.max_workers = config.get('processing', {}).get('max_workers', 2)
        self.performance_log = []
        self.monitoring_active = False
        
    def _get_ffmpeg_path(self) -> str:
        """Get FFmpeg executable path using the new detector."""
        try:
            return detect_ffmpeg_path(self.config)
        except Exception as e:
            self.logger.error(f"FFmpeg 路径检测失败: {e}")
            raise
    
    def _get_mediainfo_path(self) -> str:
        """Get MediaInfo executable path."""
        mediainfo_path = self.config.get('paths.windows.mediainfo_path')
        if mediainfo_path:
            return resolve_path(mediainfo_path, self.config)
        try:
            result = subprocess.run(['mediainfo', '--version'], 
                                  capture_output=True, text=True, check=True)
            return 'mediainfo'
        except (subprocess.CalledProcessError, FileNotFoundError):
            common_paths = [
                'C:/mediainfo/mediainfo.exe',
                'C:/Program Files/MediaInfo/mediainfo.exe',
                '/usr/local/bin/mediainfo',
                '/usr/bin/mediainfo'
            ]
            
            for path in common_paths:
                if os.path.exists(path):
                    return path
            
            self.logger.warning("MediaInfo not found. Using FFmpeg fallback.")
            return None
    
    def test_system_requirements(self) -> Tuple[bool, HardwareAcceleration]:
        """Test system requirements and detect hardware acceleration.
        
        Returns:
            Tuple of (has_gpu, acceleration_type)
        """
        self.logger.info("检查系统要求...")
        
        # Check FFmpeg
        if not self._check_ffmpeg():
            raise RuntimeError("FFmpeg未安装或不在PATH中")
        
        # Check MediaInfo
        if not self._check_mediainfo():
            self.logger.warning("MediaInfo未安装，将使用FFmpeg获取视频信息")
        
        # Check hardware acceleration
        acceleration = self._detect_hardware_acceleration()
        
        if acceleration != HardwareAcceleration.NONE:
            self.logger.info(f"检测到硬件加速: {acceleration.value}")
            return True, acceleration
        else:
            self.logger.warning("未检测到硬件加速，将使用CPU编码")
            return False, HardwareAcceleration.NONE
    
    def _check_ffmpeg(self) -> bool:
        """Check if FFmpeg is available."""
        try:
            result = subprocess.run([self.ffmpeg_path, '-version'], 
                                  capture_output=True, text=True, check=True)
            return True
        except:
            return False
    
    def _check_mediainfo(self) -> bool:
        """Check if MediaInfo is available."""
        if not self.mediainfo_path:
            return False
        
        try:
            result = subprocess.run([self.mediainfo_path, '--version'], 
                                  capture_output=True, text=True, check=True)
            return True
        except:
            return False
    
    def _detect_hardware_acceleration(self) -> HardwareAcceleration:
        """Detect available hardware acceleration."""
        try:
            # Check FFmpeg encoders
            cmd = [self.ffmpeg_path, '-encoders']
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            encoder_list = result.stdout.lower()
            
            # Check CUDA
            if 'hevc_nvenc' in encoder_list:
                # Check if CUDA is actually available
                try:
                    cmd = [self.ffmpeg_path, '-f', 'lavfi', '-i', 'testsrc', 
                          '-c:v', 'hevc_nvenc', '-frames:v', '1', '-f', 'null', '-']
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                    if result.returncode == 0:
                        return HardwareAcceleration.CUDA
                except:
                    pass
            
            # Check QSV
            if 'hevc_qsv' in encoder_list:
                return HardwareAcceleration.QSV
            
            # Check AMF
            if 'hevc_amf' in encoder_list:
                return HardwareAcceleration.AMF
            
        except Exception as e:
            self.logger.error(f"检测硬件加速时出错: {e}")
        
        return HardwareAcceleration.NONE
    
    def get_video_info(self, file_path: Path) -> Optional[VideoInfo]:
        """Get detailed video information.
        
        Args:
            file_path: Path to video file
            
        Returns:
            VideoInfo object or None if failed
        """
        try:
            if self.mediainfo_path:
                return self._get_video_info_mediainfo(file_path)
            else:
                return self._get_video_info_ffmpeg(file_path)
        except Exception as e:
            self.logger.error(f"获取视频信息失败 {file_path}: {e}")
            return None
    
    def _get_video_info_mediainfo(self, file_path: Path) -> VideoInfo:
        """Get video info using MediaInfo."""
        # Video info
        cmd = [
            self.mediainfo_path,
            '--Output=Video;%Format%,%Width%,%Height%,%FrameRate%,%BitRate%,%ColorSpace%',
            str(file_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        video_parts = result.stdout.strip().split(',')
        
        # Audio info
        cmd = [
            self.mediainfo_path,
            '--Output=Audio;%Format%,%BitRate%',
            str(file_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        audio_parts = result.stdout.strip().split(',')
        
        # Duration
        cmd = [
            self.mediainfo_path,
            '--Output=General;%Duration%',
            str(file_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        duration = float(result.stdout.strip() or 0) / 1000  # Convert to seconds
        
        return VideoInfo(
            codec=video_parts[0],
            width=int(video_parts[1]),
            height=int(video_parts[2]),
            frame_rate=float(video_parts[3]),
            video_bitrate=int(video_parts[4] or 0),
            audio_codec=audio_parts[0],
            audio_bitrate=int(audio_parts[1] or 0),
            color_space=video_parts[5] if len(video_parts) > 5 else "bt709",
            duration=duration,
            file_size=file_path.stat().st_size
        )
    
    def _get_video_info_ffmpeg(self, file_path: Path) -> VideoInfo:
        """Get video info using FFmpeg."""
        cmd = [
            self.ffmpeg_path,
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            str(file_path)
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        
        # Find video stream
        video_stream = None
        audio_stream = None
        
        for stream in data.get('streams', []):
            if stream.get('codec_type') == 'video':
                video_stream = stream
            elif stream.get('codec_type') == 'audio':
                audio_stream = stream
        
        if not video_stream:
            raise ValueError("No video stream found")
        
        return VideoInfo(
            codec=video_stream.get('codec_name', 'unknown'),
            width=int(video_stream.get('width', 0)),
            height=int(video_stream.get('height', 0)),
            frame_rate=self._parse_frame_rate(video_stream.get('r_frame_rate', '0/1')),
            video_bitrate=int(data.get('format', {}).get('bit_rate', 0)),
            audio_codec=audio_stream.get('codec_name', 'unknown') if audio_stream else 'unknown',
            audio_bitrate=int(audio_stream.get('bit_rate', 0)) if audio_stream else 0,
            color_space=video_stream.get('color_space', 'bt709'),
            duration=float(data.get('format', {}).get('duration', 0)),
            file_size=file_path.stat().st_size
        )
    
    def _parse_frame_rate(self, frame_rate_str: str) -> float:
        """Parse frame rate string to float."""
        try:
            if '/' in frame_rate_str:
                num, den = map(int, frame_rate_str.split('/'))
                return num / den if den != 0 else 0
            else:
                return float(frame_rate_str)
        except:
            return 0
    
    def get_encoding_parameters(self, video_info: VideoInfo, 
                              quality_level: QualityLevel,
                              has_gpu: bool) -> EncodingParameters:
        """Get encoding parameters based on video info and quality level.
        
        Args:
            video_info: Video information
            quality_level: Quality level
            has_gpu: Whether GPU is available
            
        Returns:
            EncodingParameters object
        """
        # Base parameters
        base_params = {
            'preset': 'p6',
            'tune': 'uhq',
            'rc': 'vbr',
            'profile': 'main10',
            'pix_fmt': 'p010le',
            'spatial_aq': 1,
            'temporal_aq': 1,
            'multipass': 2,
            'flags': '+cgop',
            'g': 120,
            'level': '5.1',
            'movflags': '+faststart',
            'metadata': 'stereo_mode=left_right'
        }
        
        # Quality level adjustments
        quality_params = {
            QualityLevel.LOW: {
                'preset': 'p4', 'tune': 'hq', 'cq': 28, 'qmin': 26, 'qmax': 30,
                'rc_lookahead': 16, 'aq_strength': 4, 'bframes': 2,
                'profile': 'main', 'pix_fmt': 'yuv420p'
            },
            QualityLevel.MEDIUM: {
                'preset': 'p5', 'tune': 'hq', 'cq': 26, 'qmin': 24, 'qmax': 28,
                'rc_lookahead': 24, 'aq_strength': 6, 'bframes': 3
            },
            QualityLevel.HIGH: {
                'preset': 'p6', 'tune': 'uhq', 'cq': 24, 'qmin': 22, 'qmax': 26,
                'rc_lookahead': 32, 'aq_strength': 8, 'bframes': 4
            },
            QualityLevel.ULTRA: {
                'preset': 'p7', 'tune': 'uhq', 'cq': 22, 'qmin': 20, 'qmax': 24,
                'rc_lookahead': 40, 'aq_strength': 10, 'bframes': 5
            }
        }
        
        # Apply quality parameters
        base_params.update(quality_params[quality_level])
        
        # Resolution adjustments
        if video_info.width > 8192:  # 修改为支持8K VR视频
            base_params['scale'] = 'scale=min(8192,iw):-2'
        
        # Frame rate adjustments
        if video_info.frame_rate > 50:
            base_params['rc_lookahead'] = min(base_params['rc_lookahead'], 24)
        
        return EncodingParameters(**base_params)
    
    def get_gpu_filter_chain(self, video_info: VideoInfo, 
                           use_ai_enhancement: bool = False) -> Optional[str]:
        """Get GPU filter chain for advanced processing.
        
        Args:
            video_info: Video information
            use_ai_enhancement: Whether to use AI enhancement
            
        Returns:
            Filter chain string or None
        """
        filters = []
        
        # Upload to GPU
        filters.append("hwupload_cuda")
        
        # Scaling (if needed)
        if video_info.width > 8192:  # 修改为支持8K VR视频
            filters.append("scale_npp=format=p010le")
        
        # AI super resolution (if enabled)
        if use_ai_enhancement:
            # Note: This requires AI models to be available
            ai_model_path = self.config.get('ai', {}).get('super_resolution_model')
            if ai_model_path and os.path.exists(ai_model_path):
                filters.append(f"sr_cuda=model={ai_model_path}")
        
        # Denoising filter
        filters.append("bilateral_cuda=sigma_s=10:sigma_r=0.1")
        
        # Tone mapping (HDR to SDR)
        if video_info.color_space == "bt2020nc":
            filters.append("tonemap_npp=format=p010le")
        
        return ",".join(filters) if filters else None
    
    def start_performance_monitoring(self, log_file: Optional[Path] = None):
        """Start performance monitoring."""
        self.monitoring_active = True
        self.performance_log = []
        
        def monitor():
            while self.monitoring_active:
                try:
                    # CPU and memory
                    cpu_percent = psutil.cpu_percent(interval=1)
                    memory_percent = psutil.virtual_memory().percent
                    
                    # GPU info
                    gpu_utilization = None
                    gpu_memory_used = None
                    gpu_memory_total = None
                    gpu_temperature = None
                    
                    try:
                        gpus = GPUtil.getGPUs()
                        if gpus:
                            gpu = gpus[0]  # Use first GPU
                            gpu_utilization = gpu.load * 100
                            gpu_memory_used = gpu.memoryUsed
                            gpu_memory_total = gpu.memoryTotal
                            gpu_temperature = gpu.temperature
                    except:
                        pass
                    
                    metrics = PerformanceMetrics(
                        timestamp=time.time(),
                        cpu_percent=cpu_percent,
                        memory_percent=memory_percent,
                        gpu_utilization=gpu_utilization,
                        gpu_memory_used=gpu_memory_used,
                        gpu_memory_total=gpu_memory_total,
                        gpu_temperature=gpu_temperature
                    )
                    
                    self.performance_log.append(metrics)
                    
                    # Log to file if specified
                    if log_file:
                        log_message = (
                            f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] "
                            f"CPU: {cpu_percent:.1f}%, "
                            f"Memory: {memory_percent:.1f}%"
                        )
                        
                        if gpu_utilization is not None:
                            log_message += (
                                f", GPU: {gpu_utilization:.1f}%, "
                                f"GPU Mem: {gpu_memory_used}MB/{gpu_memory_total}MB, "
                                f"Temp: {gpu_temperature:.1f}°C"
                            )
                        
                        with open(log_file, 'a', encoding='utf-8') as f:
                            f.write(log_message + '\n')
                    
                    time.sleep(5)
                    
                except Exception as e:
                    self.logger.error(f"Performance monitoring error: {e}")
                    time.sleep(5)
        
        # Start monitoring thread
        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        
        self.logger.info("性能监控已启动")
    
    def stop_performance_monitoring(self):
        """Stop performance monitoring."""
        self.monitoring_active = False
        self.logger.info("性能监控已停止")
    
    def encode_video(self, input_path: Path, output_path: Path,
                    quality_level: QualityLevel = QualityLevel.HIGH,
                    use_ai_enhancement: bool = False,
                    has_gpu: bool = True,
                    progress_logger: ProgressLogger = None) -> bool:
        """Encode a single video file with advanced features.
        
        Args:
            input_path: Input video file path
            output_path: Output video file path
            quality_level: Quality level
            use_ai_enhancement: Whether to use AI enhancement
            has_gpu: Whether GPU is available
            progress_logger: Optional ProgressLogger instance for streaming output
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.logger.info(f"开始编码: {input_path.name}")
            
            # Get video info
            video_info = self.get_video_info(input_path)
            if not video_info:
                raise RuntimeError("无法获取视频信息")
            
            # Get encoding parameters
            encoding_params = self.get_encoding_parameters(video_info, quality_level, has_gpu)
            
            # Build FFmpeg command
            cmd = [self.ffmpeg_path, '-i', str(input_path)]
            
            # Hardware acceleration
            if has_gpu:
                cmd.extend(['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'])
            
            # GPU filters
            if has_gpu and encoding_params.scale:
                filter_chain = self.get_gpu_filter_chain(video_info, use_ai_enhancement)
                if filter_chain:
                    cmd.extend(['-vf', filter_chain])
            
            # Encoding parameters
            cmd.extend([
                '-c:v', 'hevc_nvenc',
                '-preset', encoding_params.preset,
                '-tune', encoding_params.tune,
                '-rc', encoding_params.rc,
                '-cq', str(encoding_params.cq),
                '-qmin', str(encoding_params.qmin),
                '-qmax', str(encoding_params.qmax),
                '-profile:v', encoding_params.profile,
                '-pix_fmt', encoding_params.pix_fmt,
                '-bf', str(encoding_params.bframes),
                '-rc-lookahead', str(encoding_params.rc_lookahead),
                '-spatial_aq', str(encoding_params.spatial_aq),
                '-temporal_aq', str(encoding_params.temporal_aq),
                '-aq-strength', str(encoding_params.aq_strength),
                '-multipass', str(encoding_params.multipass),
                '-flags', encoding_params.flags,
                '-g', str(encoding_params.g),
                '-level', encoding_params.level
            ])
            
            # Audio parameters
            cmd.extend([
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ac', '2'
            ])
            
            # Output parameters
            cmd.extend([
                '-movflags', encoding_params.movflags,
                '-metadata', encoding_params.metadata,
                '-stats',
                '-y', str(output_path)
            ])
            
            # Execute encoding
            self.logger.debug(f"执行命令: {' '.join(cmd)}")
            
            start_time = time.time()
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, bufsize=1)
            for line in process.stdout:
                if progress_logger:
                    progress_logger.format_and_write(line)
            process.wait()
            end_time = time.time()
            
            # Verify output
            if output_path.exists() and output_path.stat().st_size > 0:
                self.logger.info(f"✅ 编码完成: {output_path.name}")
                self.logger.info(f"   用时: {end_time - start_time:.2f}秒")
                self.logger.info(f"   输出大小: {output_path.stat().st_size / (1024*1024):.2f} MB")
                return True
            else:
                self.logger.error("❌ 编码失败: 输出文件为空或缺失")
                return False
                
        except subprocess.CalledProcessError as e:
            self.logger.error(f"❌ 编码失败: {e.stderr}")
            return False
        except Exception as e:
            self.logger.error(f"❌ 编码过程中发生错误: {e}")
            return False
    
    def batch_encode(self, input_dir: Path, output_dir: Path,
                    quality_level: QualityLevel = QualityLevel.HIGH,
                    use_ai_enhancement: bool = False,
                    enable_performance_monitoring: bool = True,
                    performance_log_file: Optional[Path] = None) -> Dict:
        """Batch encode multiple video files.
        
        Args:
            input_dir: Input directory containing video files
            output_dir: Output directory for encoded files
            quality_level: Quality level
            use_ai_enhancement: Whether to use AI enhancement
            enable_performance_monitoring: Whether to enable performance monitoring
            performance_log_file: Performance log file path
            
        Returns:
            Dictionary with encoding results
        """
        self.logger.info("=== 高级HEVC编码器启动 ===")
        self.logger.info(f"质量级别: {quality_level.value}")
        self.logger.info(f"AI增强: {use_ai_enhancement}")
        self.logger.info(f"并发作业数: {self.max_workers}")
        
        # Check system requirements
        has_gpu, acceleration = self.test_system_requirements()
        
        # Check input directory
        if not input_dir.exists():
            raise FileNotFoundError(f"指定的文件夹不存在: {input_dir}")
        
        # Start performance monitoring
        if enable_performance_monitoring:
            self.start_performance_monitoring(performance_log_file)
        
        try:
            # Get video files
            video_files = list(input_dir.glob("*.mp4"))
            video_files = [f for f in video_files if f.stat().st_size > 0]
            
            self.logger.info(f"找到 {len(video_files)} 个视频文件")
            
            if not video_files:
                self.logger.warning("没有找到可处理的视频文件")
                return {'success': 0, 'failed': 0, 'total': 0}
            
            # Create output directory
            output_dir.mkdir(parents=True, exist_ok=True)
            
            # Process video files
            results = []
            
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                # Submit encoding tasks
                future_to_file = {}
                
                for video_file in video_files:
                    output_file = output_dir / f"{video_file.stem}_HEVC_Advanced_{quality_level.value}.mp4"
                    
                    # Create a unique task ID
                    task_id = f"{video_file.stem}_{quality_level.value}_{use_ai_enhancement}"
                    log_path = output_dir / f"{video_file.stem}.log"
                    # log_files[task_id] = str(log_path) # This line was removed as per the edit hint
                    progress_logger = ProgressLogger(str(log_path), task_id)
                    
                    future = executor.submit(
                        self.encode_video,
                        video_file,
                        output_file,
                        quality_level,
                        use_ai_enhancement,
                        has_gpu,
                        progress_logger
                    )
                    
                    future_to_file[future] = video_file
                
                # Collect results
                success_count = 0
                failed_count = 0
                
                for future in as_completed(future_to_file):
                    video_file = future_to_file[future]
                    try:
                        success = future.result()
                        if success:
                            success_count += 1
                            self.logger.info(f"✅ 完成: {video_file.name}")
                        else:
                            failed_count += 1
                            self.logger.error(f"❌ 失败: {video_file.name}")
                    except Exception as e:
                        failed_count += 1
                        self.logger.error(f"❌ 异常: {video_file.name} - {e}")
            
            # Stop performance monitoring
            if enable_performance_monitoring:
                self.stop_performance_monitoring()
            
            # Generate report
            report = {
                'success': success_count,
                'failed': failed_count,
                'total': len(video_files),
                'output_dir': str(output_dir),
                'quality_level': quality_level.value,
                'ai_enhancement': use_ai_enhancement,
                'hardware_acceleration': acceleration.value,
                'performance_metrics': self.performance_log
            }
            
            # Output results
            self.logger.info("=== 编码完成 ===")
            self.logger.info(f"成功: {success_count}")
            self.logger.info(f"失败: {failed_count}")
            self.logger.info(f"输出目录: {output_dir}")
            
            return report
            
        except Exception as e:
            self.logger.error(f"批处理过程中发生错误: {e}")
            if enable_performance_monitoring:
                self.stop_performance_monitoring()
            raise 

    def generate_encoding_report(self, report_or_tasks):
        """
        Generate an encoding operation report from batch results.
        兼容 batch_encode 返回的 report 字典。
        """
        if isinstance(report_or_tasks, dict):
            return report_or_tasks
        return {"result": report_or_tasks} 