#!/usr/bin/env python3
"""
FFmpeg 自动检测功能演示脚本
展示如何在项目中使用新的 FFmpeg 检测器
"""
import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root / 'src'))

from config.settings import Config
from utils.ffmpeg_detector import get_ffmpeg_detection_summary
from encoders.hevc_encoder import HEVCEncoder
from processors.video_splitter import VideoSplitter

def demo_basic_detection():
    """演示基本检测功能"""
    print("🔍 FFmpeg 自动检测演示")
    print("=" * 50)
    
    # 加载配置
    config = Config()
    
    # 获取检测摘要
    summary = get_ffmpeg_detection_summary(config)
    
    print(f"系统类型: {summary['system']}")
    print(f"FFmpeg 状态: {'✓ 已找到' if summary['ffmpeg_found'] else '✗ 未找到'}")
    if summary['ffmpeg_found']:
        print(f"FFmpeg 路径: {summary['ffmpeg_path']}")
        print(f"FFprobe 状态: {'✓ 已找到' if summary['ffprobe_found'] else '✗ 未找到'}")
        if summary['ffprobe_found']:
            print(f"FFprobe 路径: {summary['ffprobe_path']}")
        print(f"版本信息: {summary['version']}")
        print(f"检测方式: {summary['detection_method']}")
    
    print()

def demo_encoder_integration():
    """演示编码器集成"""
    print("🎬 编码器集成演示")
    print("=" * 50)
    
    try:
        config = Config()
        
        # 创建 HEVC 编码器实例
        print("创建 HEVC 编码器...")
        encoder = HEVCEncoder(config)
        print(f"✓ 编码器创建成功")
        print(f"FFmpeg 路径: {encoder.ffmpeg_path}")
        print(f"可用编码器: {[e.value for e in encoder.available_encoders]}")
        
        print()
        
        # 创建视频分割器实例
        print("创建视频分割器...")
        splitter = VideoSplitter(config)
        print(f"✓ 分割器创建成功")
        print(f"FFmpeg 路径: {splitter.ffmpeg_path}")
        
    except Exception as e:
        print(f"✗ 编码器集成失败: {e}")
    
    print()

def demo_cross_platform_info():
    """演示跨平台信息"""
    print("🌍 跨平台支持信息")
    print("=" * 50)
    
    platforms = {
        'windows': [
            'C:/ffmpeg/bin/ffmpeg.exe',
            'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
            'D:/ffmpeg/bin/ffmpeg.exe'
        ],
        'macos': [
            '/usr/local/bin/ffmpeg',
            '/opt/homebrew/bin/ffmpeg',
            '/usr/local/homebrew/bin/ffmpeg'
        ],
        'linux': [
            '/usr/bin/ffmpeg',
            '/usr/local/bin/ffmpeg',
            '/snap/bin/ffmpeg'
        ]
    }
    
    for platform_name, paths in platforms.items():
        print(f"{platform_name.upper()}:")
        for path in paths:
            print(f"  - {path}")
        print()

def main():
    """主函数"""
    print("🚀 VREconder FFmpeg 自动检测功能演示")
    print("=" * 60)
    print()
    
    try:
        # 基本检测演示
        demo_basic_detection()
        
        # 编码器集成演示
        demo_encoder_integration()
        
        # 跨平台信息演示
        demo_cross_platform_info()
        
        print("✅ 演示完成！")
        print("\n💡 提示:")
        print("- 系统会自动检测 FFmpeg 路径，无需手动配置")
        print("- 支持 Windows、macOS、Linux 三大平台")
        print("- 可以通过 config/settings.yaml 自定义路径")
        print("- 支持环境变量和常见安装路径自动检测")
        
    except Exception as e:
        print(f"❌ 演示过程中发生错误: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main() 