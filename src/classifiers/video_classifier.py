#!/usr/bin/env python3
"""
Video Classifier for VR Video Processing Pipeline.

This module provides functionality to classify VR videos by resolution,
format, and other characteristics.
"""

import os
import json
import subprocess
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
from utils.ffmpeg_detector import detect_ffmpeg_path


class VideoResolution(Enum):
    """Video resolution enumeration."""
    UNKNOWN = "unknown"
    HD = "hd"  # 1920x1080
    FHD = "fhd"  # 1920x1080
    QHD = "qhd"  # 2560x1440
    UHD = "uhd"  # 3840x2160
    UHD_PLUS = "uhd_plus"  # 5120x2880
    VR_4K = "vr_4k"  # 4096x2048
    VR_6K = "vr_6k"  # 6144x3072
    VR_8K = "vr_8k"  # 8192x4096


class VideoFormat(Enum):
    """Video format enumeration."""
    UNKNOWN = "unknown"
    MP4 = "mp4"
    AVI = "avi"
    MKV = "mkv"
    MOV = "mov"
    WEBM = "webm"
    M4V = "m4v"


@dataclass
class VideoInfo:
    """Video information data class."""
    file_path: Path
    resolution: VideoResolution
    format: VideoFormat
    width: int
    height: int
    duration: float
    bitrate: int
    codec: str
    frame_rate: float
    file_size: int
    is_vr: bool = False
    vr_type: Optional[str] = None


