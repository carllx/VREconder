#!/usr/bin/env python3
"""
测试高级HEVC编码器对8K VR视频的处理能力
"""

import sys
import os
import time
import logging
from pathlib import Path
from typing import Dict, Any

# 添加项目根目录到Python路径
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from src.encoders.advanced_hevc_encoder import (
    AdvancedHEVCEncoder, 
    EncodingConfig, 
    EncoderPreset, 
    QualityTune,
    create_optimized_encoder
)
from src.utils.performance_monitor import create_performance_monitor


def setup_logging():
    """设置日志配置"""
    logging.basicConfig(
        level=logging.INFO,
        format='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s',
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler('test_advanced_encoder.log', encoding='utf-8')
        ]
    )


def get_video_info(file_path: str) -> Dict[str, Any]:
    """获取视频文件信息"""
    import subprocess
    import json
    
    try:
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", file_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        video_info = json.loads(result.stdout)
        
        # 提取视频流信息
        video_stream = next(
            (s for s in video_info['streams'] if s['codec_type'] == 'video'),
            None
        )
        
        if video_stream:
            return {
                'width': int(video_stream['width']),
                'height': int(video_stream['height']),
                'codec': video_stream.get('codec_name', 'unknown'),
                'bitrate': int(video_stream.get('bit_rate', 0)),
                'frame_rate': eval(video_stream.get('r_frame_rate', '30/1')),
                'duration': float(video_info['format'].get('duration', 0)),
                'file_size': int(video_info['format'].get('size', 0)),
                'pix_fmt': video_stream.get('pix_fmt', 'unknown')
            }
        
        return {}
        
    except Exception as e:
        print(f"获取视频信息失败: {e}")
        return {}


def test_basic_encoding(input_file: str, output_dir: str = "test_output"):
    """测试基础编码功能"""
    print("=== 测试基础编码功能 ===")
    
    # 检查输入文件
    if not os.path.exists(input_file):
        print(f"❌ 输入文件不存在: {input_file}")
        return False
    
    # 获取视频信息
    video_info = get_video_info(input_file)
    if not video_info:
        print("❌ 无法获取视频信息")
        return False
    
    print(f"📹 视频信息:")
    print(f"   分辨率: {video_info['width']}x{video_info['height']}")
    print(f"   编码格式: {video_info['codec']}")
    print(f"   帧率: {video_info['frame_rate']:.2f} fps")
    print(f"   时长: {video_info['duration']:.2f} 秒")
    print(f"   文件大小: {video_info['file_size'] / (1024**3):.2f} GB")
    print(f"   像素格式: {video_info['pix_fmt']}")
    
    # 创建输出目录
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # 测试不同质量级别
    quality_levels = ["low", "medium", "high", "ultra"]
    
    for quality in quality_levels:
        print(f"\n🔧 测试质量级别: {quality}")
        
        # 创建编码器
        encoder = create_optimized_encoder(quality_level=quality)
        
        # 构建输出文件名
        input_name = Path(input_file).stem
        output_file = output_path / f"{input_name}_test_{quality}.mp4"
        
        # 记录开始时间
        start_time = time.time()
        
        try:
            # 执行编码
            success = encoder.encode_video(input_file, str(output_file))
            
            # 计算编码时间
            encoding_time = time.time() - start_time
            
            if success and os.path.exists(output_file):
                # 获取输出文件信息
                output_info = get_video_info(str(output_file))
                output_size = os.path.getsize(output_file) / (1024**3)
                
                print(f"✅ {quality} 质量编码成功")
                print(f"   编码时间: {encoding_time:.2f} 秒")
                print(f"   输出文件大小: {output_size:.2f} GB")
                print(f"   压缩比: {(1 - output_size / (video_info['file_size'] / (1024**3))) * 100:.1f}%")
                
                if output_info:
                    print(f"   输出分辨率: {output_info['width']}x{output_info['height']}")
                    print(f"   输出编码: {output_info['codec']}")
            else:
                print(f"❌ {quality} 质量编码失败")
                
        except Exception as e:
            print(f"❌ {quality} 质量编码出错: {e}")
    
    return True


def test_gpu_acceleration(input_file: str, output_dir: str = "test_output"):
    """测试GPU加速功能"""
    print("\n=== 测试GPU加速功能 ===")
    
    if not os.path.exists(input_file):
        print(f"❌ 输入文件不存在: {input_file}")
        return False
    
    # 创建支持GPU加速的编码器
    config = EncodingConfig(
        preset=EncoderPreset.P6,
        tune=QualityTune.UHQ,
        crf=24,
        use_10bit=True,
        use_cuda_hwaccel=True,
        use_gpu_filters=True,
        enable_ai_upscale=False
    )
    
    encoder = AdvancedHEVCEncoder(config)
    
    # 构建输出文件名
    input_name = Path(input_file).stem
    output_file = Path(output_dir) / f"{input_name}_gpu_accelerated.mp4"
    
    print(f"🚀 使用GPU加速编码...")
    print(f"   输入文件: {input_file}")
    print(f"   输出文件: {output_file}")
    
    # 记录开始时间
    start_time = time.time()
    
    try:
        # 执行编码
        success = encoder.encode_video(input_file, str(output_file))
        
        # 计算编码时间
        encoding_time = time.time() - start_time
        
        if success and os.path.exists(output_file):
            output_size = os.path.getsize(output_file) / (1024**3)
            print(f"✅ GPU加速编码成功")
            print(f"   编码时间: {encoding_time:.2f} 秒")
            print(f"   输出文件大小: {output_size:.2f} GB")
        else:
            print(f"❌ GPU加速编码失败")
            
    except Exception as e:
        print(f"❌ GPU加速编码出错: {e}")
    
    return True


