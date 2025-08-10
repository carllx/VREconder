#!/usr/bin/env python3
"""
简化版HEVC编码器测试 - 专注于基本NVENC功能
"""

import subprocess
import json
import time
import os
from pathlib import Path


def get_video_info(file_path: str):
    """获取视频文件信息"""
    try:
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", file_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        video_info = json.loads(result.stdout)
        
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


def test_basic_nvenc(input_file: str, output_dir: str = "test_output"):
    """测试基本NVENC编码"""
    print("=== 测试基本NVENC编码 ===")
    
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
    
    # 创建输出目录
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # 测试不同的编码配置
    test_configs = [
        {
            "name": "basic_nvenc",
            "args": [
                "-c:v", "hevc_nvenc",
                "-preset", "p4",
                "-tune", "hq",
                "-rc", "vbr",
                "-cq", "28",
                "-profile:v", "main",
                "-pix_fmt", "yuv420p"
            ]
        },
        {
            "name": "quality_nvenc",
            "args": [
                "-c:v", "hevc_nvenc",
                "-preset", "p6",
                "-tune", "uhq",
                "-rc", "vbr",
                "-cq", "24",
                "-profile:v", "main10",
                "-pix_fmt", "p010le"
            ]
        },
        {
            "name": "hwaccel_nvenc",
            "args": [
                "-hwaccel", "cuda",
                "-hwaccel_output_format", "cuda",
                "-c:v", "hevc_nvenc",
                "-preset", "p5",
                "-tune", "hq",
                "-rc", "vbr",
                "-cq", "26",
                "-profile:v", "main10",
                "-pix_fmt", "p010le"
            ]
        }
    ]
    
    for config in test_configs:
        print(f"\n🔧 测试配置: {config['name']}")
        
        # 构建输出文件名
        input_name = Path(input_file).stem
        output_file = output_path / f"{input_name}_{config['name']}.mp4"
        
        # 构建完整命令
        cmd = ["ffmpeg", "-i", input_file] + config['args'] + [
            "-c:a", "aac",
            "-b:a", "128k",
            "-y", str(output_file)
        ]
        
        print(f"执行命令: {' '.join(cmd)}")
        
        # 记录开始时间
        start_time = time.time()
        
        try:
            # 执行编码
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            # 计算编码时间
            encoding_time = time.time() - start_time
            
            if result.returncode == 0 and os.path.exists(output_file):
                output_size = os.path.getsize(output_file) / (1024**3)
                compression_ratio = (1 - output_size / (video_info['file_size'] / (1024**3))) * 100
                
                print(f"✅ {config['name']} 编码成功")
                print(f"   编码时间: {encoding_time:.2f} 秒")
                print(f"   输出文件大小: {output_size:.2f} GB")
                print(f"   压缩比: {compression_ratio:.1f}%")
                
                # 获取输出文件信息
                output_info = get_video_info(str(output_file))
                if output_info:
                    print(f"   输出分辨率: {output_info['width']}x{output_info['height']}")
                    print(f"   输出编码: {output_info['codec']}")
            else:
                print(f"❌ {config['name']} 编码失败")
                print(f"   返回码: {result.returncode}")
                if result.stderr:
                    print(f"   错误信息: {result.stderr[:200]}...")
                
        except Exception as e:
            print(f"❌ {config['name']} 编码出错: {e}")
    
    return True


def test_system_capabilities():
    """测试系统能力"""
    print("=== 测试系统能力 ===")
    
    # 检查FFmpeg版本
    try:
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
    
    # 检查NVENC支持
    try:
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-encoders"
        ], capture_output=True, text=True)
        
        if "hevc_nvenc" in result.stdout:
            print("✅ NVENC: 支持HEVC编码")
        else:
            print("❌ NVENC: 不支持HEVC编码")
            return False
            
    except Exception as e:
        print(f"❌ NVENC: 检查失败 - {e}")
        return False
    
    # 检查CUDA支持
    try:
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-hwaccels"
        ], capture_output=True, text=True)
        
        if "cuda" in result.stdout:
            print("✅ CUDA: 支持硬件加速")
        else:
            print("⚠️  CUDA: 不支持硬件加速")
            
    except Exception as e:
        print(f"⚠️  CUDA: 检查失败 - {e}")
    
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
            print("⚠️  NVIDIA GPU: 未检测到")
    except Exception as e:
        print(f"⚠️  NVIDIA GPU: 检查失败 - {e}")
    
    return True


def main():
    """主函数"""
    print("🚀 简化版HEVC编码器测试")
    print("=" * 50)
    
    # 测试文件路径
    input_file = r"D:\Downloads\VR\04_HEVC_Conversion_Queue\8k\Minami Shiori - DSVR01596_8k.mp4"
    
    print(f"🎬 测试文件: {input_file}")
    
    # 测试系统能力
    if not test_system_capabilities():
        print("❌ 系统能力检查失败，停止测试")
        return
    
    # 测试基本NVENC编码
    test_basic_nvenc(input_file)
    
    print("\n" + "=" * 50)
    print("🎉 测试完成！")


if __name__ == "__main__":
    main() 