class VideoClassifier:
    """Classify VR videos by resolution and format."""
    
    def __init__(self, config: Dict):
        """Initialize the video classifier.
        
        Args:
            config: Configuration dictionary
        """
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.mediainfo_path = self._get_mediainfo_path()
        
    def _get_mediainfo_path(self) -> str:
        """Get MediaInfo executable path."""
        # Try to find mediainfo in PATH
        try:
            result = subprocess.run(['mediainfo', '--version'], 
                                  capture_output=True, text=True, check=True)
            return 'mediainfo'
        except (subprocess.CalledProcessError, FileNotFoundError):
            # Try common installation paths
            common_paths = [
                'C:/mediainfo/mediainfo.exe',
                'C:/Program Files/MediaInfo/mediainfo.exe',
                '/usr/local/bin/mediainfo',
                '/usr/bin/mediainfo'
            ]
            
            for path in common_paths:
                if os.path.exists(path):
                    return path
            
            self.logger.warning("MediaInfo not found. Using fallback method.")
            return None
    
    def classify_video(self, video_path: Path) -> VideoInfo:
        """Classify a video file.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            VideoInfo object with classification results
        """
        self.logger.info(f"Classifying video: {video_path}")
        
        if not video_path.exists():
            raise FileNotFoundError(f"Video file not found: {video_path}")
        
        # Get video information
        video_info = self._get_video_info(video_path)
        
        # Classify resolution
        resolution = self._classify_resolution(video_info['width'], video_info['height'])
        
        # Classify format
        format_type = self._classify_format(video_path.suffix)
        
        # Determine if it's VR video
        is_vr, vr_type = self._classify_vr(video_info['width'], video_info['height'])
        
        return VideoInfo(
            file_path=video_path,
            resolution=resolution,
            format=format_type,
            width=video_info['width'],
            height=video_info['height'],
            duration=video_info['duration'],
            bitrate=video_info['bitrate'],
            codec=video_info['codec'],
            frame_rate=video_info['frame_rate'],
            file_size=video_path.stat().st_size,
            is_vr=is_vr,
            vr_type=vr_type
        )
    
    def _get_video_info(self, video_path: Path) -> Dict:
        """Get video information using MediaInfo or FFmpeg."""
        if self.mediainfo_path:
            return self._get_video_info_mediainfo(video_path)
        else:
            return self._get_video_info_ffmpeg(video_path)
    
    def _get_video_info_mediainfo(self, video_path: Path) -> Dict:
        """Get video information using MediaInfo."""
        try:
            cmd = [
                self.mediainfo_path,
                '--Output=JSON',
                str(video_path)
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            
            # Extract video track information
            video_track = None
            for track in data.get('media', {}).get('track', []):
                if track.get('@type') == 'Video':
                    video_track = track
                    break
            
            if not video_track:
                raise ValueError("No video track found")
            
            return {
                'width': int(video_track.get('Width', 0)),
                'height': int(video_track.get('Height', 0)),
                'duration': float(video_track.get('Duration', 0)),
                'bitrate': int(video_track.get('BitRate', 0)),
                'codec': video_track.get('Format', 'unknown'),
                'frame_rate': float(video_track.get('FrameRate', 0))
            }
            
        except Exception as e:
            self.logger.error(f"Error getting video info with MediaInfo: {e}")
            return self._get_video_info_ffmpeg(video_path)
    
    def _get_video_info_ffmpeg(self, video_path: Path) -> Dict:
        """Get video information using FFmpeg."""
        try:
            cmd = [
                'ffprobe',
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                str(video_path)
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            
            # Find video stream
            video_stream = None
            for stream in data.get('streams', []):
                if stream.get('codec_type') == 'video':
                    video_stream = stream
                    break
            
            if not video_stream:
                raise ValueError("No video stream found")
            
            return {
                'width': int(video_stream.get('width', 0)),
                'height': int(video_stream.get('height', 0)),
                'duration': float(data.get('format', {}).get('duration', 0)),
                'bitrate': int(data.get('format', {}).get('bit_rate', 0)),
                'codec': video_stream.get('codec_name', 'unknown'),
                'frame_rate': self._parse_frame_rate(video_stream.get('r_frame_rate', '0/1'))
            }
            
        except Exception as e:
            self.logger.error(f"Error getting video info with FFmpeg: {e}")
            return {
                'width': 0,
                'height': 0,
                'duration': 0,
                'bitrate': 0,
                'codec': 'unknown',
                'frame_rate': 0
            }
    
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
    
    def _classify_resolution(self, width: int, height: int) -> VideoResolution:
        """Classify video resolution."""
        if width == 0 or height == 0:
            return VideoResolution.UNKNOWN
        
        # VR resolutions
        if width == 8192 and height == 4096:
            return VideoResolution.VR_8K
        elif width == 6144 and height == 3072:
            return VideoResolution.VR_6K
        elif width == 4096 and height == 2048:
            return VideoResolution.VR_4K
        elif width == 5120 and height == 2880:
            return VideoResolution.UHD_PLUS
        elif width == 3840 and height == 2160:
            return VideoResolution.UHD
        elif width == 2560 and height == 1440:
            return VideoResolution.QHD
        elif width == 1920 and height == 1080:
            return VideoResolution.FHD
        elif width == 1280 and height == 720:
            return VideoResolution.HD
        else:
            return VideoResolution.UNKNOWN
    
    def _classify_format(self, extension: str) -> VideoFormat:
        """Classify video format by extension."""
        format_map = {
            '.mp4': VideoFormat.MP4,
            '.avi': VideoFormat.AVI,
            '.mkv': VideoFormat.MKV,
            '.mov': VideoFormat.MOV,
            '.webm': VideoFormat.WEBM,
            '.m4v': VideoFormat.M4V
        }
        
        return format_map.get(extension.lower(), VideoFormat.UNKNOWN)
    
    def _classify_vr(self, width: int, height: int) -> Tuple[bool, Optional[str]]:
        """Classify if video is VR and determine VR type."""
        if width == 0 or height == 0:
            return False, None
        
        # Check for VR aspect ratios (2:1 for equirectangular)
        aspect_ratio = width / height
        
        if abs(aspect_ratio - 2.0) < 0.1:  # Equirectangular VR
            if width >= 8192:
                return True, "equirectangular_8k"
            elif width >= 6144:
                return True, "equirectangular_6k"
            elif width >= 4096:
                return True, "equirectangular_4k"
            else:
                return True, "equirectangular"
        
        return False, None
    
    def classify_directory(self, directory: Path) -> List[VideoInfo]:
        """Classify all videos in a directory.
        
        Args:
            directory: Directory containing video files
            
        Returns:
            List of VideoInfo objects
        """
        self.logger.info(f"Classifying videos in directory: {directory}")
        
        if not directory.exists():
            raise FileNotFoundError(f"Directory not found: {directory}")
        
        video_extensions = {'.mp4', '.avi', '.mkv', '.mov', '.webm', '.m4v'}
        video_files = [
            f for f in directory.iterdir()
            if f.is_file() and f.suffix.lower() in video_extensions
        ]
        
        results = []
        for video_file in video_files:
            try:
                video_info = self.classify_video(video_file)
                results.append(video_info)
            except Exception as e:
                self.logger.error(f"Error classifying {video_file}: {e}")
        
        return results
    
    def generate_classification_report(self, video_infos: List[VideoInfo]) -> Dict:
        """Generate a classification report.
        
        Args:
            video_infos: List of VideoInfo objects
            
        Returns:
            Classification report dictionary
        """
        report = {
            'total_videos': len(video_infos),
            'resolutions': {},
            'formats': {},
            'vr_videos': 0,
            'vr_types': {},
            'file_sizes': {
                'total_size': sum(v.file_size for v in video_infos),
                'average_size': sum(v.file_size for v in video_infos) / len(video_infos) if video_infos else 0
            }
        }
        
        for video_info in video_infos:
            # Count resolutions
            resolution = video_info.resolution.value
            report['resolutions'][resolution] = report['resolutions'].get(resolution, 0) + 1
            
            # Count formats
            format_type = video_info.format.value
            report['formats'][format_type] = report['formats'].get(format_type, 0) + 1
            
            # Count VR videos
            if video_info.is_vr:
                report['vr_videos'] += 1
                vr_type = video_info.vr_type or 'unknown'
                report['vr_types'][vr_type] = report['vr_types'].get(vr_type, 0) + 1
        
        return report 