def test_performance_monitoring(input_file: str, output_dir: str = "test_output"):
    """测试性能监控功能"""
    print("\n=== 测试性能监控功能 ===")
    
    if not os.path.exists(input_file):
        print(f"❌ 输入文件不存在: {input_file}")
        return False
    
    # 创建性能监控器
    monitor = create_performance_monitor("test_performance.log")
    
    # 启动性能监控
    monitor.start_monitoring(interval=2.0)
    
    try:
        # 创建编码器
        encoder = create_optimized_encoder(quality_level="medium")
        
        # 构建输出文件名
        input_name = Path(input_file).stem
        output_file = Path(output_dir) / f"{input_name}_monitored.mp4"
        
        print(f"📊 开始性能监控编码...")
        
        # 记录开始时间
        start_time = time.time()
        
        # 执行编码
        success = encoder.encode_video(input_file, str(output_file))
        
        # 计算编码时间
        encoding_time = time.time() - start_time
        
        if success:
            print(f"✅ 性能监控编码成功")
            print(f"   编码时间: {encoding_time:.2f} 秒")
            
            # 获取性能摘要
            summary = monitor.get_performance_summary(duration_minutes=10)
            if summary:
                print(f"📈 性能摘要:")
                print(f"   CPU平均使用率: {summary['cpu']['average']:.1f}%")
                print(f"   内存平均使用率: {summary['memory']['average']:.1f}%")
                if 'gpu' in summary:
                    print(f"   GPU平均使用率: {summary['gpu']['average']:.1f}%")
            
            # 导出性能数据
            monitor.export_metrics("test_performance_metrics.json")
            print(f"📄 性能数据已导出到 test_performance_metrics.json")
        else:
            print(f"❌ 性能监控编码失败")
            
    except Exception as e:
        print(f"❌ 性能监控编码出错: {e}")
    finally:
        # 停止性能监控
        monitor.stop_monitoring()
    
    return True


def test_system_requirements():
    """测试系统要求"""
    print("=== 测试系统要求 ===")
    
    # 检查FFmpeg
    try:
        import subprocess
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        if result.returncode == 0:
            version_line = result.stdout.split('\n')[0]
            print(f"✅ FFmpeg: {version_line}")
        else:
            print("❌ FFmpeg: 未安装或不可用")
            return False
    except Exception as e:
        print(f"❌ FFmpeg: 检查失败 - {e}")
        return False
    
    # 检查NVIDIA GPU
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=gpu_name,compute_cap", "--format=csv,noheader"],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            gpu_info = result.stdout.strip().split('\n')[0]
            print(f"✅ NVIDIA GPU: {gpu_info}")
        else:
            print("⚠️  NVIDIA GPU: 未检测到，将使用CPU编码")
    except Exception as e:
        print(f"⚠️  NVIDIA GPU: 检查失败 - {e}")
    
    # 检查系统资源
    import psutil
    
    cpu_count = psutil.cpu_count()
    memory_gb = psutil.virtual_memory().total / (1024**3)
    
    print(f"💻 CPU核心数: {cpu_count}")
    print(f"💾 内存大小: {memory_gb:.1f} GB")
    
    if memory_gb < 16:
        print("⚠️  内存不足，建议至少16GB RAM")
    
    return True


def main():
    """主测试函数"""
    print("🚀 VR视频处理管线 - 高级编码器测试")
    print("=" * 60)
    
    # 设置日志
    setup_logging()
    
    # 测试文件路径
    input_file = r"D:\Downloads\VR\04_HEVC_Conversion_Queue\8k\Minami Shiori - DSVR01596_8k.mp4"
    
    print(f"🎬 测试文件: {input_file}")
    
    # 测试系统要求
    if not test_system_requirements():
        print("❌ 系统要求检查失败，停止测试")
        return
    
    # 测试基础编码功能
    test_basic_encoding(input_file)
    
    # 测试GPU加速功能
    test_gpu_acceleration(input_file)
    
    # 测试性能监控功能
    test_performance_monitoring(input_file)
    
    print("\n" + "=" * 60)
    print("🎉 所有测试完成！")
    print("📁 输出文件保存在 test_output 目录中")
    print("📊 性能数据保存在 test_performance_metrics.json 中")


if __name__ == "__main__":
    main() 