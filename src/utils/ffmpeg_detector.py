#!/usr/bin/env python3
"""
FFmpeg Path Detector - 跨平台 FFmpeg 路径自动检测工具
支持 Windows、macOS、Linux 系统的自动路径识别
"""
import os
import sys
import subprocess
import platform
import logging
from pathlib import Path
from typing import Optional, List, Tuple
from config.settings import Config

logger = logging.getLogger(__name__)

class FFmpegDetector:
    """跨平台 FFmpeg 路径自动检测器"""
    
    def __init__(self, config: Config = None):
        self.config = config
        self.system = platform.system().lower()
        self.is_windows = self.system == "windows"
        self.is_macos = self.system == "darwin"
        self.is_linux = self.system == "linux"
        
    def detect_ffmpeg_path(self) -> str:
        """
        自动检测 FFmpeg 可执行文件路径
        
        Returns:
            FFmpeg 可执行文件的完整路径
            
        Raises:
            FileNotFoundError: 如果找不到 FFmpeg
        """
        logger.info(f"开始检测 FFmpeg 路径 (系统: {self.system})")
        
        # 1. 优先检查配置文件中的路径
        config_path = self._get_config_path()
        if config_path:
            logger.info(f"从配置文件找到 FFmpeg 路径: {config_path}")
            return config_path
        
        # 2. 检查系统 PATH 环境变量
        path_path = self._check_path_environment()
        if path_path:
            logger.info(f"从系统 PATH 找到 FFmpeg: {path_path}")
            return path_path
        
        # 3. 检查常见安装路径
        common_path = self._check_common_paths()
        if common_path:
            logger.info(f"从常见路径找到 FFmpeg: {common_path}")
            return common_path
        
        # 4. 检查包管理器安装路径
        package_path = self._check_package_manager_paths()
        if package_path:
            logger.info(f"从包管理器路径找到 FFmpeg: {package_path}")
            return package_path
        
        # 5. 检查用户自定义路径
        custom_path = self._check_custom_paths()
        if custom_path:
            logger.info(f"从自定义路径找到 FFmpeg: {custom_path}")
            return custom_path
        
        # 如果都找不到，抛出错误
        error_msg = self._generate_error_message()
        logger.error(error_msg)
        raise FileNotFoundError(error_msg)
    
    def _get_config_path(self) -> Optional[str]:
        """从配置文件获取 FFmpeg 路径"""
        if not self.config:
            return None
            
        try:
            if self.is_windows:
                path = self.config.get('paths.windows.ffmpeg_path')
            elif self.is_macos:
                path = self.config.get('paths.macos.ffmpeg_path')
            else:
                path = self.config.get('paths.linux.ffmpeg_path', self.config.get('paths.macos.ffmpeg_path'))
            
            if path:
                from utils.resolve_path import resolve_path
                resolved_path = resolve_path(path, self.config)
                if os.path.exists(resolved_path):
                    return resolved_path
        except Exception as e:
            logger.debug(f"配置文件路径解析失败: {e}")
        
        return None
    
    def _check_path_environment(self) -> Optional[str]:
        """检查系统 PATH 环境变量中的 FFmpeg"""
        try:
            # 尝试运行 ffmpeg -version
            result = subprocess.run(
                ['ffmpeg', '-version'], 
                capture_output=True, 
                text=True, 
                check=True,
                timeout=10
            )
            if result.returncode == 0:
                return 'ffmpeg'
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            pass
        
        return None
    
    def _check_common_paths(self) -> Optional[str]:
        """检查常见安装路径"""
        common_paths = self._get_common_paths()
        
        for path in common_paths:
            if os.path.exists(path):
                # 验证文件是否可执行
                if self._is_executable(path):
                    return path
        
        return None
    
    def _get_common_paths(self) -> List[str]:
        """获取系统相关的常见安装路径"""
        if self.is_windows:
            return [
                # Windows 常见路径
                'C:/ffmpeg/bin/ffmpeg.exe',
                'C:/ffmpeg-7.1.1-full_build/bin/ffmpeg.exe',
                'C:/ffmpeg-6.1-full_build/bin/ffmpeg.exe',
                'C:/ffmpeg-5.1-full_build/bin/ffmpeg.exe',
                'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
                'C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
                'D:/ffmpeg/bin/ffmpeg.exe',
                'E:/ffmpeg/bin/ffmpeg.exe',
                # 用户目录
                f'{os.path.expanduser("~")}/ffmpeg/bin/ffmpeg.exe',
                # 当前目录
                './ffmpeg/bin/ffmpeg.exe',
                './ffmpeg.exe'
            ]
        elif self.is_macos:
            return [
                # macOS 常见路径
                '/usr/local/bin/ffmpeg',
                '/usr/bin/ffmpeg',
                '/opt/homebrew/bin/ffmpeg',  # Apple Silicon Homebrew
                '/usr/local/homebrew/bin/ffmpeg',  # Intel Homebrew
                '/opt/local/bin/ffmpeg',  # MacPorts
                # 用户目录
                f'{os.path.expanduser("~")}/homebrew/bin/ffmpeg',
                f'{os.path.expanduser("~")}/opt/homebrew/bin/ffmpeg',
                # 应用程序包
                '/Applications/ffmpeg.app/Contents/MacOS/ffmpeg'
            ]
        else:  # Linux
            return [
                # Linux 常见路径
                '/usr/local/bin/ffmpeg',
                '/usr/bin/ffmpeg',
                '/opt/ffmpeg/bin/ffmpeg',
                '/snap/bin/ffmpeg',  # Snap 包
                # 用户目录
                f'{os.path.expanduser("~")}/.local/bin/ffmpeg',
                f'{os.path.expanduser("~")}/bin/ffmpeg',
                # 当前目录
                './ffmpeg'
            ]
    
    def _check_package_manager_paths(self) -> Optional[str]:
        """检查包管理器安装路径"""
        if self.is_macos:
            # 检查 Homebrew 安装
            homebrew_paths = [
                '/opt/homebrew/bin/ffmpeg',
                '/usr/local/homebrew/bin/ffmpeg'
            ]
            for path in homebrew_paths:
                if os.path.exists(path) and self._is_executable(path):
                    return path
        
        elif self.is_linux:
            # 检查 Snap 包
            snap_path = '/snap/bin/ffmpeg'
            if os.path.exists(snap_path) and self._is_executable(snap_path):
                return snap_path
            
            # 检查 Flatpak
            flatpak_path = '/var/lib/flatpak/exports/bin/ffmpeg'
            if os.path.exists(flatpak_path) and self._is_executable(flatpak_path):
                return flatpak_path
        
        return None
    
    def _check_custom_paths(self) -> Optional[str]:
        """检查用户自定义路径"""
        # 检查环境变量
        custom_paths = []
        
        # 从环境变量获取
        for env_var in ['FFMPEG_PATH', 'FFMPEG_HOME', 'FFMPEG_BIN']:
            if env_var in os.environ:
                path = os.environ[env_var]
                if self.is_windows and not path.endswith('.exe'):
                    path = os.path.join(path, 'ffmpeg.exe')
                elif not self.is_windows:
                    path = os.path.join(path, 'ffmpeg')
                
                if os.path.exists(path) and self._is_executable(path):
                    custom_paths.append(path)
        
        # 检查项目根目录
        try:
            project_root = Path(__file__).resolve().parent.parent.parent
            project_ffmpeg = project_root / 'ffmpeg' / 'bin' / ('ffmpeg.exe' if self.is_windows else 'ffmpeg')
            if project_ffmpeg.exists() and self._is_executable(str(project_ffmpeg)):
                custom_paths.append(str(project_ffmpeg))
        except Exception:
            pass
        
        # 返回第一个有效的自定义路径
        return custom_paths[0] if custom_paths else None
    
    def _is_executable(self, path: str) -> bool:
        """检查文件是否可执行"""
        try:
            if self.is_windows:
                # Windows 下检查文件是否存在且可读
                return os.path.isfile(path) and os.access(path, os.R_OK)
            else:
                # Unix 系统下检查文件是否可执行
                return os.path.isfile(path) and os.access(path, os.X_OK)
        except Exception:
            return False
    
    def _generate_error_message(self) -> str:
        """生成详细的错误信息"""
        if self.is_windows:
            return (
                "FFmpeg 未找到！请按以下步骤安装：\n"
                "1. 下载 FFmpeg: https://ffmpeg.org/download.html\n"
                "2. 解压到 C:/ffmpeg/ 目录\n"
                "3. 将 C:/ffmpeg/bin/ 添加到系统 PATH 环境变量\n"
                "4. 或在 config/settings.yaml 中指定 ffmpeg_path"
            )
        elif self.is_macos:
            return (
                "FFmpeg 未找到！请按以下步骤安装：\n"
                "1. 使用 Homebrew: brew install ffmpeg\n"
                "2. 或使用 MacPorts: sudo port install ffmpeg\n"
                "3. 或在 config/settings.yaml 中指定 ffmpeg_path"
            )
        else:  # Linux
            return (
                "FFmpeg 未找到！请按以下步骤安装：\n"
                "1. Ubuntu/Debian: sudo apt install ffmpeg\n"
                "2. CentOS/RHEL: sudo yum install ffmpeg\n"
                "3. 或使用 Snap: sudo snap install ffmpeg\n"
                "4. 或在 config/settings.yaml 中指定 ffmpeg_path"
            )
    
    def detect_ffprobe_path(self) -> str:
        """检测 ffprobe 路径"""
        ffmpeg_path = self.detect_ffmpeg_path()
        
        if ffmpeg_path == 'ffmpeg':
            # 如果在 PATH 中，ffprobe 也应该在 PATH 中
            return 'ffprobe'
        
        # 替换 ffmpeg 为 ffprobe
        if self.is_windows:
            ffprobe_path = ffmpeg_path.replace('ffmpeg.exe', 'ffprobe.exe')
        else:
            ffprobe_path = ffmpeg_path.replace('ffmpeg', 'ffprobe')
        
        if os.path.exists(ffprobe_path):
            return ffprobe_path
        
        # 如果找不到 ffprobe，尝试在 PATH 中查找
        try:
            result = subprocess.run(['ffprobe', '-version'], 
                                  capture_output=True, text=True, check=True, timeout=10)
            if result.returncode == 0:
                return 'ffprobe'
        except:
            pass
        
        raise FileNotFoundError(f"FFprobe 未找到，FFmpeg 路径: {ffmpeg_path}")
    
    def test_ffmpeg_installation(self) -> Tuple[bool, str]:
        """
        测试 FFmpeg 安装是否可用
        
        Returns:
            (是否可用, 版本信息或错误信息)
        """
        try:
            ffmpeg_path = self.detect_ffmpeg_path()
            result = subprocess.run(
                [ffmpeg_path, '-version'], 
                capture_output=True, 
                text=True, 
                check=True,
                timeout=10
            )
            
            if result.returncode == 0:
                # 提取版本信息
                version_line = result.stdout.split('\n')[0]
                return True, version_line
            else:
                return False, f"FFmpeg 执行失败，返回码: {result.returncode}"
                
        except Exception as e:
            return False, f"FFmpeg 测试失败: {str(e)}"
    
    def get_detection_summary(self) -> dict:
        """获取检测结果摘要"""
        summary = {
            'system': self.system,
            'ffmpeg_found': False,
            'ffmpeg_path': None,
            'ffprobe_found': False,
            'ffprobe_path': None,
            'version': None,
            'config_path': None,
            'detection_method': None
        }
        
        try:
            # 检测 FFmpeg
            ffmpeg_path = self.detect_ffmpeg_path()
            summary['ffmpeg_found'] = True
            summary['ffmpeg_path'] = ffmpeg_path
            
            # 检测 FFprobe
            try:
                ffprobe_path = self.detect_ffprobe_path()
                summary['ffprobe_found'] = True
                summary['ffprobe_path'] = ffprobe_path
            except:
                pass
            
            # 测试安装
            is_working, version_info = self.test_ffmpeg_installation()
            if is_working:
                summary['version'] = version_info
            
            # 确定检测方法
            if self._get_config_path():
                summary['detection_method'] = 'config_file'
            elif self._check_path_environment():
                summary['detection_method'] = 'system_path'
            elif self._check_common_paths():
                summary['detection_method'] = 'common_paths'
            elif self._check_package_manager_paths():
                summary['detection_method'] = 'package_manager'
            elif self._check_custom_paths():
                summary['detection_method'] = 'custom_paths'
                
        except Exception as e:
            summary['error'] = str(e)
        
        return summary


# 便捷函数
def detect_ffmpeg_path(config: Config = None) -> str:
    """便捷函数：检测 FFmpeg 路径"""
    detector = FFmpegDetector(config)
    return detector.detect_ffmpeg_path()


def detect_ffprobe_path(config: Config = None) -> str:
    """便捷函数：检测 FFprobe 路径"""
    detector = FFmpegDetector(config)
    return detector.detect_ffprobe_path()


def test_ffmpeg_installation(config: Config = None) -> Tuple[bool, str]:
    """便捷函数：测试 FFmpeg 安装"""
    detector = FFmpegDetector(config)
    return detector.test_ffmpeg_installation()


def get_ffmpeg_detection_summary(config: Config = None) -> dict:
    """便捷函数：获取检测摘要"""
    detector = FFmpegDetector(config)
    return detector.get_detection_summary() 